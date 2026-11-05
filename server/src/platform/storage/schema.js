/**
 * 表结构与版本迁移：user_version 记录演进到的版本，迁移逐级执行；建表一律 IF NOT EXISTS，
 * 对历史库（user_version=0 但表已在）幂等。加表加列只走下面的 MIGRATIONS，别处写 ALTER 都是野路子。
 */
/**
 * v1 基线：一次 exec 建齐全部业务表。建表串里不能写注释（-- 会被 SQLite 吃掉后续语句，且既有文本已冻结），
 * 所以不显然的列口径记在这里，这是唯一的列文档，改列时同步。
 * authorizations：allowed_hosts 存文本、读侧还原成数组，匹配口径与门禁共用 hostMatches()；
 *   start_at/end_at 存 ISO，不可解析要判无效而不是永久有效；status 只是登记态，能不能用现算（security/mandate.js）。
 * web_sites.status 是运维意图不是进程实况（真实在听问 siteRegistry.isRunning()）；
 *   listen_ip 默认 0.0.0.0=全网卡，收成 127.0.0.1 才本机专用；tls_key 是私钥只进库，不进响应与审计；
 *   close_reason（v4）：authorization=强制下线可续期复服，manual=主动收网不许掀开。
 * smtp_profiles.pass 明文入库（本机 data 目录可信）但所有出口掩码；mail_tasks 的 dry_run=1 沙箱、0 真发信，翻转留审计。
 * mail_recipients 的 sandboxed 与 sent 分开（落盘与真寄出是两件事）；opened_at/clicked_at/submitted_at 由信标面回写且只记首次。
 * records.kind 只有 web/mail，证据页分组与导出筛选都以它为准；form_json 含明文凭据，只进库绝不复制到响应/审计/推送。
 * sessions.expires_at 是全库唯一 INTEGER 毫秒时间列，其余存 ISO 文本。
 * push_logs.request 落库前已掩码机器人令牌，可原样给前端展示，与 audit_logs（记操作员动作）分职。
 */
const BASELINE = `
CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  contact TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL,
  pledge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  html TEXT NOT NULL,
  response_type TEXT NOT NULL DEFAULT 'alert',
  response_content TEXT,
  learn_page_id TEXT,
  check_onclick TEXT,
  check_external TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT,
  body_html TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learn_pages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS web_sites (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  listen_ip TEXT NOT NULL DEFAULT '0.0.0.0',
  listen_port INTEGER NOT NULL,
  domain TEXT,
  tls_key TEXT,
  tls_cert TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (listen_ip, listen_port)
);

CREATE TABLE IF NOT EXISTS smtp_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  secure INTEGER NOT NULL DEFAULT 0,
  user TEXT NOT NULL,
  pass TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mail_template_id TEXT,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  attachment_name TEXT,
  attachment_path TEXT,
  smtp_profile_id TEXT,
  sender TEXT,
  send_interval_ms INTEGER NOT NULL DEFAULT 3000,
  dry_run INTEGER NOT NULL DEFAULT 1,
  authorization_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_recipients (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, token)
);

CREATE TABLE IF NOT EXISTS capture_tokens (
  token TEXT PRIMARY KEY,
  site_id TEXT,
  task_id TEXT,
  target_email TEXT,
  target_name TEXT,
  created_at TEXT NOT NULL,
  first_seen_at TEXT,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  site_id TEXT,
  task_id TEXT,
  token TEXT,
  target_email TEXT,
  first_seen_at TEXT,
  submitted_at TEXT,
  last_seen_at TEXT,
  dwell_seconds INTEGER,
  form_json TEXT,
  feature_json TEXT,
  screenshot_path TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_kind ON records (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_records_site ON records (site_id);
CREATE INDEX IF NOT EXISTS idx_records_task ON records (task_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT,
  token TEXT,
  ip TEXT,
  user_agent TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_logs (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  request TEXT,
  response TEXT,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * 给 web_templates 追加诊断留痕列 diagnose_json，列表页据此显示体检结论、不逐条重检。
 * 只加一个可空列，既有列不动；老库可能已带列，先查表结构再决定执行。
 */
// ALTER 真失败就上抛，由 applySchema 冒泡到启动流程：结构没到位不该开始服务
function addTemplateDiagnoseColumn(db) {
  // 先查列在不在：老库可能已跑过同版本 ALTER，重复执行会抛 duplicate column 让服务起不来
  const columns = db.prepare('PRAGMA table_info(web_templates)').all();
  if (columns.some((column) => column.name === 'diagnose_json')) return;
  // 新列可空：老行读出来按未体检显示，旧数据不必回填
  db.exec('ALTER TABLE web_templates ADD COLUMN diagnose_json TEXT');
}

/**
 * 操作审计表：记操作员动过什么（与记外发的 push_logs 分职），是授权方追责时唯一的自证材料，只增不删。
 */
// v3 迁移：操作审计表。列口径：actor 可为 NULL（无请求上下文的动作也留痕，故意不写 "system" 是为了
//   区分人点的和不是人点的）；action 用 名词.动词 小写，改名要同步前端字典；detail 是差异快照 JSON，
//   写侧截到 4000 字符、截断后非法 JSON 读侧要容错；ip 是 clientIp 结果受 trust_proxy 影响。
// 本表只 INSERT，全仓无 UPDATE/DELETE；detail 里不许出现口令、SMTP 密码、机器人密钥、完整令牌。
const AUDIT = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs (action, created_at);
`;

/**
 * 给 web_sites 加 close_reason，分清主动收网与授权出窗口强制下线；只有后者续期能自动复服。
 * 老库可能已带列，先查表结构再决定执行。
 */
// 取值口径：authorization=平台强制下线（续期后 siteRegistry.reopenSitesOfAuthorization 自动复服）、
//   manual=操作员主动收网（谁续期都不许掀开）、NULL=从未因此下线或开站时清回 NULL
function addSiteCloseReasonColumn(db) {
  // 先查列在不在：旧库可能已跑过一次，重复 ALTER 会让服务起不来
  const columns = db.prepare('PRAGMA table_info(web_sites)').all();
  if (columns.some((column) => column.name === 'close_reason')) return;
  // 只 ALTER 不 UPDATE 老行：把已 closed 的猜成 manual/authorization 会改变既有数据语义；老行留 NULL 即原因未知，宁可不复服
  db.exec('ALTER TABLE web_sites ADD COLUMN close_reason TEXT');
}

/**
 * 给 sessions 补 ip / user_agent 两列，记录会话来源、改口令时判断吊销哪些；都是可空文本，历史行为 NULL。
 */
function addSessionTraceColumns(db) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  const missing = (name) => !columns.some((column) => column.name === name);
  // 两列分开判定：只加成功一列的库不该被第二条 ALTER 撞死
  if (missing('ip')) db.exec('ALTER TABLE sessions ADD COLUMN ip TEXT');
  if (missing('user_agent')) db.exec('ALTER TABLE sessions ADD COLUMN user_agent TEXT');
}

/**
 * 登录失败计数落库：内存计数重启即清零会给撞库留重启窗口。按来源 IP 一行，登录成功归零。
 */
// 列口径：client_ip 主键，取 clientIp() 与 session.js 限流键同源；fails 连续失败数，登录成功即 DELETE 该行
//   （不留曾经失败的污点计数）；window_started_at 本轮起点，窗口滑过按过期重算；last_at 最后一次失败。
// 本表只存 IP 与计数，绝不存尝试过的用户名或口令。
const LOGIN_FAILURES = `
CREATE TABLE IF NOT EXISTS login_failures (
  client_ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  window_started_at TEXT,
  last_at TEXT
);
`;

/**
 * 给 records 加 disposition（new/contacted/educated/closed），note 答不出是不是都教育过了。
 * 新列可空，历史行留 NULL 由读侧显示未处置；不回填是刻意的，把老记录猜成 new 会凭空造出教育覆盖率分母。
 */
function addRecordDispositionColumn(db) {
  const columns = db.prepare('PRAGMA table_info(records)').all();
  // 加列与建索引分开判定：只加过列、没建过索引的库也要被这次迁移补齐
  if (!columns.some((column) => column.name === 'disposition')) {
    db.exec('ALTER TABLE records ADD COLUMN disposition TEXT');
  }
  // 覆盖率是按处置状态数人数的查询，随演练规模线性变慢；建索引换界面一次点击
  db.exec('CREATE INDEX IF NOT EXISTS idx_records_disposition ON records (disposition)');
}

/**
 * 给素材、邮件任务与学习页补"内置来源"和"目标站点"三处关联。
 * builtin_key 非空表示这一行由平台内置模板种下，前端据此打标、模板库据此恢复原样；
 * mail_tasks.site_id 把一封邮件钉到某个仿冒站，邮件里的像素、{{site_url}} 与跳转链接才落在站点端口而不是管理端。
 * 四列都可空：老库既有素材照常使用，没绑定站点的老任务回退到管理端地址。
 */
function addLibraryColumns(db) {
  // 每列单独探测：允许历史库只成功加过其中一部分，重复 ALTER 会让启动直接失败
  const addColumn = (table, column, ddl) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('mail_tasks', 'site_id', 'site_id TEXT');
  addColumn('web_templates', 'builtin_key', 'builtin_key TEXT');
  addColumn('mail_templates', 'builtin_key', 'builtin_key TEXT');
  addColumn('learn_pages', 'builtin_key', 'builtin_key TEXT');
}

// v8：账号体系与短信认证。users 是唯一身份源（管理端与普通用户同表，role 区分），sessions 补 user_id/role；
// sms_send_log 记每次发码，既做频控也做供应商对账。口令只存 scrypt 哈希，手机号明文存（要发给短信网关）。
const USERS_AND_SMS = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  phone TEXT,
  phone_verified_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE TABLE IF NOT EXISTS sms_send_log (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL,
  user_id TEXT,
  client_ip TEXT,
  provider_request_id TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_log_phone ON sms_send_log(phone, created_at);
`;

function addUsersAndSms(db) {
  db.exec(USERS_AND_SMS);
  const addColumn = (table, column, ddl) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  // 老会话行这两列为 NULL：requireSession 遇到 NULL 时按「无身份」处理，强制重登一次即可回填
  addColumn('sessions', 'user_id', 'user_id TEXT');
  addColumn('sessions', 'role', 'role TEXT');
}

// 迁移清单：数组顺序即执行顺序，version 严格递增且永不改历史条目。up 是字符串就直接 exec，是函数就先查表结构（加列专用）。
// 加迁移只在尾部 push version=上一项+1；改已发布条目的 SQL 会让老库错位。
const MIGRATIONS = [
  // v1：一次 exec 建齐全部表；user_version=0 但表已在的历史库靠 IF NOT EXISTS 同样安全
  { version: 1, label: '基线表结构', up: BASELINE },
  // v2：给 web_templates 加诊断留痕列，走函数先探表结构
  { version: 2, label: '模板诊断留痕', up: addTemplateDiagnoseColumn },
  // v3：操作审计表，追责时唯一自证材料，只 INSERT
  { version: 3, label: '操作审计表', up: AUDIT },
  // v4：给 web_sites 加 close_reason，分清强制下线与主动收网，续期复服只认前者
  { version: 4, label: '站点下线原因', up: addSiteCloseReasonColumn },
  // v5：sessions 补来源两列，登录失败计数落 DB（内存计数重启即清零，给撞库留重启窗口）
  { version: 5, label: '会话来源与登录失败落库', up: (db) => { addSessionTraceColumns(db); db.exec(LOGIN_FAILURES); } },
  // v6：records 加 disposition，历史行留 NULL=未处置
  { version: 6, label: '上钩记录处置状态', up: addRecordDispositionColumn },
  // v7：内置模板来源标记 + 邮件任务绑定仿冒站，修掉邮件链接落到管理端端口的问题
  { version: 7, label: '内置模板与邮件站点绑定', up: addLibraryColumns },
  // v8：账号体系（管理员/普通用户）与短信验证码登录，sessions 记 user_id/role，发码流水落 sms_send_log
  { version: 8, label: '账号体系与短信认证', up: addUsersAndSms },
];

// 最新结构版本 = 迁移数组最后一项，启动横幅与自检比对的就是它；别手写成常量
const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 读出库当前演进到第几级（user_version），读不到给 0 让 applySchema 从 v1 建起。
 * 只反映跑到第几级，不反映表是否真存在；手工乱改会让迁移跳步或重跑。
 */
export function schemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/** 逐级补齐落后于当前代码的库结构，已到位的版本直接跳过 */
// 返回 from/to，from===to 表示这次没动结构；每级执行会打一行 [storage] 表结构迁移至 vN
// 任何一级 SQL 抛错就原样上抛让启动终止：结构半到位比起不来更危险
export function applySchema(db) {
  const from = schemaVersion(db);
  for (const step of MIGRATIONS) {
    // 已跑过的级别跳过，所以每次启动调 applySchema 不会重复建表/加列
    if (step.version <= from) continue;
    if (typeof step.up === 'function') step.up(db);
    else db.exec(step.up);
    db.exec(`PRAGMA user_version = ${step.version}`);
    console.log(`[storage] 表结构迁移至 v${step.version}（${step.label}）`);
  }
  return { from, to: CURRENT_VERSION };
}

export { CURRENT_VERSION as schemaVersionHead };

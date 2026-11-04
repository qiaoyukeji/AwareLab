/**
 * 表结构与版本迁移。
 *
 * user_version 记录库结构演进到的版本号，迁移按版本递增逐级执行；
 * 建表语句一律 IF NOT EXISTS，保证对历史遗留库（user_version=0 但表已在）幂等。
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
 * 采集协议 v2 的诊断结论需要留在模板行上，列表页才能不逐条重新体检。
 * 只对 web_templates 追加一个可空列，既有列名与语义都不动；
 * 老库可能已经带着这一列（重复执行 ALTER 会报错），所以先查表结构再决定是否执行。
 */
function addTemplateDiagnoseColumn(db) {
  const columns = db.prepare('PRAGMA table_info(web_templates)').all();
  if (columns.some((column) => column.name === 'diagnose_json')) return;
  db.exec('ALTER TABLE web_templates ADD COLUMN diagnose_json TEXT');
}

/**
 * 操作审计：平台一直记得住员工哪一次上了钩，却记不下操作员自己动过什么。
 * 授权方追问「谁在什么时候把沙箱关掉真发了邮件、谁导走了哪批证据」时，
 * 这张表是唯一的自证材料，因此只增不改不删，与 push_logs（外发通知日志）分职。
 */
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

const MIGRATIONS = [
  { version: 1, label: '基线表结构', up: BASELINE },
  { version: 2, label: '模板诊断留痕', up: addTemplateDiagnoseColumn },
  { version: 3, label: '操作审计表', up: AUDIT },
];

const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export function schemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/** 逐级补齐落后于当前代码的库结构，已到位的版本直接跳过 */
export function applySchema(db) {
  const from = schemaVersion(db);
  for (const step of MIGRATIONS) {
    if (step.version <= from) continue;
    if (typeof step.up === 'function') step.up(db);
    else db.exec(step.up);
    db.exec(`PRAGMA user_version = ${step.version}`);
    console.log(`[storage] 表结构迁移至 v${step.version}（${step.label}）`);
  }
  return { from, to: CURRENT_VERSION };
}

export { CURRENT_VERSION as schemaVersionHead };

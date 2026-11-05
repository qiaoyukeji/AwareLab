/**
 * 运行配置的唯一来源：读/生成/写回 config.yaml，导出全局 config 与目录路径。import 时就有副作用（建目录、可能写配置），不要延迟到用时再加载。
 * config.yaml 里有后台随机路径与管理员口令，永不提交、也不抄进日志审计响应；配置是浅合并，每个二级块整体替换，只写块里一个键会丢掉同块其余默认值。
 * 只在启动时读一次、没有热加载，改完 config.yaml 要重启才生效；安全相关的缺省一律宁紧勿松，放宽必须是操作员显式写配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

// server 根目录（本文件在 server/src/platform/ 下，往上两级）
const ROOT = path.resolve(import.meta.dirname, '..', '..');

// 数据目录可整体外置：采集到的凭据落盘位置要由部署者显式控制，也让隔离验证在副本上跑完整链路不碰生产数据
// AWARELAB_DATA / AWARELAB_CONFIG 是给隔离验证用的钩子（selftest 靠它整套指向副本），日常部署不设就落在 server/data 与 server/config.yaml
const DATA_DIR = process.env.AWARELAB_DATA ? path.resolve(process.env.AWARELAB_DATA) : path.join(ROOT, 'data');
const CONFIG_FILE = process.env.AWARELAB_CONFIG ? path.resolve(process.env.AWARELAB_CONFIG) : path.join(ROOT, 'config.yaml');

// 口令/用户名字符表：32 个字符，去掉易混淆的 l/o/0/1，因为账号口令要人手抄进登录框
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * 生成长度为 len 的随机串（用户名与初始口令都用它）：用 crypto.randomBytes 而非 Math.random，这是访问凭据必须密码学随机。
 * 表长 32 整除 256 取模无偏置；8 个字符约 40 bit，配合默认只听本机 + 登录锁定够用，bind 放开到公网就是短板。
 */
function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// 缺省值即最紧的一档：安全相关的默认值放宽只能由操作员在 config.yaml 里显式写，代码不做静默兜底
const DEFAULTS = {
  panel: {
    // 后台路径随机化：固定路径等于把入口暴露给扫描器；16 字节随机、只在首次生成时产生之后沿用文件值，否则收藏的后台地址每次重启都变。它是挡扫描器的门槛，不是鉴权
    path: crypto.randomBytes(16).toString('hex'),
    // 管理面与信标面共用的进程端口；前端 dev server 用 /api 代理指到这里
    port: 7778,
    // 管理面默认只听本机：随机路径不是鉴权，同网段撞库成功就能拿走全部演练数据；要远程访问在 config.yaml 显式写 bind
    bind: '127.0.0.1',
    // 首次启动随机生成、明文落在 config.yaml（所以那文件绝不能提交）；登录是全等比较不做 hash，这两个值等于口令本体
    username: randomString(8),
    password: randomString(8),
    // 后台口令最近一次被改的时间（ISO）；null 表示从未改过仍是首次生成的随机口令。由 session.js 的 changePassword 写入，是判断还在用出厂口令的唯一依据，只比时间戳不存口令历史值
    password_updated_at: null,
    // 来源 IP 白名单：空数组不启用只靠口令与会话；非空时名单外来源一律 404 而不是 403，让不在名单里和路径不存在在响应上无法区分
    // 管理面默认只听 127.0.0.1，此时列别的地址只会把自己锁在门外
    allow_ips: [],
    // 只有确实挂在反向代理后面才置 true：否则任何人能用一行 X-Forwarded-For 换掉来源身份、绕过登录锁定并伪造取证 IP；默认 false 是修复本体，别删
    trust_proxy: false,
  },
  capture: {
    // 采集面允许绑定的端口区间 8000-9999：避开特权端口和常见服务端口，也方便防火墙按范围开口
    // 执行点在 capture/siteRegistry.js 的 portError()：建站与改站填的端口越界就报错
    port_range: [8000, 9999],
    // 采集面默认绑所有网卡：仿冒页要给演练对象访问，只听 127.0.0.1 就没人上钩；与 panel.bind 默认相反是有意为之，缺省 listen_ip 也跟随本值
    bind_host: '0.0.0.0',
    // 附件回调是公开无鉴权入口，文件与频率的闸门只能在这一层设；六个阈值的执行点在 channels/beaconPlane.js 的 LIMITS
    callback: {
      max_file_mb: 5,
      max_files_per_request: 3,
      max_fields: 40,
      per_token_per_minute: 10,
      per_ip_per_minute: 200,
      // data/screenshots 整个目录的总量上限（不是单次请求上限）：截图是撑爆磁盘的主因
      screenshot_quota_mb: 512,
    },
  },
  mail: {
    // 沙箱优先：true 时任务只渲染与记账不真实投递；默认开着，真发信要操作员显式关沙箱，免得误点把邮件投到真实邮箱
    default_dry_run: true,
    // 逐封间隔 3 秒：给 SMTP 与免费邮箱的频控留余量，也避免一次性打出去像群发脚本
    default_send_interval_ms: 3000,
  },
  exercise: {
    // 未登记有效授权时采集与发信一律拒绝工作；mandate.js 的 assertDeployment() 读这一项，关掉它等于没授权也能建钓鱼站，只该在隔离测试实例上关
    require_authorization: true,
    // 演练数据保留天数：records、events、附件/截图/outbox 产物、push_logs 超期由 platform/maintenance.js 每日清理（audit_logs 走下面更长的独立保留期）
    // 默认 180 天够结案加复核又不让明文口令无限期躺着；0/负数是不清理的退路，清理本身写一条 data.prune 审计
    retention_days: 180,
    // 审计保留期独立且更长（默认 365 天）：审计是谁动过什么的自证材料，复核窗口不该比数据留存还短；清理审计行本身也写一条 data.prune 审计，删掉的条数留痕不做静默抹除
    audit_retention_days: 365,
  },
  // 会话有效期 12 小时：够一个工作日又不会跨天还挂着（requireSession 不做续期）；写成不可解析文本会得到 NaN 反而永不过期，详见 session.js
  session_ttl_hours: 12,
};

// 目录先建再读：数据目录与四个落盘子目录要在导入阶段就位，否则上传与写文件会撞 ENOENT；mkdirSync 带 recursive，重复启动幂等
fs.mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['uploads', 'screenshots', 'attachments', 'outbox']) {
  fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
}

// created 记下这份配置是本次启动新生成的，boot/main.js 据此打印一次文件路径提醒操作员口令在哪；第二次启动就是 false 不再提示
let created = false;
if (!fs.existsSync(CONFIG_FILE)) {
  // 首启动落盘：随机后台路径与随机口令只有写进文件才可能被操作员拿到，也保证重启后入口不变；这是把凭据写进磁盘，所以 config.yaml 必须在 .gitignore 里
  fs.writeFileSync(CONFIG_FILE, yaml.dump(DEFAULTS), 'utf8');
  created = true;
}

// 合并顺序：文件值覆盖缺省值，缺省值兜住没写的项，删掉配置项不会报错只退回默认；这是一层合并，每个二级块整体替换（见文件头）
const loaded = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
const config = { ...DEFAULTS, ...loaded };
// 下面 4 行逐块再合一次：即使只写了 panel 里一个键，其余字段也仍有默认值，不会因为写了兄弟键就变 undefined
config.panel = { ...DEFAULTS.panel, ...loaded.panel };
config.capture = { ...DEFAULTS.capture, ...loaded.capture };
config.mail = { ...DEFAULTS.mail, ...loaded.mail };
config.exercise = { ...DEFAULTS.exercise, ...loaded.exercise };
// 路径集中在 config.paths 对外发，别处不再各自拼相对路径：相对 process.cwd() 拼路径会让从哪个目录启动改变数据落点
config.paths = {
  root: ROOT,
  data: DATA_DIR,
  uploads: path.join(DATA_DIR, 'uploads'),
  screenshots: path.join(DATA_DIR, 'screenshots'),
  attachments: path.join(DATA_DIR, 'attachments'),
  outbox: path.join(DATA_DIR, 'outbox'),
  // 采集到的凭据与证据全在这个库里，所在目录由 AWARELAB_DATA 决定，隔离测试靠把这一项指到副本目录实现
  db: path.join(DATA_DIR, 'awarelab.db'),
  // 前端构建产物目录（仓库根 web/dist，不在 server/ 下）：adminPlane.js 挂载时读一次这里的 index.html，所以 vite build 后必须重启后端
  webDist: path.resolve(ROOT, '..', 'web', 'dist'),
};

/**
 * 把某个二级块的一个键写回 config.yaml 并同步内存 config（改口令走这里）。失败直接抛由调用方回 500，静默失败会让操作员以为改好、重启又变回旧值。
 * 优先只替换那一行、保留缩进与操作员注释而非整体 dump 回去；先探测文件主流行尾（源码 CRLF、yaml.dump 是 LF）再拼回避免整个文件重排，值含 : # 交给 yaml.dump 加引号，内存 config 必须同步改否则本次进程仍拿旧口令比对。
 */
function persistConfigValue(section, key, value) {
  const text = fs.readFileSync(CONFIG_FILE, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // 渲染成 "key: value" 一行（yaml.dump 负责引号与转义），随后按原缩进塞回去
  const rendered = yaml.dump({ [key]: value }).replace(/\r?\n$/, '');

  const sectionAt = lines.findIndex((line) => new RegExp(`^${section}:\\s*(#.*)?$`).test(line));
  if (sectionAt >= 0) {
    // 块范围从块名下一行起，到第一个非缩进且非空的行为止
    let end = lines.length;
    for (let i = sectionAt + 1; i < lines.length; i++) {
      if (lines[i].trim() && !/^[\s#]/.test(lines[i])) { end = i; break; }
    }
    const keyRe = new RegExp(`^(\\s+)${key}:\\s.*$`);
    for (let i = sectionAt + 1; i < end; i++) {
      const hit = lines[i].match(keyRe);
      if (hit) {
        // 保留原缩进；旧行尾注释丢弃，值都换了旧注释多半已失效
        lines[i] = `${hit[1]}${rendered}`;
        fs.writeFileSync(CONFIG_FILE, lines.join(eol), 'utf8');
        config[section] = { ...config[section], [key]: value };
        return;
      }
    }
    // 块在但键不在（老配置文件）：插到块末尾，缩进跟块内第一行对齐
    const indent = (lines.slice(sectionAt + 1, end).find((l) => l.trim()) || '  x').match(/^\s*/)[0] || '  ';
    lines.splice(end, 0, `${indent}${rendered}`);
    fs.writeFileSync(CONFIG_FILE, lines.join(eol), 'utf8');
    config[section] = { ...config[section], [key]: value };
    return;
  }

  // 连块都没有：按文件现有内容合并后整体重写（这种文件本来就是机器生成的，没有注释可丢）
  const raw = yaml.load(text) || {};
  raw[section] = { ...(raw[section] || {}), [key]: value };
  fs.writeFileSync(CONFIG_FILE, yaml.dump(raw), 'utf8');
  config[section] = { ...config[section], [key]: value };
}

// 对外出口里 config 是内存副本，直接改不会写回文件，落盘只走 persistConfigValue（目前仅改后台口令用它）。randomString 一并导出是为了同一种随机度和同一张字符表只有一处定义；专属链接令牌走 crypto.randomUUID 不经过这里。
export { config, created, CONFIG_FILE, randomString, persistConfigValue };

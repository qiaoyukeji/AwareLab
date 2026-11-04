import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

// 数据目录可整体外置：演练采集到的凭据落盘位置必须由部署者显式控制，
// 同时让自动化验证能在隔离副本上跑完整链路而不触碰生产数据。
const DATA_DIR = process.env.AWARELAB_DATA ? path.resolve(process.env.AWARELAB_DATA) : path.join(ROOT, 'data');
const CONFIG_FILE = process.env.AWARELAB_CONFIG ? path.resolve(process.env.AWARELAB_CONFIG) : path.join(ROOT, 'config.yaml');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomString(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const DEFAULTS = {
  panel: {
    // 后台路径随机化：管理面与信标面同端口部署，固定路径等于把入口暴露给扫描器
    path: crypto.randomBytes(16).toString('hex'),
    port: 7778,
    // 管理面默认只听本机：随机路径不是鉴权，同网段的人撞库成功就能拿走全部演练数据。
    // 需要远程访问时在 config.yaml 显式写 bind，启动横幅会就此提示一次。
    bind: '127.0.0.1',
    username: randomString(8),
    password: randomString(8),
  },
  capture: {
    // 采集面允许绑定的端口区间，避免误占用系统端口
    port_range: [8000, 9999],
    bind_host: '0.0.0.0',
    // 附件运行回调是公开无鉴权入口，文件与频率的闸门只能在这一层设：
    // 平台收的是演练证据，不是任何人想塞进来的文件
    callback: {
      max_file_mb: 5,
      max_files_per_request: 3,
      max_fields: 40,
      per_token_per_minute: 10,
      per_ip_per_minute: 200,
      screenshot_quota_mb: 512,
    },
  },
  mail: {
    // 沙箱优先：为 true 时任务只渲染与记账，不做真实投递
    default_dry_run: true,
    default_send_interval_ms: 3000,
  },
  exercise: {
    // 未登记有效授权时，采集面与发信链路一律拒绝工作
    require_authorization: true,
  },
  session_ttl_hours: 12,
};

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const sub of ['uploads', 'screenshots', 'attachments', 'outbox']) {
  fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
}

let created = false;
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, yaml.dump(DEFAULTS), 'utf8');
  created = true;
}

const loaded = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
const config = { ...DEFAULTS, ...loaded };
config.panel = { ...DEFAULTS.panel, ...loaded.panel };
config.capture = { ...DEFAULTS.capture, ...loaded.capture };
config.mail = { ...DEFAULTS.mail, ...loaded.mail };
config.exercise = { ...DEFAULTS.exercise, ...loaded.exercise };
config.paths = {
  root: ROOT,
  data: DATA_DIR,
  uploads: path.join(DATA_DIR, 'uploads'),
  screenshots: path.join(DATA_DIR, 'screenshots'),
  attachments: path.join(DATA_DIR, 'attachments'),
  outbox: path.join(DATA_DIR, 'outbox'),
  db: path.join(DATA_DIR, 'awarelab.db'),
  webDist: path.resolve(ROOT, '..', 'web', 'dist'),
};

export { config, created, CONFIG_FILE, randomString };

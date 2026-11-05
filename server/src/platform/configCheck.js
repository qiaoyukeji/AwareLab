/**
 * 启动期配置体检：把 config.yaml 里写错会静默失去防线的项查出来，只读 config 不碰库不写文件。
 * 输出会进启动横幅与前端响应，绝不包含口令、随机路径、TLS 私钥、SMTP 凭据，口令只报改没改过和长度够不够；error 级问题拒绝启动。
 * 判空用 Array.isArray / Number.isFinite，别用 !value：allow_ips 是空数组时 ![] 为 false 但 !'' 为 true，混用会误报。
 */
import { config } from './settings.js';

// 回环地址写法：panel.bind 是这些之一时视为不对外，不触发暴露告警
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @typedef {{level: 'error'|'warn'|'info', code: string, message: string}} Finding
 * error 拒绝启动、warn 打印一行提醒照常服务、info 摘要里一句陈述；code 是稳定标识供前端跳转与测试断言，message 是给操作员看的中文。
 */

/** 后台口令是否仍是首次启动生成的那一条（从未在界面里改过）。 */
export function factoryPasswordInUse() {
  return !config.panel.password_updated_at;
}

/** 管理面是否监听在非回环地址上（同网段可达）。 */
export function panelExposed() {
  const bind = String(config.panel.bind || '127.0.0.1');
  return !LOOPBACK.has(bind);
}

/** 逐项体检当前生效配置，返回按 error→warn→info 排序的结论数组，空数组表示没问题；纯函数无副作用，可反复调用取当下结论。 */
export function checkConfig() {
  /** @type {Finding[]} */
  const findings = [];
  const push = (level, code, message) => findings.push({ level, code, message });

  // 会话有效期：写错就等于签发一张永不过期的登录令牌（NaN 陷阱）
  const ttl = Number(config.session_ttl_hours);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    push(
      'error',
      'session_ttl_hours',
      `session_ttl_hours 必须是大于 0 的数字（当前值无法解析），否则会话永不过期。请改回 12 或你需要的时长。`
    );
  } else if (ttl > 72) {
    // 不是错误，但 3 天以上的后台会话等于没人看着的采集后台一直在线
    push('warn', 'session_ttl_long', `会话有效期 ${ttl} 小时偏长：管理面不做滑动续期，建议不超过一个工作日（12 小时）。`);
  }

  // 管理面端口
  const port = Number(config.panel.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    push('error', 'panel_port', `panel.port 必须是 1-65535 的整数（当前 ${config.panel.port}）。`);
  }

  // 采集端口区间：portError() 全靠它，写反了校验就永远放行
  const range = config.capture.port_range;
  const [lo, hi] = Array.isArray(range) ? range.map(Number) : [NaN, NaN];
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || lo > hi) {
    push(
      'error',
      'capture_port_range',
      `capture.port_range 必须是两个升序整数（如 [8000, 9999]），当前值 ${JSON.stringify(range)} 会让建站端口校验失效。`
    );
  }

  // 来源白名单：类型写错时 Array.isArray 为假等于静默未启用，必须显式报错
  const allowIps = config.panel.allow_ips;
  if (allowIps != null && (!Array.isArray(allowIps) || allowIps.some((entry) => typeof entry !== 'string'))) {
    push(
      'error',
      'panel_allow_ips',
      'panel.allow_ips 必须是字符串数组（如 ["127.0.0.1"]）；写成字符串或数字会让白名单静默失效，任何人都能尝试登录。'
    );
  }

  // 暴露面与门禁：这些是操作员有意放宽的结果，只提醒不拦
  if (panelExposed()) {
    push(
      'warn',
      'panel_bind_exposed',
      `管理面正监听 ${config.panel.bind}：同一网络内任何终端都能到达后台。建议配 panel.allow_ips 白名单并改用 HTTPS。`
    );
  }
  if (config.panel.trust_proxy === true) {
    push(
      'warn',
      'trust_proxy_on',
      'panel.trust_proxy=true：来源 IP 改由 X-Forwarded-For 决定。只有在真的挂了反向代理时才该打开，否则登录锁定与取证 IP 都能被一行请求头伪造。'
    );
  }
  if (config.exercise.require_authorization === false) {
    push('warn', 'authorization_gate_off', 'exercise.require_authorization=false：授权硬门禁已关闭，无授权也能建站与发信。只应在隔离测试实例上这样配。');
  }
  if (config.mail.default_dry_run === false) {
    push('warn', 'sandbox_off_by_default', 'mail.default_dry_run=false：新建的发送任务默认就真实外发。演练现场建议保持 true，逐个任务显式关闭沙箱。');
  }

  // 口令强度：只报事实不回显内容
  if (factoryPasswordInUse()) {
    push(
      'warn',
      'factory_password',
      '后台口令仍是首次启动生成的随机值（从未修改）。请在「系统设置 · 账号与口令」里改成自己的口令。未修改前不允许新建钓鱼网站。'
    );
  } else if (String(config.panel.password || '').length < 8) {
    push('warn', 'password_short', '后台口令短于 8 位。管理面的第二道门就是它，建议加长。');
  }

  // 保留期：0/负数是不清理的合法退路，但要让操作员知道自己在选它
  const retention = Number(config.exercise.retention_days);
  if (!Number.isFinite(retention)) {
    push('warn', 'retention_unparsable', `exercise.retention_days 无法解析（${config.exercise.retention_days}），清理任务会按「不清理」处理。`);
  } else if (retention <= 0) {
    push('info', 'retention_disabled', 'exercise.retention_days ≤ 0：演练数据与采集到的明文口令将永久留存，不会自动清理。');
  }

  const order = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.level] - order[b.level]);
}

/**
 * 建站闸门：默认口令未改时不允许把新的采集页挂上网络，返回非 null 就是回给操作员的拒绝原因（siteApi 据此回 409）。
 * 只拒建站不拒启动（服务还能看历史/改配置/导证据），不看 bind 只看改没改过（出厂口令就写在同机可读的 config.yaml 里）；require_authorization=false 时一并放行，那个组合只在隔离测试实例出现，挡住它会让回归跑不起来。
 */
export function deploymentBlockReason() {
  if (config.exercise.require_authorization === false) return null;
  if (!factoryPasswordInUse()) return null;
  return '后台口令仍是首次启动生成的随机值。请先在「系统设置 · 账号与口令」修改口令，再新建钓鱼网站（出厂口令下不允许把新的采集页挂上网络）。';
}

/**
 * 启动摘要：打进横幅的几行，一律不含凭据；内容为绑定与端口、采集端口区间、沙箱与授权门禁状态、数据保留期、白名单是否启用。
 * 刻意不打印后台随机路径（由 boot/main.js 拼在管理后台那行，只出现一次），也不打印口令。
 */
export function summarizeConfig() {
  const lines = [];
  lines.push(
    `管理面: ${config.panel.bind || '127.0.0.1'}:${config.panel.port}　采集端口区间: ${JSON.stringify(config.capture.port_range)}`
  );
  lines.push(
    `沙箱(不真发信): ${config.mail.default_dry_run === false ? '已关闭' : '开启'}　授权硬门禁: ${
      config.exercise.require_authorization === false ? '已关闭' : '开启'
    }　来源白名单: ${Array.isArray(config.panel.allow_ips) && config.panel.allow_ips.length ? `${config.panel.allow_ips.length} 条` : '未启用'}`
  );
  lines.push(
    `数据保留期: ${Number(config.exercise.retention_days) > 0 ? `${config.exercise.retention_days} 天` : '不清理'}　审计保留期: ${
      Number(config.exercise.audit_retention_days) > 0 ? `${config.exercise.audit_retention_days} 天` : '不清理'
    }`
  );
  return lines;
}

/** error 级结论拼成一段可直接抛出的中文说明，没有 error 返回 null。 */
export function fatalMessage(findings) {
  const fatal = findings.filter((item) => item.level === 'error');
  if (!fatal.length) return null;
  return `配置校验未通过（${fatal.length} 项）：\n  - ${fatal.map((item) => item.message).join('\n  - ')}`;
}

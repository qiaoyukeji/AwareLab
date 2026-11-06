/**
 * 采集面的监听注册表：把库里的站点行变成真正在听的端口，并管它们的生命周期。
 * 一个 ip:port 只能有一个 server，端口必须落在 config.capture.port_range（默认 8000-9999）。
 * web_sites.status 是运维意图、listeners 是进程实况，两者会不一致，判是否在听要问 isRunning()。
 */
import http from 'node:http';
import https from 'node:https';
import { all, get, run, update, nowIso } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { describePid, findListenerPid } from '../platform/portGuard.js';
import { buildSiteHandler } from './siteHandler.js';

// 进程内实况表：key 是 ip:port，重启靠 restoreSites 从库里恢复
const listeners = new Map();
const keyOf = (site) => `${site.listen_ip}:${site.listen_port}`;

/** 展示地址：证书和私钥齐了才写 https，域名留空退回顾监听 IP，0.0.0.0 换成 127.0.0.1；默认端口 80/443 不写进 URL，带 :80 尾巴对演练对象是破绽。 */
export function siteUrl(site) {
  const proto = site.tls_cert && site.tls_key ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  const defaultPort = proto === 'https' ? 443 : 80;
  return `${proto}://${host}:${site.listen_port === defaultPort ? '' : site.listen_port}`.replace(/:$/, '');
}

/**
 * 写库前的端口占用检查，返回中文错误串或 null。端口要落在 port_range，免得撞掉系统端口和平台自己。
 * 同一 ip:port 属于别的站点，后来那个必然 EADDRINUSE，库里只剩一个 status=error 的行。
 * 只查库不查真实 socket，平台外进程占用的端口要到 listen 时才由 error 回调发现。
 */
export function portError({ listen_ip = '0.0.0.0', listen_port, id = null }) {
  const [min, max] = config.capture.port_range;
  if (!Number.isInteger(listen_port) || listen_port < min || listen_port > max) {
    return `监听端口需在 ${min}-${max} 之间`;
  }
  // 改自己这条时它当然还占着原地址，不能把自己判成冲突
  const clash = get('SELECT * FROM web_sites WHERE listen_ip=? AND listen_port=?', [listen_ip, listen_port]);
  if (clash && clash.id !== id) return '该监听地址与端口已被其它站点占用';
  return null;
}

/** 起监听。同一 ip:port 已经在听就直接返回现有 server，再 listen 一次就是 EADDRINUSE；不改 status，标成 open 是调用方的意图。 */
export function startSite(site) {
  const key = keyOf(site);
  if (listeners.has(key)) return listeners.get(key).server;

  // 证书和私钥都齐了才走 https，只有一半时宁可退回 http，别起一个必然失败的监听
  const useTls = Boolean(site.tls_key && site.tls_cert);
  const server = useTls
    ? https.createServer({ key: site.tls_key, cert: site.tls_cert }, buildSiteHandler(site.id))
    : http.createServer(buildSiteHandler(site.id));

  // listen 失败是异步的，EADDRINUSE 不会 throw 给调用方，只能靠回调把实况写回库里
  server.on('error', (err) => {
    run("UPDATE web_sites SET status='error', updated_at=? WHERE id=?", [nowIso(), site.id]);
    // 采集面端口区间是 8000–9999，很容易撞上机器上别的服务；只说「启动失败」操作员还得自己去查 netstat
    if (err.code === 'EADDRINUSE') {
      const owner = describePid(findListenerPid(site.listen_port));
      const who = owner ? `${owner.name}（PID ${owner.pid}）` : '未知进程（可能权限不足）';
      console.error(`[capture] 站点 ${key} 启动失败: 端口被 ${who} 占用；停掉它或给站点换一个端口。`);
      return;
    }
    console.error(`[capture] 站点 ${key} 启动失败: ${err.message}`);
  });

  server.listen(site.listen_port, site.listen_ip);
  listeners.set(key, { server, siteId: site.id });
  return server;
}

/**
 * 只停进程侧、不改库。返回 false 表示本来就没在听，别当收网成功报给操作员；close() 只是不再 accept，长连接要自己超时。
 * key 是 ip:port 而不是 siteId，改过监听地址的站点要拿旧行先 stop 再 start。
 */
export function stopSite(site) {
  const key = keyOf(site);
  const entry = listeners.get(key);
  if (!entry) return false;
  entry.server.close();
  listeners.delete(key);
  return true;
}

/**
 * 授权离开生效窗口后下线名下在听站点：关监听 + 写 status=closed、close_reason=authorization。只停不删，取证记录和配置要留着复盘。
 * 原因必须落库，否则一次续期会把操作员主动收网的站点一起掀开；authorizationId 为空直接返回 0，不做全表扫描。
 */
export function closeSitesOfAuthorization(authorizationId) {
  if (!authorizationId) return 0;
  let stopped = 0;
  for (const site of all("SELECT * FROM web_sites WHERE authorization_id=? AND status='open'", [authorizationId])) {
    stopSite(site);
    update('web_sites', site.id, { status: 'closed', close_reason: 'authorization', updated_at: nowIso() });
    stopped++;
  }
  return stopped;
}

/**
 * 复服只挑 close_reason=authorization 的站点，并把原因清成 NULL：留着它，一次窗口抖动又会把主动收网的站点放开。
 * 起监听失败不在这里报错，端口被占由 error 回调写 status=error，一个坏端口不该拖停整批复服。
 */
export function reopenSitesOfAuthorization(authorizationId) {
  if (!authorizationId) return 0;
  let restored = 0;
  for (const site of all("SELECT * FROM web_sites WHERE authorization_id=? AND status='closed' AND close_reason='authorization'", [authorizationId])) {
    try {
      startSite(site);
      update('web_sites', site.id, { status: 'open', close_reason: null, updated_at: nowIso() });
      restored++;
    } catch {
      /* 端口被占等失败由 server 的 error 回调写回 status=error */
    }
  }
  return restored;
}

/** 重启后按库里 status='open' 的行逐个起监听。不重新校验授权，门禁在每个请求上判；单个站点起不来只跳过，error 回调会把该行写成 error。 */
export function restoreSites() {
  let restored = 0;
  for (const site of all("SELECT * FROM web_sites WHERE status='open'")) {
    try {
      startSite(site);
      // 端口冲突时 startSite 照样返回一个没在听的 server，真值以 error 回调写回的 status 为准
      restored++;
    } catch {
      /* 端口冲突等失败已由 server 的 error 回调写回 status=error */
    }
  }
  return restored;
}

/** 退出前收掉全部监听。不写库：status 保持原样，重启后才知道该恢复哪些意图。残留端口会让下次启动一片 error。 */
export function stopAllSites() {
  for (const [, entry] of listeners) entry.server.close();
  listeners.clear();
}

/** 进程里真实在听的清单，供管理面跟库里的意图比对，不一致就是监听挂了。 */
export function runningListeners() {
  return [...listeners.entries()].map(([key, entry]) => ({ key, siteId: entry.siteId }));
}

/** 按 siteId 查实况表，不看 status，避免拿着 status='open' 去探一个根本没开的端口。 */
export function isRunning(siteId) {
  return listeners.values().some((entry) => entry.siteId === siteId);
}

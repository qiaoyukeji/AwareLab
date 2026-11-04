import http from 'node:http';
import https from 'node:https';
import { all, get, run, update, nowIso } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { buildSiteHandler } from './siteHandler.js';

const listeners = new Map();
const keyOf = (site) => `${site.listen_ip}:${site.listen_port}`;

/** 站点对外展示地址：默认端口不写进 URL，避免演练链接出现「:80」这种破绽 */
export function siteUrl(site) {
  const proto = site.tls_cert && site.tls_key ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  const defaultPort = proto === 'https' ? 443 : 80;
  return `${proto}://${host}:${site.listen_port === defaultPort ? '' : site.listen_port}`.replace(/:$/, '');
}

/**
 * 端口占用检查在写库之前做：采集面端口落在授权区间内且未被其它站点绑定，
 * 否则监听失败只会留下一个 status=error 的站点，运维现场很难看懂。
 */
export function portError({ listen_ip = '0.0.0.0', listen_port, id = null }) {
  const [min, max] = config.capture.port_range;
  if (!Number.isInteger(listen_port) || listen_port < min || listen_port > max) {
    return `监听端口需在 ${min}-${max} 之间`;
  }
  const clash = get('SELECT * FROM web_sites WHERE listen_ip=? AND listen_port=?', [listen_ip, listen_port]);
  if (clash && clash.id !== id) return '该监听地址与端口已被其它站点占用';
  return null;
}

export function startSite(site) {
  const key = keyOf(site);
  if (listeners.has(key)) return listeners.get(key).server;

  const useTls = Boolean(site.tls_key && site.tls_cert);
  const server = useTls
    ? https.createServer({ key: site.tls_key, cert: site.tls_cert }, buildSiteHandler(site.id))
    : http.createServer(buildSiteHandler(site.id));

  server.on('error', (err) => {
    run("UPDATE web_sites SET status='error', updated_at=? WHERE id=?", [nowIso(), site.id]);
    console.error(`[capture] 站点 ${key} 启动失败: ${err.message}`);
  });

  server.listen(site.listen_port, site.listen_ip);
  listeners.set(key, { server, siteId: site.id });
  return server;
}

export function stopSite(site) {
  const key = keyOf(site);
  const entry = listeners.get(key);
  if (!entry) return false;
  entry.server.close();
  listeners.delete(key);
  return true;
}

/**
 * 授权离开生效窗口后，把它名下的在听站点全部下线。
 * 只改监听状态不做删除：取证记录与站点配置还得留着复盘。
 */
export function closeSitesOfAuthorization(authorizationId) {
  if (!authorizationId) return 0;
  let stopped = 0;
  for (const site of all("SELECT * FROM web_sites WHERE authorization_id=? AND status='open'", [authorizationId])) {
    stopSite(site);
    update('web_sites', site.id, { status: 'closed', updated_at: nowIso() });
    stopped++;
  }
  return stopped;
}

/** 进程重启后恢复监听：站点的开启状态是运维意图，不该因为重启而丢失 */
export function restoreSites() {
  let restored = 0;
  for (const site of all("SELECT * FROM web_sites WHERE status='open'")) {
    try {
      startSite(site);
      restored++;
    } catch {
      /* 端口冲突等失败已由 server 的 error 回调写回 status=error */
    }
  }
  return restored;
}

export function stopAllSites() {
  for (const [, entry] of listeners) entry.server.close();
  listeners.clear();
}

export function runningListeners() {
  return [...listeners.entries()].map(([key, entry]) => ({ key, siteId: entry.siteId }));
}

export function isRunning(siteId) {
  return listeners.values().some((entry) => entry.siteId === siteId);
}

import express from 'express';
import { all, get, insert, nowIso, parseJson, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { assertDeployment, findActive, isDomainCovered } from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { flattenHistory } from '../capture/evidenceStore.js';
import { isRunning, portError, siteUrl, startSite, stopSite } from '../capture/siteRegistry.js';

export const siteApi = express.Router();

function withView(site) {
  return { ...site, url: siteUrl(site), running: isRunning(site.id) };
}

siteApi.get('/web-sites', (_req, res) => {
  const rows = all(
    `SELECT s.*, t.name AS template_name, t.type AS template_type, a.scope AS auth_scope
     FROM web_sites s LEFT JOIN web_templates t ON t.id=s.template_id
     LEFT JOIN authorizations a ON a.id=s.authorization_id ORDER BY s.created_at DESC`
  ).map(withView);
  ok(res, { rows, total: rows.length });
});

siteApi.post('/web-sites', (req, res) => {
  if (!assertDeployment(res)) return;
  const b = req.body || {};
  const template = get('SELECT * FROM web_templates WHERE id=?', [b.template_id]);
  if (!template) return badRequest(res, '模板不存在');
  const auth = findActive();
  const port = Number(b.listen_port);
  const portProblem = portError({ listen_ip: b.listen_ip || '0.0.0.0', listen_port: port });
  if (portProblem) return badRequest(res, portProblem);
  if (b.domain && !isDomainCovered(auth, b.domain)) {
    return badRequest(res, '仿冒域名不在授权名单内，请调整授权范围');
  }
  if (b.tls_cert && !b.tls_key) return badRequest(res, '配置 HTTPS 需同时提供 TLS 私钥');

  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    template_id: template.id,
    authorization_id: auth.id,
    // 建站的默认意图是立刻投放，只有显式要求 closed 才保留为未监听
    status: b.status === 'closed' ? 'closed' : 'open',
    listen_ip: b.listen_ip || '0.0.0.0',
    listen_port: port,
    domain: b.domain || null,
    tls_key: b.tls_key || null,
    tls_cert: b.tls_cert || null,
    created_at: now,
    updated_at: now,
  };
  insert('web_sites', row);
  if (row.status === 'open') startSite(row);
  // 与列表/详情同一份视图形状：closed 建站时前端也要能读到 running=false
  ok(res, withView(row));
});

siteApi.post('/web-sites/:id/start', (req, res) => {
  if (!assertDeployment(res)) return;
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  startSite(site);
  update('web_sites', site.id, { status: 'open', updated_at: nowIso() });
  ok(res, withView(site));
});

siteApi.post('/web-sites/:id/stop', (req, res) => {
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  stopSite(site);
  update('web_sites', site.id, { status: 'closed', updated_at: nowIso() });
  ok(res, true);
});

siteApi.put('/web-sites/:id', (req, res) => {
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  const b = req.body || {};
  const patch = { updated_at: nowIso() };
  for (const key of ['template_id', 'domain', 'tls_key', 'tls_cert']) {
    if (b[key] !== undefined) patch[key] = b[key] || null;
  }
  update('web_sites', site.id, patch);
  const fresh = get('SELECT * FROM web_sites WHERE id=?', [site.id]);
  // 模板与证书都在监听进程内部生效，改完必须重开监听才拿得到新配置
  if (fresh.status === 'open') {
    stopSite(site);
    startSite(fresh);
  }
  ok(res, withView(fresh));
});

/**
 * 站点维度回看：这个监听下面发过哪些链接、谁打开过、谁提交了什么。
 * 只列本站签发的令牌（邮件任务的收件人链接归属在投递面，那里另有漏斗视图）；
 * 打开次数取事件表而不是记录表，一条记录会被反复钓多次，计数只有事件才准。
 */
siteApi.get('/web-sites/:id/links', (req, res) => {
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  const rows = all(
    `SELECT c.token,c.target_email,c.target_name,c.created_at,c.submitted_at AS tk_submitted_at,
            r.id AS record_id,r.first_seen_at,r.last_seen_at,r.submitted_at AS record_submitted_at,
            r.dwell_seconds,r.form_json,
            (SELECT COUNT(*) FROM events e WHERE e.kind='page_open' AND e.token=c.token) AS opens
     FROM capture_tokens c
     LEFT JOIN records r ON r.kind='web' AND r.token=c.token
     WHERE c.site_id=? ORDER BY c.created_at DESC`,
    [site.id]
  ).map((row) => {
    const history = flattenHistory(row.form_json);
    const names = [...new Set(history.map((f) => f.name))];
    return {
      token: row.token,
      url: `${siteUrl(site)}/?tk=${row.token}`,
      target_email: row.target_email,
      target_name: row.target_name,
      created_at: row.created_at,
      opened_at: row.first_seen_at ?? null,
      last_seen_at: row.last_seen_at ?? null,
      opens: row.opens ?? 0,
      submitted_at: row.record_submitted_at ?? row.tk_submitted_at ?? null,
      dwell_seconds: row.dwell_seconds ?? null,
      record_id: row.record_id ?? null,
      field_names: names,
      submits: row.form_json ? parseJson(row.form_json, []).length : 0,
    };
  });
  ok(res, { rows, total: rows.length, site: withView(site) });
});

/**
 * 签发投放链接：手动投放（IM、内网公告、纸质二维码）没有邮件收件人表，
 * 但归属口径必须和邮件一致——令牌登记进 capture_tokens，采集到的打开与提交才认得出是谁。
 */
siteApi.post('/web-sites/:id/links', (req, res) => {
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  if (!assertDeployment(res)) return;
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return badRequest(res, '归属邮箱格式不正确');
  const tk = crypto.randomUUID();
  insert('capture_tokens', {
    token: tk,
    site_id: site.id,
    task_id: null,
    target_email: email || null,
    target_name: name || null,
    created_at: nowIso(),
    first_seen_at: null,
    submitted_at: null,
  });
  ok(res, { tk, url: `${siteUrl(site)}/?tk=${tk}`, target_email: email || null, target_name: name || null });
});

siteApi.delete('/web-sites/:id', (req, res) => {
  const site = get('SELECT * FROM web_sites WHERE id=?', [req.params.id]);
  if (!site) return notFound(res, '站点不存在');
  stopSite(site);
  run('DELETE FROM web_sites WHERE id=?', [site.id]);
  // 站点删了，它采集到的证据还在：把"删了哪张网、上面挂过几个端口"记下来，避免事后说不清是谁收的网
  writeAudit(req, 'site.delete', {
    targetKind: 'web_site',
    targetId: site.id,
    detail: { template_id: site.template_id, listen_port: site.listen_port, domain: site.domain, evidence_kept: get('SELECT COUNT(*) AS n FROM records WHERE site_id=?', [site.id]).n },
  });
  ok(res, true);
});

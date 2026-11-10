// 仿冒站点监听域 /web-sites*：一张钓鱼页的建档、开关监听、参数修改与专属投放链接。
// 建站、开站、签链接是投放动作过授权门禁；停止与删除是收网侧，不设门禁（失控时第一件事是撤页面）。
// withView 的 running 取监听注册表实时值，库里 status 只是运维意图，两者可背离。
import express from 'express';
import { all, get, insert, nowIso, parseJson, run, update } from '../platform/storage/rows.js';
import { config } from '../platform/settings.js';
import { ok, badRequest, conflict, notFound } from '../platform/net/envelope.js';
import { assertDeployment, findActive, isDomainCovered } from '../security/mandate.js';
import { deploymentBlockReason } from '../platform/configCheck.js';
import { writeAudit } from '../security/audit.js';
import { ownerClause, ownsRow } from '../security/scope.js';
import { flattenHistory } from '../capture/evidenceStore.js';
import { isRunning, portError, siteUrl, startSite, stopSite } from '../capture/siteRegistry.js';
import { normalizePublicUrl, publicUrlProblem } from '../capture/siteAddress.js';

export const siteApi = express.Router();

/**
 * 站点出参统一视图，列表/详情/建站/修改都走这份；url 由 siteUrl 派生，有域名用域名、0.0.0.0 展示成 127.0.0.1、80/443 默认端口不写进链接；
 * running 从 siteRegistry 实时读，库里 status 只是运维意图。
 */
function withView(site) {
  return { ...site, url: siteUrl(site), running: isRunning(site.id) };
}

/**
 * 按 id 取站点并顺带判归属：别人的站点一律按"不存在"回 404，不回 403——
 * 403 等于告诉调用方这个 id 真实存在，横向探测就有了信号。
 */
function loadOwnedSite(req, res, id) {
  const site = get('SELECT * FROM web_sites WHERE id=?', [id]);
  if (!site) {
    notFound(res, '站点不存在');
    return null;
  }
  if (!ownsRow(req, site)) {
    notFound(res, '站点不存在');
    return null;
  }
  return site;
}

/** GET /web-sites 全量列表不分页：每站独占一个端口，总数被 capture.port_range 钳死；两个 LEFT JOIN 不用 INNER，模板删除或授权更替后站点行仍要列出。 */
siteApi.get('/web-sites', (req, res) => {
  // 普通用户只看自己建的：README 承诺的「只看到分给自己的部分」落在这里，管理员不加条件
  const scope = ownerClause(req, 's');
  const rows = all(
    `SELECT s.*, t.name AS template_name, t.type AS template_type, a.scope AS auth_scope
     FROM web_sites s LEFT JOIN web_templates t ON t.id=s.template_id
     LEFT JOIN authorizations a ON a.id=s.authorization_id WHERE 1=1${scope.sql} ORDER BY s.created_at DESC`,
    scope.params
  ).map(withView);
  ok(res, { rows, total: rows.length });
});

/**
 * POST /web-sites 建一张钓鱼页并缺省立刻开监听，投放动作、授权门禁打头。闸门顺序 assertDeployment 403 →
 * 出厂口令未改 409 → 模板不存在 400 → 端口非法或被占用 400 → 域名不在授权名单 400（访客实际拿到 404） → 证书缺私钥 400。
 * 端口须在 capture.port_range 内整数、且地址+端口组合不被别的站点占用；该端口校验与 listen_ip 缺省（跟 bind_host，别硬编码 0.0.0.0 挂满网卡）只在建站出现，PUT 不接受改监听地址端口。
 */
siteApi.post('/web-sites', (req, res) => {
  if (!assertDeployment(res)) return;
  // 出厂口令未改时禁止新建采集页：一开监听就采真实凭据，而此刻后台口令明文躺在同机可读的 config.yaml 里；回 409 而非 403，这不是权限问题，改完口令就能建
  const blockReason = deploymentBlockReason();
  if (blockReason) return conflict(res, blockReason);
  const b = req.body || {};
  // 坏 template_id 按 400 不 404：创建语义没有找不到的资源，只有填错的表单
  const template = get('SELECT * FROM web_templates WHERE id=?', [b.template_id]);
  if (!template) return badRequest(res, '模板不存在');
  const auth = findActive();
  const port = Number(b.listen_port);
  // 缺省监听地址跟 bind_host：收成 127.0.0.1 时别把仿冒页挂到所有网卡
  const listenIp = b.listen_ip || config.capture.bind_host || '0.0.0.0';
  // 端口校验先于写库：等 listen 失败只剩 status=error 的站，现场很难看懂
  const portProblem = portError({ listen_ip: listenIp, listen_port: port });
  if (portProblem) return badRequest(res, portProblem);
  if (b.domain && !isDomainCovered(auth, b.domain)) {
    return badRequest(res, '仿冒域名不在授权名单内，请调整授权范围');
  }
  // 半套 TLS 拒收：只有证书没私钥 https 起不来，存进库只留一个 status=error 的谜
  if (b.tls_cert && !b.tls_key) return badRequest(res, '配置 HTTPS 需同时提供 TLS 私钥');
  // 反代场景外网是域名+443、监听的是内网 8080；对外地址决定邮件与二维码里的链接长什么样
  const urlProblem = publicUrlProblem(b.public_url);
  if (urlProblem) return badRequest(res, urlProblem);

  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    template_id: template.id,
    // 建站即绑授权：出窗口时级联下线才有依据
    authorization_id: auth.id,
    // 建站默认意图是立刻投放，只有显式 closed 才保留未监听
    status: b.status === 'closed' ? 'closed' : 'open',
    // 建档即未监听也算 manual：不是被平台强制下线的，授权续期时不会被误复活
    close_reason: b.status === 'closed' ? 'manual' : null,
    listen_ip: listenIp,
    listen_port: port,
    domain: b.domain || null,
    public_url: b.public_url ? normalizePublicUrl(b.public_url) : null,
    tls_key: b.tls_key || null,
    tls_cert: b.tls_cert || null,
    // 归属落库：普通用户只能看见、只能操作自己建的站点；管理员不受限
    owner_id: req.user?.id || null,
    created_at: now,
    updated_at: now,
  };
  insert('web_sites', row);
  if (row.status === 'open') startSite(row);
  writeAudit(req, 'site.create', {
    targetKind: 'web_site',
    targetId: row.id,
    // 私钥只记"有没有配"，审计表不是第二个凭据库
    detail: {
      template_id: row.template_id,
      listen_ip: row.listen_ip,
      listen_port: row.listen_port,
      domain: row.domain,
      public_url: row.public_url,
      tls: Boolean(row.tls_cert),
      authorization_scope: auth.scope,
    },
  });
  ok(res, withView(row));
});

/** POST /web-sites/:id/start 开站把仿冒页真的挂上网络，投放动作、门禁打头：assertDeployment 403（无授权连站点 id 都不给摸）→ 404 站点不存在；startSite 幂等、close_reason 清 NULL，写 site.start 审计追到人。返回的 view 基于开站前读的那行（status 是旧值，running 已 true）。 */
siteApi.post('/web-sites/:id/start', (req, res) => {
  if (!assertDeployment(res)) return;
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  startSite(site);
  update('web_sites', site.id, { status: 'open', close_reason: null, updated_at: nowIso() });
  writeAudit(req, 'site.start', {
    targetKind: 'web_site',
    targetId: site.id,
    detail: { listen_ip: site.listen_ip, listen_port: site.listen_port, domain: site.domain },
  });
  ok(res, withView(site));
});

/** POST /web-sites/:id/stop 收网：掀掉监听、保留已采证据，刻意不过授权门禁（失控时第一件事是撤页面）。停一个本来没在听的站不算错，语义是确保不再监听、照样落 closed；close_reason='manual'，采集记录一条不删，返回 true（收网要快，不多查一次库）。 */
siteApi.post('/web-sites/:id/stop', (req, res) => {
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  stopSite(site);
  // 主动收网记为 manual：续期授权时只有被平台强制下线的那批站点会自动复服
  update('web_sites', site.id, { status: 'closed', close_reason: 'manual', updated_at: nowIso() });
  writeAudit(req, 'site.stop', {
    targetKind: 'web_site',
    targetId: site.id,
    detail: { listen_ip: site.listen_ip, listen_port: site.listen_port, domain: site.domain },
  });
  ok(res, true);
});

/**
 * PUT /web-sites/:id 改模板/域名/TLS，三项校验与建站同一套。按序 404（先于一切入参检查）→ 400 模板不存在（换到不存在的模板访客会报"页面不存在"、接口却回成功）
 * → 400 域名不在生效授权名单 → 400 新增证书没带私钥且库里也没有（只换证书沿用旧私钥合法，故多问一句 site.tls_key）。
 * 白名单四列 template_id/domain/tls_key/tls_cert，undefined=不动、空值=清成 NULL，监听地址与端口不接受从这里改；不过 assertDeployment（改是调已有网，非新增投放），域名仍由 isDomainCovered 兜。
 * open 态先 stop 再以新行 start：模板与证书编译在监听进程内部，不重开改动不生效。
 */
siteApi.put('/web-sites/:id', (req, res) => {
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  const b = req.body || {};
  if (b.template_id !== undefined && b.template_id !== null && !get('SELECT 1 AS x FROM web_templates WHERE id=?', [b.template_id])) {
    return badRequest(res, '模板不存在');
  }
  if (b.domain && !isDomainCovered(findActive(), b.domain)) {
    return badRequest(res, '仿冒域名不在授权名单内，请调整授权范围');
  }
  if (b.tls_cert && !b.tls_key && !site.tls_key) return badRequest(res, '配置 HTTPS 需同时提供 TLS 私钥');
  const urlProblem = publicUrlProblem(b.public_url);
  if (urlProblem) return badRequest(res, urlProblem);
  const patch = { updated_at: nowIso() };
  for (const key of ['template_id', 'domain', 'tls_key', 'tls_cert']) {
    if (b[key] !== undefined) patch[key] = b[key] || null;
  }
  // 对外地址单独归一：空串表示回到「按监听地址直连」，不是删列
  if (b.public_url !== undefined) patch.public_url = b.public_url ? normalizePublicUrl(b.public_url) : null;
  update('web_sites', site.id, patch);
  const fresh = get('SELECT * FROM web_sites WHERE id=?', [site.id]);
  if (fresh.status === 'open') {
    // 掀监听用旧行（listen_ip/port 不在白名单，旧值即新值），重开用新行读改动后的配置
    stopSite(site);
    startSite(fresh);
  }
  ok(res, withView(fresh));
});

/** GET /web-sites/:id/links 站点维度回看：只列本站签发的令牌（邮件收件人链接归属在投递面）。打开次数取事件表而非记录表，一条记录会被反复钓多次、只有事件计数才准；404 站点不存在，读视图也先验父。 */
siteApi.get('/web-sites/:id/links', (req, res) => {
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  // capture_tokens LEFT JOIN records：签了但还没人点的链接也要列出，这是回看清单不是上钩清单；r.kind='web' 限定网页侧记录，同令牌的邮件记录不属于本站口径
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
      // 专属链接形态与协议一致：?tk=<uuid>，访客落地即被 siteHandler 认领归属
      url: `${siteUrl(site)}/?tk=${row.token}`,
      target_email: row.target_email,
      target_name: row.target_name,
      created_at: row.created_at,
      opened_at: row.first_seen_at ?? null,
      last_seen_at: row.last_seen_at ?? null,
      opens: row.opens ?? 0,
      // 提交时间两路都由采集回写，记录行的更具体，缺记录时兜令牌表那份；历史数据可能只补了一路，宁可先新后旧也别显 null
      submitted_at: row.record_submitted_at ?? row.tk_submitted_at ?? null,
      dwell_seconds: row.dwell_seconds ?? null,
      record_id: row.record_id ?? null,
      field_names: names,
      // submits=采集历史条数（反复上交的"次"），与"是否提交过"是两码事
      submits: row.form_json ? parseJson(row.form_json, []).length : 0,
    };
  });
  ok(res, { rows, total: rows.length, site: withView(site) });
});

/** POST /web-sites/:id/links 给这张网签发一条带归属的专属投放链接（投放动作、过门禁）。手动投放（IM、内网公告、二维码）没有邮件收件人表，但归属口径要和邮件一致：令牌登记进 capture_tokens，采到的打开与提交才认得出是谁。闸门顺序 404 → assertDeployment 403（先验父，不存在的 id 不该冒充被门禁拦下）；email/name 可空即匿名链接，email 给了必须像地址。INSERT capture_tokens（site_id=本站、task_id=NULL），不写审计。 */
siteApi.post('/web-sites/:id/links', (req, res) => {
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  if (!assertDeployment(res)) return;
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  // 归属邮箱写错会把这条链接采到的全部证据挂到不存在的人名下，取证当场作废，签发时必须点齐
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
  ok(res, { token: tk, url: `${siteUrl(site)}/?tk=${tk}`, target_email: email || null, target_name: name || null });
});

/**
 * DELETE /web-sites/:id 删站（配置档案级收网，与 stop 同样不设门禁），404 站点不存在先查再删。
 * 顺序先 stopSite 放掉监听再 DELETE 行，倒过来会留下端口还被本进程听着的孤儿监听、新建站可能被它撞端口；模板不动，records/capture_tokens/events 全保留，看板的已删除幽灵分组就是为这数据准备。
 * site.delete 审计带 evidence_kept 保留条数，事后对得上账。
 */
siteApi.delete('/web-sites/:id', (req, res) => {
  const site = loadOwnedSite(req, res, req.params.id);
  if (!site) return;
  stopSite(site);
  run('DELETE FROM web_sites WHERE id=?', [site.id]);
  writeAudit(req, 'site.delete', {
    targetKind: 'web_site',
    targetId: site.id,
    detail: { template_id: site.template_id, listen_port: site.listen_port, domain: site.domain, evidence_kept: get('SELECT COUNT(*) AS n FROM records WHERE site_id=?', [site.id]).n },
  });
  ok(res, true);
});

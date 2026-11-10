// 平台设置与运维接口：/settings、/push-logs、/ai/generate、/config-check、/maintenance；仿站与建站发信共用投放门禁，无生效授权拒绝。
// 模型 Key 与机器人令牌只掩码不外泄，不进响应/审计/日志；出站除本机回环外只走 https。
import express from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../platform/settings.js';
import { getSetting, setSetting, pagedRows } from '../platform/storage/rows.js';
import { driver } from '../platform/storage/connection.js';
import { ok, fail, badRequest, paginate } from '../platform/net/envelope.js';
import { inspectTemplate } from '../capture/diagnostics.js';
import { DEPLOY_MESSAGE, findActive, isHostAuthorized } from '../security/mandate.js';
import { writeAudit } from '../security/audit.js';
import { maskUrl } from '../notify/notifier.js';
import { clientIp } from '../platform/net/clientIp.js';
import {
  checkConfig,
  fatalMessage,
  summarizeConfig,
  factoryPasswordInUse,
  panelExposed,
  deploymentBlockReason,
} from '../platform/configCheck.js';
import { loginSecurityStatus, requireAdmin } from '../security/session.js';
import { retentionStatus, runRetentionSweep } from '../platform/maintenance.js';
import { smsConfig, maskedSmsConfig, saveSmsConfig, smsReadyProblem, normalizeTemplateParam } from '../sms/sms.js';

export const platformApi = express.Router();

// 密钥掩码串，读接口替换真值、keepStoredKeys 据此判断这行没改过密钥
const SECRET_MASK = '******';
const AI_DEFAULT = { providers: [], api_key: '' };
const PUSH_DEFAULT = { enabled: false, channels: [], redact: true };

/** 推送地址校验：https 放行，http 只允许本机回环，否则事件与令牌会明文外流。返回 null 或中文原因（调用方包 400）。 */
function pushUrlProblem(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return `推送地址不是合法 URL：${raw}`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    // 回环出不了本机，明文无害
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
    return `推送地址 ${host} 走明文 http，会把演练事件和机器人令牌一并暴露；请改用 https 的机器人地址`;
  }
  return `推送地址协议不支持：${parsed.protocol}`;
}

/** 推送配置形状与逐渠道 URL 校验；没填 url 的渠道当占位跳过，允许半配置。 */
function pushConfigProblem(value) {
  if (!value || typeof value !== 'object') return '推送配置格式不对';
  if (!Array.isArray(value.channels)) return '推送配置缺少 channels 数组';
  for (const channel of value.channels) {
    if (!channel?.url) continue;
    const problem = pushUrlProblem(channel.url);
    if (problem) return problem;
  }
  return null;
}

/** 密钥只在本机与服务端之间流转，读取一律掩码，明文不进浏览器内存与网络面板。 */
function maskSecrets(cfg) {
  // 脏数据原样返回，别在这步把本来读得出的配置弄崩
  if (!cfg || typeof cfg !== 'object') return cfg;
  const masked = { ...cfg };
  if (masked.api_key) masked.api_key = SECRET_MASK;
  if (Array.isArray(masked.providers)) {
    // 逐厂商掩 api_key；没配 key 的行保持原样，界面才分得清未设置与已设置
    masked.providers = masked.providers.map((p) => (p && p.api_key ? { ...p, api_key: SECRET_MASK } : p));
  }
  return masked;
}

/** 界面读写都是掩码，key 为空或等于掩码理解为不改，否则保存会把真 key 洗成星号；行身份 id 优先、旧数据按名称兜底。 */
function keepStoredKeys(next, prev) {
  const prevList = Array.isArray(prev?.providers) ? prev.providers : [];
  const byId = new Map(prevList.filter((p) => p?.id).map((p) => [p.id, p]));
  const byName = new Map(prevList.filter((p) => p?.name && !p.id).map((p) => [p.name, p]));
  const merged = { ...next };
  if (Array.isArray(next?.providers)) {
    merged.providers = next.providers.map((p) => {
      const old = (p?.id ? byId.get(p.id) : null) || byName.get(p?.name) || null;
      // 缺 id 的行补一个，此后只走 id
      const row = { ...p, id: p?.id || old?.id || randomUUID() };
      if (!row.api_key || row.api_key === SECRET_MASK) {
        // 对不上号的掩码无法还原，留空而不是留一串星号
        row.api_key = old?.api_key === SECRET_MASK ? '' : old?.api_key || '';
      }
      return row;
    });
  }
  // 顶层 api_key 同语义：空或掩码都不改，继承旧值
  if ((!merged.api_key || merged.api_key === SECRET_MASK) && prev?.api_key) merged.api_key = prev.api_key;
  return merged;
}

/** 审计不存密钥：模型 Key 只记有没有配，机器人地址只记掩码后的。 */
function settingsAuditDetail(key, value) {
  if (key === 'ai') {
    // 只留厂商名、掩码后服务地址、有没有配 key，真 key 绝不进审计
    return {
      providers: (value?.providers || []).map((p) => ({
        name: p?.name ?? null,
        base_url: p?.base_url ? maskUrl(p.base_url) : null,
        has_api_key: Boolean(p?.api_key && p.api_key !== SECRET_MASK),
      })),
    };
  }
  if (key === 'push') {
    // redact!==false：缺字段按默认脱敏算，只有显式 false 才是关
    return {
      enabled: Boolean(value?.enabled),
      redact: value?.redact !== false,
      channels: (value?.channels || []).map((c) => ({ type: c?.type ?? null, url: c?.url ? maskUrl(c.url) : null, events: c?.events ?? null })),
    };
  }
  // 其余键截 500 字符，审计行不被大 JSON 撑爆（writeAudit 另有 4000 全局钳）
  return { value: String(JSON.stringify(value ?? null)).slice(0, 500) };
}

/** GET /settings 一屏数据源，只读、永远成功；ai/sms 掩码回传（仅管理员），端口区间/门禁/面板路径等 config.yaml 值启动读一次、前端只看不能改，panel_path 需会话。 */
platformApi.get('/settings', requireAdmin, (_req, res) => {
  const sms = smsConfig();
  ok(res, {
    push: getSetting('push', PUSH_DEFAULT),
    ai: maskSecrets(getSetting('ai', AI_DEFAULT)),
    sms: maskedSmsConfig(),
    sms_ready: !smsReadyProblem(sms),
    // 把「为什么还不能启用」原样带给界面：最常见是 AccessKey 被浏览器自动填成了后台登录账号
    sms_ready_reason: smsReadyProblem(sms) || '',
    capture_port_range: config.capture.port_range,
    mail_default_dry_run: config.mail.default_dry_run,
    require_authorization: config.exercise.require_authorization,
    panel_path: config.panel.path,
    panel_port: config.panel.port,
    db_driver: driver,
    db_path: config.paths.db,
  });
});

/** PUT /settings/:key 写一个键（body 取 value，键名走 URL），无白名单但每次必写审计、detail 脱敏截断，缺 value 或校验不过 400；ai 先 keepStoredKeys 再逐厂商过 providerUrlProblem，push 走 pushConfigProblem 并与默认合并，其余键原样存（端口区间与门禁开关要改 config.yaml 重启）。 */
platformApi.put('/settings/:key', requireAdmin, (req, res) => {
  const incoming = req.body?.value;
  // 缺 value 会把键存成空配置，必须拒掉而不是静默清空
  if (incoming === undefined) return badRequest(res, '缺少要保存的配置值');
  if (req.params.key === 'sms') {
    const saved = saveSmsConfig(incoming || {});
    const problem = saved.enabled ? smsReadyProblem(saved) : null;
    writeAudit(req, 'settings.update', {
      targetKind: 'setting',
      targetId: 'sms',
      // 审计只记开关与「密钥是否配置」，AK Secret 与签名原文不落库
      detail: {
        value: JSON.stringify({
          enabled: saved.enabled,
          has_access_key: Boolean(saved.access_key_id),
          has_secret: Boolean(saved.access_key_secret),
          sign_name: saved.sign_name,
          template_code: saved.template_code,
        }).slice(0, 500),
      },
    });
    if (problem) return ok(res, { ...maskedSmsConfig(), warning: `已保存，但还不能启用：${problem}` });
    // 模板参数写错是最常见的发码失败原因，保存时就提示，不必等阿里云回 isv.INVALID_PARAMETERS
    const paramProblem = incoming?.template_param !== undefined
      ? normalizeTemplateParam(incoming.template_param).problem
      : null;
    if (paramProblem) return ok(res, { ...maskedSmsConfig(), warning: `已保存；${paramProblem}` });
    return ok(res, maskedSmsConfig());
  }
  if (req.params.key === 'ai') {
    const merged = keepStoredKeys(incoming, getSetting('ai', AI_DEFAULT));
    // 每个厂商 base_url 都过门禁：settings 里的 URL 是唯一出站目的地，漏一家就是后门
    for (const provider of merged.providers || []) {
      if (!provider?.base_url) continue;
      const problem = providerUrlProblem(provider.base_url);
      if (problem) return badRequest(res, problem);
    }
    setSetting('ai', merged);
    writeAudit(req, 'settings.update', { targetKind: 'setting', targetId: 'ai', detail: settingsAuditDetail('ai', merged) });
    return ok(res, maskSecrets(getSetting('ai', AI_DEFAULT)));
  }
  if (req.params.key === 'push') {
    const problem = pushConfigProblem(incoming);
    if (problem) return badRequest(res, problem);
    // 与默认形状合并落库：redact 缺省落在 true
    setSetting('push', { ...PUSH_DEFAULT, ...incoming });
    writeAudit(req, 'settings.update', {
      targetKind: 'setting',
      targetId: 'push',
      // 审计里的渠道地址已 maskUrl 换星，存库的却是原串
      detail: settingsAuditDetail('push', { ...PUSH_DEFAULT, ...incoming }),
    });
    return ok(res, getSetting('push', PUSH_DEFAULT));
  }
  // 通用键不设白名单，但运行参数变更仍过审计
  setSetting(req.params.key, incoming);
  writeAudit(req, 'settings.update', { targetKind: 'setting', targetId: req.params.key, detail: settingsAuditDetail(req.params.key, incoming) });
  ok(res, getSetting(req.params.key));
});

/** 推送/外发流水，分页倒序；request 列写入时已 maskUrl 换星可原样给前端，取证导出借这张表记 csv_export 故兼作对账。 */
platformApi.get('/push-logs', requireAdmin, (req, res) => {
  const { page, page_size } = paginate(req.query);
  ok(res, pagedRows('push_logs', '', [], page, page_size));
});

/** 采集页提示词：用 data-al-collect 声明式绑定取代手写上报代码。 */
const buildPrompt = (siteName, fields) => `请生成一个「${siteName}」的网页模板（HTML）。
要求：
1. 页面用一个 <form> 承载表单，收集以下字段：${fields.join('、') || '账号/密码'}，每个输入控件都要写 name 属性。
2. 提交按钮写 data-al-collect 属性，不要写任何上报脚本，也不要写 onclick。
3. 仅返回完整可用的 HTML 代码，使用内嵌 CSS，不要添加外部 js/css 链接、不要额外说明、不需要 JS 的例子。`;

/** hostTokens 的降噪器：文件后缀不算仿冒目标，否则提示词里的 index.html 会被当域名拦下 */
const FILE_SUFFIX = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'css', 'json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'lock',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'txt', 'md', 'xml', 'eml', 'pdf',
  'zip', 'gz', 'tar', 'mp4', 'webm', 'sql', 'log', 'bak', 'sh', 'bat', 'ps1',
]);

/** 从自由文本里摘出像主机名的片段：点分域名或点分 IP */
function hostTokens(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi)) {
    const host = match[0].toLowerCase();
    const labels = host.split('.');
    if (FILE_SUFFIX.has(labels[labels.length - 1])) continue;
    // 单段超 63 字符（RFC 1035 上限）的多是长数字串或 base64 残片，不当主机名
    if (labels.some((label) => label.length > 63)) continue;
    found.add(host);
  }
  return [...found];
}

// 仿站提示词里出现真实员工邮箱是硬拒绝（400），不发给外部模型
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** 仿站与建站、发信共用同一道门禁：无生效授权 403，名单外主机或员工邮箱 400。 */
function cloneScopeProblem(siteName, prompt) {
  const auth = findActive();
  if (!auth) return { code: 403, message: DEPLOY_MESSAGE };
  const text = `${siteName || ''}\n${prompt || ''}`;
  // 邮箱检查排在主机检查前
  if (EMAIL_PATTERN.test(text)) {
    return { code: 400, message: '提示词里出现了邮箱地址。仿站目标请用域名或 IP 表达，真实员工邮箱不发给外部模型。' };
  }
  const outside = hostTokens(text).filter((host) => !isHostAuthorized(auth, host));
  if (outside.length) {
    return { code: 400, message: `目标主机 ${outside.join('、')} 不在授权名单内，已拒绝服务。请先在「演练授权」登记，或改用名单内的地址。` };
  }
  return null;
}

/** 模型服务地址：公网只走 https，本机回环可明文 http；外呼带 Authorization 头，明文 http 会让它被链路读取。 */
/**
 * 模型服务地址门禁：本机回环放行（本地推理服务是正常用法），其余一律要 https 且不许指向内网。
 * 只校验协议会让「https://10.0.0.5」这种地址通过——那就是一次带着 API Key 的内网探测。
 */
function privateHost(host) {
  const raw = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!raw) return false;
  if (raw === 'localhost' || raw.endsWith('.localhost') || raw.endsWith('.local')) return true;
  // IPv4 字面量：10/8、172.16/12、192.168/16、169.254/16（含云元数据 169.254.169.254）、100.64/10（运营商级 NAT）
  const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 0) return true;
  }
  // IPv6 字面量：fc00::/7 唯一本地、fe80::/10 链路本地
  if (raw.includes(':')) {
    if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(raw)) return true;
  }
  return false;
}

function providerUrlProblem(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return `模型服务地址不是合法 URL：${raw}`;
  }
  const host = parsed.hostname;
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (parsed.protocol === 'https:') {
    // 云端厂商都是 https；这里只挡内网与链路本地地址，公网域名照旧放行
    return privateHost(host) && !loopback ? `模型服务地址 ${host} 指向内网，平台不允许把 API Key 发往内网地址` : null;
  }
  if (parsed.protocol === 'http:') {
    if (loopback) return null;
    return `模型服务地址 ${host} 走明文 http，API Key 会裸奔在链路上；请改用 https，或用本机回环地址做本地联调`;
  }
  return `模型服务地址协议不支持：${parsed.protocol}`;
}

/** 一键仿站，不写库。门禁顺序 cloneScopeProblem（无授权 403、名单外主机或员工邮箱 400）→ 缺 api_key 400 → providerUrlProblem 400；上游非 2xx 转 502，异常/超时/回包非 JSON 回 500。 */
platformApi.post('/ai/generate', requireAdmin, async (req, res) => {
  const siteName = req.body?.site_name || '登录页';
  const fields = Array.isArray(req.body?.fields) ? req.body.fields.filter(Boolean) : [];
  const prompt = req.body?.prompt?.trim() || buildPrompt(siteName, fields);
  const scope = cloneScopeProblem(siteName, prompt);
  if (scope) return fail(res, scope.code, scope.message);
  const cfg = getSetting('ai', { providers: [] });
  const providers = cfg.providers || [];
  // provider_id 对不上时落到第一家
  const provider = providers.find((p) => p.id === req.body?.provider_id) || providers[0];
  if (!provider?.base_url || !provider?.api_key) {
    return badRequest(res, '请先在「系统设置 - 模型服务」中配置厂商与 API Key');
  }
  // 出站前再过一次 URL 门禁：库里 base_url 可能是历史遗留的明文地址
  const urlProblem = providerUrlProblem(provider.base_url);
  if (urlProblem) return badRequest(res, urlProblem);
  const url = `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      // api_key 只在这一条出站头里，不进响应、审计、日志
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key}` },
      body: JSON.stringify({
        model: provider.model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: Number(req.body?.temperature ?? 0.4),
        // stream:false 一次拿完整回复，前端无 SSE 通路
        stream: false,
      }),
      // 120s 超时：模型生成长 HTML 可达一分钟，不设会吊死
      signal: AbortSignal.timeout(120000),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      // 不回显上游响应体：它可能带着内网地址、配额信息，甚至把请求头原样抄回来
      res.status(502).json({ code: 502, message: `模型服务返回 ${upstream.status}，请检查厂商配置与配额` });
      return;
    }
    const content = data?.choices?.[0]?.message?.content || '';
    // 剥掉模型的 ``` 代码围栏拿到净 HTML
    const html = content.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
    ok(res, { html, content, diagnose: inspectTemplate(html), usage: data.usage ?? null });
  } catch (err) {
    res.status(500).json({ code: 500, message: `调用模型服务失败：${err.message}` });
  }
});

/** 当前生效配置的体检，与启动横幅同一份判定，日志与页面结论一致；findings 已是可展示中文。纯读、永远 200，不回口令/路径/私钥。 */
platformApi.get('/config-check', (_req, res) => {
  const findings = checkConfig();
  ok(res, {
    findings,
    fatal: Boolean(fatalMessage(findings)),
    summary: summarizeConfig(),
    factory_password: factoryPasswordInUse(),
    panel_exposed: panelExposed(),
    // 一并回建站闸门原因，前端据此把新建网站按钮置灰，不必等 409
    deployment_block: deploymentBlockReason(),
    login_security: loginSecurityStatus(),
  });
});

/** 保留期清理体检：会删哪些、还剩多少、下次何时跑；只 SELECT 与 stat，不删东西。withFiles 会 stat 目录每个文件，比普通只读重，按需调用不轮询；未启用时 enabled=false 而非报错。 */
platformApi.get('/maintenance/status', (_req, res) => {
  ok(res, retentionStatus({ withFiles: true }));
});

/** 手动跑一次保留期清理。dry_run 只算不删也不写审计，真删写 plan、applied 两条 data.prune，清理不动 audit_logs；actor 取当前用户、ip 取 clientIp，定时器那条才是 null。清理不是投放动作，不受投放门禁。 */
platformApi.post('/maintenance/run', requireAdmin, (req, res) => {
  try {
    const summary = runRetentionSweep({
      actor: req.session?.username || null,
      ip: clientIp(req),
      dryRun: req.body?.dry_run === true,
    });
    ok(res, summary);
  } catch (err) {
    // 清理失败回 500，不吞成 200
    res.status(500).json({ code: 500, message: '保留期清理失败：' + err.message });
  }
});

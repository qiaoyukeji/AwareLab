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

export const platformApi = express.Router();

const SECRET_MASK = '******';
const AI_DEFAULT = { providers: [], api_key: '' };
const PUSH_DEFAULT = { enabled: false, channels: [], redact: true };

/**
 * 推送渠道出口校验：明文 http 只放行本机回环（本地联调与自动化验证走的就是这条路），
 * 把员工上钩事件连同机器人令牌用 http 寄往公网，等于在演练数据之外再造一条外流通道。
 */
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
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
    return `推送地址 ${host} 走明文 http，会把演练事件和机器人令牌一并暴露；请改用 https 的机器人地址`;
  }
  return `推送地址协议不支持：${parsed.protocol}`;
}

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

/** 密钥只在本机与服务端之间流转：读取一律掩码，避免明文进浏览器内存与网络面板 */
function maskSecrets(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const masked = { ...cfg };
  if (masked.api_key) masked.api_key = SECRET_MASK;
  if (Array.isArray(masked.providers)) {
    masked.providers = masked.providers.map((p) => (p && p.api_key ? { ...p, api_key: SECRET_MASK } : p));
  }
  return masked;
}

/**
 * 设置界面拿到的是掩码，回填时提交的也是掩码，
 * 因此「key 为空或等于掩码」必须理解为「不改这枚密钥」，否则一次保存就把真 key 洗成星号。
 * 行身份优先用 id（保存时补齐并随掩码一起回显给界面），旧数据没有 id 时才按名称兜一次，
 * 否则改个厂商名字就会对不上号，把密钥静默清掉。
 */
function keepStoredKeys(next, prev) {
  const prevList = Array.isArray(prev?.providers) ? prev.providers : [];
  const byId = new Map(prevList.filter((p) => p?.id).map((p) => [p.id, p]));
  const byName = new Map(prevList.filter((p) => p?.name && !p.id).map((p) => [p.name, p]));
  const merged = { ...next };
  if (Array.isArray(next?.providers)) {
    merged.providers = next.providers.map((p) => {
      const old = (p?.id ? byId.get(p.id) : null) || byName.get(p?.name) || null;
      const row = { ...p, id: p?.id || old?.id || randomUUID() };
      if (!row.api_key || row.api_key === SECRET_MASK) {
        // 对不上号的掩码是没法还原的，留成空比留下一串星号诚实：界面会提示未设置，而不是发信时才发现
        row.api_key = old?.api_key === SECRET_MASK ? '' : old?.api_key || '';
      }
      return row;
    });
  }
  if ((!merged.api_key || merged.api_key === SECRET_MASK) && prev?.api_key) merged.api_key = prev.api_key;
  return merged;
}

/**
 * 审计只回答"谁在什么时候改了哪个键、动了哪些字段"，
 * 它不该变成第二份密钥存放地：模型 Key 只记有没有配，机器人地址只记掩码后的那条。
 */
function settingsAuditDetail(key, value) {
  if (key === 'ai') {
    return {
      providers: (value?.providers || []).map((p) => ({
        name: p?.name ?? null,
        base_url: p?.base_url ? maskUrl(p.base_url) : null,
        has_api_key: Boolean(p?.api_key && p.api_key !== SECRET_MASK),
      })),
    };
  }
  if (key === 'push') {
    return {
      enabled: Boolean(value?.enabled),
      redact: value?.redact !== false,
      channels: (value?.channels || []).map((c) => ({ type: c?.type ?? null, url: c?.url ? maskUrl(c.url) : null, events: c?.events ?? null })),
    };
  }
  return { value: String(JSON.stringify(value ?? null)).slice(0, 500) };
}

platformApi.get('/settings', (_req, res) => {
  ok(res, {
    push: getSetting('push', PUSH_DEFAULT),
    ai: maskSecrets(getSetting('ai', AI_DEFAULT)),
    capture_port_range: config.capture.port_range,
    mail_default_dry_run: config.mail.default_dry_run,
    require_authorization: config.exercise.require_authorization,
    panel_path: config.panel.path,
    panel_port: config.panel.port,
    db_driver: driver,
    db_path: config.paths.db,
  });
});

platformApi.put('/settings/:key', (req, res) => {
  const incoming = req.body?.value;
  // 没有 value 的写入会把该键存成 undefined，读出来直接是空配置，必须拒掉而不是静默清空
  if (incoming === undefined) return badRequest(res, '缺少要保存的配置值');
  if (req.params.key === 'ai') {
    const merged = keepStoredKeys(incoming, getSetting('ai', AI_DEFAULT));
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
    setSetting('push', { ...PUSH_DEFAULT, ...incoming });
    writeAudit(req, 'settings.update', {
      targetKind: 'setting',
      targetId: 'push',
      detail: settingsAuditDetail('push', { ...PUSH_DEFAULT, ...incoming }),
    });
    return ok(res, getSetting('push', PUSH_DEFAULT));
  }
  setSetting(req.params.key, incoming);
  writeAudit(req, 'settings.update', { targetKind: 'setting', targetId: req.params.key, detail: settingsAuditDetail(req.params.key, incoming) });
  ok(res, getSetting(req.params.key));
});

platformApi.get('/push-logs', (req, res) => {
  const { page, page_size } = paginate(req.query);
  ok(res, pagedRows('push_logs', '', [], page, page_size));
});

/**
 * 产出的是 AwareLab 采集页：声明式绑定取代手写上报代码，
 * 模型只需要把字段与视觉写好，采集由平台接管。
 */
const buildPrompt = (siteName, fields) => `请生成一个「${siteName}」的网页模板（HTML）。
要求：
1. 页面用一个 <form> 承载表单，收集以下字段：${fields.join('、') || '账号/密码'}，每个输入控件都要写 name 属性。
2. 提交按钮写 data-al-collect 属性，不要写任何上报脚本，也不要写 onclick。
3. 仅返回完整可用的 HTML 代码，使用内嵌 CSS，不要添加外部 js/css 链接、不要额外说明、不需要 JS 的例子。`;

/** 文件名后缀不算仿冒目标，否则提示词里的 index.html 会被当成域名拦下 */
const FILE_SUFFIX = new Set([
  'html', 'htm', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'css', 'json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'lock',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'txt', 'md', 'xml', 'eml', 'pdf',
  'zip', 'gz', 'tar', 'mp4', 'webm', 'sql', 'log', 'bak', 'sh', 'bat', 'ps1',
]);

/** 从自由文本里摘出「像主机名」的片段：点分域名或点分 IP */
function hostTokens(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi)) {
    const host = match[0].toLowerCase();
    const labels = host.split('.');
    if (FILE_SUFFIX.has(labels[labels.length - 1])) continue;
    if (labels.some((label) => label.length > 63)) continue;
    found.add(host);
  }
  return [...found];
}

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * 仿站是把"要仿冒谁"写给外部模型的入口，因此它和建站、发信共用同一道门禁：
 * 没有生效授权就不许调用；文本里出现的主机必须已在授权名单里；员工邮箱一律不许外发。
 */
function cloneScopeProblem(siteName, prompt) {
  const auth = findActive();
  if (!auth) return { code: 403, message: DEPLOY_MESSAGE };
  const text = `${siteName || ''}\n${prompt || ''}`;
  if (EMAIL_PATTERN.test(text)) {
    return { code: 400, message: '提示词里出现了邮箱地址。仿站目标请用域名或 IP 表达，真实员工邮箱不发给外部模型。' };
  }
  const outside = hostTokens(text).filter((host) => !isHostAuthorized(auth, host));
  if (outside.length) {
    return { code: 400, message: `目标主机 ${outside.join('、')} 不在授权名单内，已拒绝服务。请先在「演练授权」登记，或改用名单内的地址。` };
  }
  return null;
}

/** 模型服务地址：公网一律 https，只有本机回环允许明文 http（本地联调与自动化验证要用） */
function providerUrlProblem(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw));
  } catch {
    return `模型服务地址不是合法 URL：${raw}`;
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
    return `模型服务地址 ${host} 走明文 http，API Key 会裸奔在链路上；请改用 https，或用本机回环地址做本地联调`;
  }
  return `模型服务地址协议不支持：${parsed.protocol}`;
}

platformApi.post('/ai/generate', async (req, res) => {
  const siteName = req.body?.site_name || '登录页';
  const fields = Array.isArray(req.body?.fields) ? req.body.fields.filter(Boolean) : [];
  const prompt = req.body?.prompt?.trim() || buildPrompt(siteName, fields);
  const scope = cloneScopeProblem(siteName, prompt);
  if (scope) return fail(res, scope.code, scope.message);
  const cfg = getSetting('ai', { providers: [] });
  const providers = cfg.providers || [];
  const provider = providers.find((p) => p.id === req.body?.provider_id) || providers[0];
  if (!provider?.base_url || !provider?.api_key) {
    return badRequest(res, '请先在「系统设置 - 模型服务」中配置厂商与 API Key');
  }
  const urlProblem = providerUrlProblem(provider.base_url);
  if (urlProblem) return badRequest(res, urlProblem);
  const url = `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key}` },
      body: JSON.stringify({
        model: provider.model || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: Number(req.body?.temperature ?? 0.4),
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(502).json({ code: 502, message: `模型服务返回 ${upstream.status}`, data });
      return;
    }
    const content = data?.choices?.[0]?.message?.content || '';
    const html = content.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
    ok(res, { html, content, diagnose: inspectTemplate(html), usage: data.usage ?? null });
  } catch (err) {
    res.status(500).json({ code: 500, message: `调用模型服务失败：${err.message}` });
  }
});

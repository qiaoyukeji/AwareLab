/**
 * 取证落库层：采集面与信标面看到的一切都从这里进数据库。
 * 存的是访客填的明文凭据，本层不往响应、日志或推送里复制它，出口只有管理面与证据导出。
 * (kind, token) 只是逻辑主键、没有唯一索引，findRecord 靠先查后插，同一终端并发上报会各插一条。
 */
import { get, run, nowIso, parseJson } from '../platform/storage/rows.js';
import { probe } from './uaProbe.js';
import { pushEvent, pushFields, pushTarget } from '../notify/notifier.js';

/**
 * form_json 存提交历史数组而不是最新快照：同一终端会被反复钓多次，覆盖写就丢了线索。
 * 只留最近 50 条，再多会拖垮导出。页面提交写 ev=submit、附件回传写 ev=callback 共用这套结构，改它会同时砸到证据页和导出。
 */
const MAX_HISTORY_ENTRIES = 50;

/**
 * 同一枚令牌一分钟内重复推送同一条文案就不再发：图片代理、预览面板会把同一个像素重放很多次，
 * 每放一次推一次等于把通知面变成放大器。文案变了（比如刚关掉脱敏）仍照发，那是有新信息。
 */
const RECENT_PUSH = new Map();
const PUSH_DEDUPE_MS = 60_000;

function pushOnce(key, text) {
  const now = Date.now();
  const prev = RECENT_PUSH.get(key);
  if (prev && prev.text === text && now - prev.at < PUSH_DEDUPE_MS) return false;
  RECENT_PUSH.set(key, { text, at: now });
  if (RECENT_PUSH.size > 2000) {
    for (const [k, v] of RECENT_PUSH) if (now - v.at > PUSH_DEDUPE_MS) RECENT_PUSH.delete(k);
  }
  pushEvent('mail_open', text);
  return true;
}

/** events 记一条原始事件，不清理不过期；空值落 NULL 不落空串。payload 会 JSON 序列化，别塞整段请求头；SQL 异常直接上抛。 */
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

/** records.feature_json 形状固定：ipv4 放地址、ipv6 留空串占位（列缺位会让证据页和导出按 undefined 渲染），os/browser 由 uaProbe 分类。 */
function fingerprint(ip, userAgent, extra = {}) {
  const cls = probe(userAgent);
  return {
    ipv4: ip,
    ipv6: '',
    'user-agent': userAgent,
    os: cls.os,
    browser: cls.browser,
    // 允许入口自己声明 ip 之外的标识，但不许改 os/browser，那会绕开 UA 判定让看板分组失真
    ...extra,
  };
}

/**
 * 取不到就建最小行再读回来。kind 是 web 或 mail：同一枚令牌在两个面各留一条，打开页面和打开邮件是两件不同的事实，合成一条就没法分开算转化率。
 * 先查后插不是原子的；token 为空时调用方传随机 UUID，本来就是单次请求一条记录。
 */
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

/** 令牌换成签发时的归属行；null 表示不是本平台签发的，据此区分匿名访客和带收件人身份的终端。空串一律当 null。 */
export function resolveToken(token) {
  if (!token) return null;
  return get('SELECT * FROM capture_tokens WHERE token=?', [token]);
}

/** 归属查询别名，与"令牌有效吗"分开写，让那层判断留在调用方。 */
function targetOf(token) {
  return resolveToken(token);
}

/**
 * 摊平成 [{name, value, at}] 供证据页与导出用。解析失败给空数组不抛错：一条坏记录不该让整份证据导不出来。
 * 两代格式都要认：新格式带 fields 映射和时间戳 at，旧格式带 record_content 数组和 record_time，库里混存，只兼容不迁移。
 */
export function flattenHistory(rawFormJson) {
  const parsed = parseJson(rawFormJson, []);
  // form_json 是文本列，值可能是对象、null 或半截 JSON；只有数组形态才是提交历史，不猜形状
  if (!Array.isArray(parsed)) return [];
  const flat = [];
  const push = (name, value, at) => {
    // 多选框和同名重复字段存成数组，每个值单独一行，否则导出一格里是数组，看不出访客勾了什么
    if (Array.isArray(value)) {
      for (const item of value) push(name, item, at);
      return;
    }
    flat.push({
      name: String(name),
      // 对象值序列化成 JSON 文本，直接渲染成 [object Object] 取证线索就没了
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
        // 字段名是采集点的身份，缺了它这条记录无法解释
        if (!field || typeof field !== 'object' || field.name === undefined) continue;
        push(field.name, field.value, at);
      }
    } else if (source && typeof source === 'object') {
      for (const [name, value] of Object.entries(source)) push(name, value, at);
    }
  }
  return flat;
}

/**
 * 页面被打开（协议 v2 的 ev=open），计入打开数。href 只该是路径，带查询串会把 ?tk= 写进取证记录。
 * records(kind=web) 建档或刷新 last_seen_at 与 feature_json，events 写 page_open，按设置推一次群机器人；返回建档快照，本函数不判授权。
 */
export function recordPageOpen({ siteId, token, ip, userAgent, referer, href }) {
  const visitor = targetOf(token);
  // 令牌为空时造一个随机身份：裸访问也要能算打开数，但这类记录归不到人头上，别当上钩终端统计
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

/**
 * 表单被填写（ev=submit）：追加一条采集历史并算停留时长，fields 是运行时 collect() 交回的键值映射（字段名可能是中文）。
 * records(kind=web) 刷新 submitted_at / dwell_seconds / form_json / feature_json，target_email 用 COALESCE 补不冲掉已有归属；capture_tokens 标 submitted_at，令牌属于邮件收件人时同步回填 mail_recipients；events 写 form_fill；群推送里字段名默认只报数量。
 */
export function recordFormSubmit({ siteId, token, ip, userAgent, fields, dwell, referer, href }) {
  const visitor = targetOf(token);
  const rec = findRecord('web', token || crypto.randomUUID(), {
    site_id: siteId,
    task_id: visitor?.task_id ?? null,
    target_email: visitor?.target_email ?? null,
  });
  const now = nowIso();
  const first = rec.first_seen_at || now;
  // dwell 缺失或 NaN 时退回"首次见到此刻"的差值；没有这一列就分不出秒填和琢磨半天的终端
  const dwellSeconds = Number.isFinite(dwell) && dwell >= 0
    ? Math.round(dwell)
    : Math.max(0, Math.round((Date.now() - new Date(first).getTime()) / 1000));

  const history = parseJson(rec.form_json, []);
  const entries = Array.isArray(history) ? history : [];
  // 追加而不是覆盖，slice 保证单条记录不会无限膨胀
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
    // 只写 records 不写这里，专属链接的完成情况会永远显示未完成
    run('UPDATE capture_tokens SET submitted_at=?, first_seen_at=COALESCE(first_seen_at,?) WHERE token=?', [now, now, token]);
  }
  // 令牌是从邮件签发的（capture_tokens.task_id 有值），收件人那一行也要跟着上钩：
  // 邮件漏斗只读 mail_recipients.submitted_at，不回填就会出现整体中招率算到人、邮件转化率却是 0%
  if (visitor?.task_id && token) {
    run('UPDATE mail_recipients SET submitted_at=COALESCE(submitted_at,?) WHERE task_id=? AND token=?', [now, visitor.task_id, token]);
  }
  logEvent('form_fill', { ref_id: rec.id, token, ip, user_agent: userAgent, payload: { fields } });
  pushEvent('form_fill', `网页填写 | 站点=${siteId} | ${pushTarget(visitor?.target_email)} | 字段=${pushFields(fields)}`);
  return get('SELECT * FROM records WHERE id=?', [rec.id]);
}

/**
 * 邮件被打开：像素与追踪链接共用这条口径（点链接本身就是一次打开）。taskId 可空时用签发时的归属补，opened_at 落首次时间。
 * 预览和图片代理会把同一个像素重放好几次，所以 opened_at 用 COALESCE 只认第一次：打开过是布尔事实不是次数。
 */
export function recordMailOpen({ taskId, token, ip, userAgent }) {
  const visitor = targetOf(token);
  // 首次打开才记事件与推送：图片代理、预览面板会把同一个像素重放很多次，
  // 以前每放一次就写一条 mail_open 事件并往外推一次通知，等于把信标变成放大器
  const existed = token ? get('SELECT id FROM records WHERE kind=? AND token=?', ['mail', token]) : null;
  const rec = findRecord('mail', token || crypto.randomUUID(), {
    task_id: taskId ?? visitor?.task_id ?? null,
    site_id: null,
    target_email: visitor?.target_email ?? null,
  });
  const now = nowIso();
  run('UPDATE records SET last_seen_at=? WHERE id=?', [now, rec.id]);
  // WHERE 带上 task_id：token 只在任务内唯一（(task_id, token) 联合唯一），少了会连累别的任务的同名令牌
  run('UPDATE mail_recipients SET opened_at=COALESCE(opened_at,?) WHERE task_id=? AND token=?', [now, taskId ?? visitor?.task_id ?? null, token]);
  if (!existed) {
    logEvent('mail_open', { ref_id: rec.id, token, ip, user_agent: userAgent });
  }
  pushOnce(rec.id, `邮件打开 | 任务=${taskId ?? '未知'} | ${pushTarget(visitor?.target_email)}`);
  return rec;
}

/**
 * 只刷新 clicked_at 并记一条事件，不建 records 行；返回已有的 mail 记录，可能为 null，调用方不靠它做放行判断。
 * 点击不推送：群里刷屏会淹掉上钩通知。
 */
export function recordMailClick({ taskId, token, ip, userAgent, url }) {
  const rec = get('SELECT * FROM records WHERE kind=? AND token=?', ['mail', token]);
  // 没有任务归属就不碰收件人表：归属对不上时宁可留空，也别把点击算到不相干的收件人头上；事件照记
  // 这里的 WHERE 只有 token（上面 opened_at 是 task_id+token），靠令牌全局唯一，跨任务重名只存在于历史脏数据
  if (taskId) run('UPDATE mail_recipients SET clicked_at=COALESCE(clicked_at,?) WHERE token=?', [nowIso(), token]);
  logEvent('mail_click', { ref_id: rec?.id ?? null, token, ip, user_agent: userAgent, payload: { url } });
  return rec;
}

/**
 * 附件运行回调：追加一条 ev=callback 历史，首次回传打 submitted_at，screenshot_path 只认第一张，feature_json 标 source=attachment_callback。
 * created 表示是否该终端首次回传。闸门都在 beaconPlane 那边（429 / 413 / 400 / 410），到这里一律落库。
 */
export function recordAttachmentRun({ taskId, token, mail, fields, screenshotPath, ip, userAgent }) {
  const rec = findRecord('mail', token || crypto.randomUUID(), {
    task_id: taskId,
    // 载荷自述的 mail 优先，但回落到签发时的 target_email：载荷不可信，库里归属才是取证口径
    target_email: mail || targetOf(token)?.target_email || null,
  });
  // submitted_at 为空即此前没回传过，用它区分首次与重复
  const created = rec.submitted_at == null;
  const now = nowIso();
  const history = parseJson(rec.form_json, []);
  const entries = Array.isArray(history) ? history : [];
  entries.push({ at: now, ev: 'callback', fields });
  // 都用 COALESCE：重复回传只补第一次没有的东西，后到的载荷不能顶掉已确认的时间戳和第一张截图
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

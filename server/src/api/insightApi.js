import express from 'express';
import { all, get, parseJson } from '../platform/storage/rows.js';
import { ok } from '../platform/net/envelope.js';
import { findActive } from '../security/mandate.js';
import { probe } from '../capture/uaProbe.js';

export const insightApi = express.Router();

const DAY_MS = 86400000;
const TREND_DAYS = 7;
const BIGSCREEN_EVENT_LIMIT = 50;

function countBy(rows, pick) {
  const buckets = {};
  for (const row of rows) {
    const key = pick(row);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return buckets;
}

const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0);

function webStats(webRecords) {
  const opened = webRecords.filter((r) => r.first_seen_at).length;
  const submitted = webRecords.filter((r) => r.submitted_at).length;
  return { opened, not_submitted: opened - submitted, submitted };
}

/** 特征列已带系统/浏览器时直接汇总，历史数据只有 UA 原文时按现在的规则补算 */
function deviceBuckets(webRecords) {
  const fingerprints = webRecords.map((r) => {
    const feature = parseJson(r.feature_json) || {};
    return feature.os ? { os: feature.os, browser: feature.browser } : probe(feature['user-agent'] || '');
  });
  return { os_buckets: countBy(fingerprints, (f) => f.os), browser_buckets: countBy(fingerprints, (f) => f.browser) };
}

function trend(webRecords) {
  const days = [];
  for (let offset = TREND_DAYS - 1; offset >= 0; offset--) {
    const day = new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
    const ofDay = webRecords.filter((r) => (r.first_seen_at || '').slice(0, 10) === day);
    days.push({
      date: day,
      opened: ofDay.length,
      submitted: ofDay.filter((r) => r.submitted_at).length,
      not_submitted: ofDay.filter((r) => !r.submitted_at).length,
    });
  }
  return days;
}

function mailStats() {
  const taskIds = all('SELECT id FROM mail_tasks').map((t) => t.id);
  const recipients = taskIds.length
    ? all(`SELECT * FROM mail_recipients WHERE task_id IN (${taskIds.map(() => '?').join(',')})`, taskIds)
    : [];
  const opened = recipients.filter((r) => r.opened_at).length;
  const submitted = recipients.filter((r) => r.submitted_at).length;
  return { recipients: recipients.length, opened, submitted, conversion: rate(submitted, recipients.length) };
}

insightApi.get('/stats/home', (_req, res) => {
  const sites = all('SELECT * FROM web_sites');
  const templates = all('SELECT id, name, type FROM web_templates');
  const webRecords = all("SELECT * FROM records WHERE kind='web'");
  const { opened, not_submitted, submitted } = webStats(webRecords);
  const conversion = rate(submitted, opened);

  ok(res, {
    basic: {
      running_sites: sites.filter((s) => s.status === 'open').length,
      listen_ports: [...new Set(sites.filter((s) => s.status === 'open').map((s) => s.listen_port))],
      web_template_count: templates.length,
      template_types: [...new Set(templates.map((t) => t.type))],
      // 风险评分：中招率越低分数越高，100 表示全员未提交
      risk_score: Math.max(0, Math.min(100, 100 - conversion)),
      risk_level: (() => {
        const score = Math.max(0, Math.min(100, 100 - conversion));
        return score >= 90 ? '安全' : score >= 70 ? '需关注' : '高风险';
      })(),
      authorization: findActive()?.scope ?? null,
    },
    web_stats: { opened, not_submitted, submitted, conversion, total_records: webRecords.length },
    mail_stats: mailStats(),
    ...deviceBuckets(webRecords),
    funnel: { opened, not_submitted, submitted },
    trend: trend(webRecords),
    site_overview: sites.map((site) => {
      const ofSite = webRecords.filter((r) => r.site_id === site.id);
      return {
        id: site.id,
        port: site.listen_port,
        status: site.status,
        template_name: templates.find((t) => t.id === site.template_id)?.name ?? '',
        opened: ofSite.length,
        submitted: ofSite.filter((r) => r.submitted_at).length,
      };
    }),
  });
});

insightApi.get('/stats/bigscreen', (_req, res) => {
  ok(res, {
    events: all('SELECT * FROM events ORDER BY created_at DESC LIMIT ' + BIGSCREEN_EVENT_LIMIT),
    sites: all('SELECT id, listen_port, domain, status FROM web_sites'),
    records: all(
      'SELECT id, kind, token, target_email, first_seen_at, submitted_at, dwell_seconds FROM records ORDER BY created_at DESC LIMIT ' +
        BIGSCREEN_EVENT_LIMIT
    ),
  });
});

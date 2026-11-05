/**
 * 素材库域（library）：把内置的页面/邮件/学习页整理成"模板市场"的样子，供前端素材页直接取用。
 *
 * 为什么单独一组接口而不是把内置数据塞进 /web-templates 列表：内置素材是只读目录，
 * 用户"使用"它时要么以它建站、要么复制成自己的可编辑副本；把目录和业务表混在一起，
 * 列表里就分不清哪条是出厂内容、哪条是操作员改过的，删除与恢复的语义也会打架。
 */
import express from 'express';
import crypto from 'node:crypto';
import { get, insert, nowIso } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { inspectTemplate } from '../capture/diagnostics.js';
import { PAGE_TEMPLATES, MAIL_TEMPLATES, LEARN_PAGES, PAGE_TYPES } from '../library/builtinTemplates.js';
import { restoreBuiltin, seedBuiltins } from '../library/seed.js';

export const libraryApi = express.Router();

/** 内置页面/邮件当前落到业务表里的行 id；没播种过的返回 null，前端据此显示"待安装" */
function installedId(table, key) {
  return get(`SELECT id FROM ${table} WHERE builtin_key=?`, [key])?.id ?? null;
}

/**
 * 已复制副本数：副本名固定是「原名（副本）」，按名字精确数即可。
 * 不用 template_id 判断是否复制过——播种行本身也有 id，那样每张卡都会显示"已复制"。
 */
function cloneCount(table, name) {
  return get(`SELECT COUNT(*) AS n FROM ${table} WHERE builtin_key IS NULL AND name=?`, [`${name}（副本）`])?.n ?? 0;
}

function diagnoseColumns(report) {
  const binding = report.checks.find((c) => c.key === 'binding');
  const trigger = report.checks.find((c) => c.key === 'trigger');
  const assets = report.checks.find((c) => c.key === 'assets');
  return {
    check_onclick: binding?.ok && trigger?.ok ? '通过' : '未通过',
    check_external: assets?.detail ?? '无外链',
    diagnose_json: JSON.stringify(report),
  };
}

/**
 * 目录：一次给全（9 个页面 + 8 封邮件 + 4 个学习页，正文合计约 100KB）。
 * 不在这里分页：卡片墙要一次画完，逐条拉正文会让首屏闪 17 次。
 */
libraryApi.get('/library', (_req, res) => {
  ok(res, {
    types: PAGE_TYPES,
    pages: PAGE_TEMPLATES.map((item) => ({
      key: item.key,
      name: item.name,
      type: item.type,
      description: item.description,
      html: item.html,
      response_content: item.response_content,
      template_id: installedId('web_templates', item.key),
      clones: cloneCount('web_templates', item.name),
      diagnose: inspectTemplate(item.html),
    })),
    mails: MAIL_TEMPLATES.map((item) => ({
      key: item.key,
      name: item.name,
      subject: item.subject,
      description: item.description,
      body_html: item.body_html,
      template_id: installedId('mail_templates', item.key),
      clones: cloneCount('mail_templates', item.name),
    })),
    lessons: LEARN_PAGES.map((item) => ({
      key: item.key,
      name: item.name,
      html: item.html,
      template_id: installedId('learn_pages', item.key),
      clones: cloneCount('learn_pages', item.name),
    })),
  });
});

/** 手动补种：升级前就存在的老库、或操作员删掉内置条目之后，点一下就把缺的补回来（不覆盖已有） */
libraryApi.post('/library/seed', (_req, res) => {
  ok(res, seedBuiltins({ silent: true }));
});

/**
 * 复制内置素材成可编辑副本：内置条目本身不允许改名改正文（下次恢复会盖掉），
 * 想定制就复制一份，副本不带 builtin_key，普通增删改查都能用。
 */
libraryApi.post('/library/use', (req, res) => {
  const { kind, key, name } = req.body || {};
  if (!kind || !key) return badRequest(res, '缺少素材类型或标识');
  const now = nowIso();

  if (kind === 'page') {
    const source = PAGE_TEMPLATES.find((item) => item.key === key);
    if (!source) return notFound(res, '内置页面不存在');
    const report = inspectTemplate(source.html);
    const row = {
      id: crypto.randomUUID(),
      name: name || `${source.name}（副本）`,
      type: source.type,
      description: source.description,
      html: source.html,
      response_type: 'alert',
      response_content: source.response_content,
      learn_page_id: 'bt-lesson-identify',
      created_at: now,
      updated_at: now,
      builtin_key: null,
      ...diagnoseColumns(report),
    };
    insert('web_templates', row);
    return ok(res, { ...row, kind: 'page' });
  }

  if (kind === 'mail') {
    const source = MAIL_TEMPLATES.find((item) => item.key === key);
    if (!source) return notFound(res, '内置邮件不存在');
    const row = {
      id: crypto.randomUUID(),
      name: name || `${source.name}（副本）`,
      subject: source.subject,
      body_html: source.body_html,
      description: source.description,
      created_at: now,
      updated_at: now,
      builtin_key: null,
    };
    insert('mail_templates', row);
    return ok(res, { ...row, kind: 'mail' });
  }

  if (kind === 'lesson') {
    const source = LEARN_PAGES.find((item) => item.key === key);
    if (!source) return notFound(res, '内置学习页不存在');
    const row = { id: crypto.randomUUID(), name: name || `${source.name}（副本）`, html: source.html, created_at: now, builtin_key: null };
    insert('learn_pages', row);
    return ok(res, { ...row, kind: 'lesson' });
  }

  return badRequest(res, '素材类型只支持 page / mail / lesson');
});

/** 恢复出厂内容：操作员把内置条目改坏后的退路，按 builtin_key 精确定位，不动副本 */
libraryApi.post('/library/restore', (req, res) => {
  const { kind, key } = req.body || {};
  if (!kind || !key) return badRequest(res, '缺少素材类型或标识');
  const id = restoreBuiltin(kind, key);
  if (!id) return notFound(res, '该内置素材不存在');
  ok(res, { id, key });
});

/** 内置素材的当前正文（编辑抽屉里点"查看原文"时用，避免前端缓存过期副本） */
libraryApi.get('/library/html', (req, res) => {
  const { kind, key } = req.query;
  const table = kind === 'page' ? 'web_templates' : kind === 'mail' ? 'mail_templates' : kind === 'lesson' ? 'learn_pages' : null;
  if (!table) return badRequest(res, '素材类型只支持 page / mail / lesson');
  const row = get(`SELECT * FROM ${table} WHERE builtin_key=?`, [key]);
  if (!row) return notFound(res, '该内置素材尚未安装');
  ok(res, row);
});

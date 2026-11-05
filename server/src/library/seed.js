/**
 * 内置素材播种：把 library/builtinTemplates.js 的只读数据搬进业务表。
 *
 * 幂等口径：按 id 或 builtin_key 判存在，存在就整行跳过，不覆盖。原因很实际——操作员会把内置模板改成
 * 自己单位的品牌与话术，重启一次就还原等于白改；需要恢复原样时走 /library/restore 显式重置。
 * 播种放在进程启动阶段（建监听之前），所以第一次打开素材页就能看到内容，不需要先点"导入"。
 */
import { get, insert, nowIso, run } from '../platform/storage/rows.js';
import { inspectTemplate } from '../capture/diagnostics.js';
import { LEARN_PAGES, PAGE_TEMPLATES, MAIL_TEMPLATES } from './builtinTemplates.js';

/** 与 pageApi.diagnoseColumns 同一口径：摘要列给列表，完整报告进 diagnose_json */
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

/** 按 key 找已存在的内置行；id 固定成 bt-* 前缀，所以两种命中都算"已播种" */
function existing(table, id, key) {
  return get(`SELECT id, builtin_key FROM ${table} WHERE id=? OR builtin_key=?`, [id, key]);
}

/**
 * 播种内置素材，返回本次新增条数。silent 给启动路径用：只有真新增时才打一行，正常重启不刷屏。
 * 顺序固定：学习页 → 页面模板（引用学习页）→ 邮件模板。
 */
export function seedBuiltins({ silent = false } = {}) {
  const now = nowIso();
  const added = { lessons: 0, pages: 0, mails: 0 };

  for (const lesson of LEARN_PAGES) {
    if (existing('learn_pages', lesson.id, lesson.key)) continue;
    insert('learn_pages', {
      id: lesson.id,
      name: lesson.name,
      html: lesson.html,
      builtin_key: lesson.key,
      created_at: now,
    });
    added.lessons += 1;
  }

  for (const page of PAGE_TEMPLATES) {
    if (existing('web_templates', page.id, page.key)) continue;
    const report = inspectTemplate(page.html);
    insert('web_templates', {
      id: page.id,
      name: page.name,
      type: page.type,
      description: page.description,
      html: page.html,
      // 默认提交后弹提示：内置页不直接跳学习页，避免刚填完口令就暴露这是演练
      response_type: 'alert',
      response_content: page.response_content,
      learn_page_id: page.learn_page_id || 'bt-lesson-identify',
      created_at: now,
      updated_at: now,
      builtin_key: page.key,
      ...diagnoseColumns(report),
    });
    added.pages += 1;
  }

  for (const mail of MAIL_TEMPLATES) {
    if (existing('mail_templates', mail.id, mail.key)) continue;
    insert('mail_templates', {
      id: mail.id,
      name: mail.name,
      subject: mail.subject,
      body_html: mail.body_html,
      description: mail.description,
      builtin_key: mail.key,
      created_at: now,
      updated_at: now,
    });
    added.mails += 1;
  }

  const total = added.lessons + added.pages + added.mails;
  if (total && !silent) {
    console.log(`[library] 已写入内置素材：学习页 ${added.lessons}、页面 ${added.pages}、邮件 ${added.mails}`);
  }
  return added;
}

/**
 * 把一条内置素材恢复成出厂内容（操作员改坏了/删了正文之后的退路）。
 * 只处理 builtin_key 非空的行；返回 false 表示这条不是内置素材，调用方回 400。
 */
export function restoreBuiltin(kind, key) {
  const now = nowIso();
  if (kind === 'page') {
    const page = PAGE_TEMPLATES.find((item) => item.key === key);
    if (!page) return false;
    const row = existing('web_templates', page.id, page.key);
    const report = inspectTemplate(page.html);
    const patch = {
      name: page.name,
      type: page.type,
      description: page.description,
      html: page.html,
      response_content: page.response_content,
      updated_at: now,
      builtin_key: page.key,
      ...diagnoseColumns(report),
    };
    if (row) {
      run(
        'UPDATE web_templates SET name=?, type=?, description=?, html=?, response_content=?, updated_at=?, builtin_key=?, check_onclick=?, check_external=?, diagnose_json=? WHERE id=?',
        [
          patch.name,
          patch.type,
          patch.description,
          patch.html,
          patch.response_content,
          patch.updated_at,
          patch.builtin_key,
          patch.check_onclick,
          patch.check_external,
          patch.diagnose_json,
          row.id,
        ]
      );
      return row.id;
    }
    insert('web_templates', {
      id: page.id,
      name: page.name,
      type: page.type,
      description: page.description,
      html: page.html,
      response_type: 'alert',
      response_content: page.response_content,
      learn_page_id: 'bt-lesson-identify',
      created_at: now,
      updated_at: now,
      builtin_key: page.key,
      ...diagnoseColumns(report),
    });
    return page.id;
  }

  if (kind === 'mail') {
    const mail = MAIL_TEMPLATES.find((item) => item.key === key);
    if (!mail) return false;
    const row = existing('mail_templates', mail.id, mail.key);
    if (row) {
      run('UPDATE mail_templates SET name=?, subject=?, body_html=?, description=?, updated_at=? WHERE id=?', [
        mail.name,
        mail.subject,
        mail.body_html,
        mail.description,
        now,
        row.id,
      ]);
      return row.id;
    }
    insert('mail_templates', {
      id: mail.id,
      name: mail.name,
      subject: mail.subject,
      body_html: mail.body_html,
      description: mail.description,
      builtin_key: mail.key,
      created_at: now,
      updated_at: now,
    });
    return mail.id;
  }

  if (kind === 'lesson') {
    const lesson = LEARN_PAGES.find((item) => item.key === key);
    if (!lesson) return false;
    const row = existing('learn_pages', lesson.id, lesson.key);
    if (row) {
      run('UPDATE learn_pages SET name=?, html=? WHERE id=?', [lesson.name, lesson.html, row.id]);
      return row.id;
    }
    insert('learn_pages', { id: lesson.id, name: lesson.name, html: lesson.html, builtin_key: lesson.key, created_at: now });
    return lesson.id;
  }

  return false;
}

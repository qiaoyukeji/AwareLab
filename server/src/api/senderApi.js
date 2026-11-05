// 发信通道管理域（smtp_profiles）：SMTP 发信账号的增删改查与连通测试，登记它就是拿到一个可群发的名义。
// 不过授权门禁（登记不发信），门禁在 campaignApi 投递链路那一侧。
// pass 列出口全程掩码（MASK），审计只记 pass_changed 布尔，凭据不经浏览器/网络面板/审计表二次泄露。
// 编辑表单拿不到明文口令，所以"请求不带 pass"要理解成"不改口令"而不是"清空"。
import express from 'express';
import { all, get, insert, nowIso, run, update } from '../platform/storage/rows.js';
import { ok, badRequest, notFound } from '../platform/net/envelope.js';
import { writeAudit } from '../security/audit.js';
import { testProfile } from '../mail/transport.js';

export const senderApi = express.Router();

// 所有出接口里 pass 列的统一替身：真口令永远不离开服务端
const MASK = '******';

/** 账号列表：按创建时间倒序，行内 pass 已换成 MASK。列表页与发信下拉只需要知道有这么个账号。 */
senderApi.get('/smtp-profiles', (_req, res) => {
  // 只回掩码：SMTP 口令不进前端状态，避免在浏览器内存与网络面板里二次泄露
  const rows = all('SELECT * FROM smtp_profiles ORDER BY created_at DESC').map((r) => ({ ...r, pass: MASK }));
  ok(res, { rows, total: rows.length });
});

/**
 * 登记一个发信通道。host/user/from_addr 必填缺一回 400（发信地址与 SMTP 登录账号可以不同）。
 * pass 明文入库（投递链路要拿它登录，信任本机 data 目录），允许空。内网有些网关不做 SMTP AUTH，防线全在出口与审计侧。
 * 审计 smtp.create 记 host/port/secure/user/from_addr，刻意不含 pass。
 */
senderApi.post('/smtp-profiles', (req, res) => {
  const b = req.body || {};
  if (!b.host || !b.user || !b.from_addr) return badRequest(res, 'SMTP 主机、账号、发信地址必填');
  const row = {
    id: crypto.randomUUID(),
    name: b.name || b.from_addr,
    host: b.host,
    port: Number(b.port) || 465,
    secure: b.secure ? 1 : 0,
    user: b.user,
    pass: b.pass || '',
    from_addr: b.from_addr,
    from_name: b.from_name || null,
    created_at: nowIso(),
  };
  insert('smtp_profiles', row);
  // 登记发信通道就是拿到一个可群发的名义，动作必须留痕；口令永不进审计
  writeAudit(req, 'smtp.create', {
    targetKind: 'smtp_profile',
    targetId: row.id,
    detail: { host: row.host, port: row.port, secure: Boolean(row.secure), user: row.user, from_addr: row.from_addr },
  });
  ok(res, { ...row, pass: MASK });
});

/**
 * 编辑只覆盖提交的字段：pass 是掩码前端拿不到原口令，所以"不带 pass"必须理解成"不改口令"，
 * 否则一次编辑就把凭据洗成星号。审计 smtp.update 只记改了哪些字段 + pass_changed 布尔，敏感值不落审计。
 * id 不存在先 404，合并后缺必填回 400。
 */
senderApi.put('/smtp-profiles/:id', (req, res) => {
  const current = get('SELECT * FROM smtp_profiles WHERE id=?', [req.params.id]);
  if (!current) return notFound(res, '发信账号不存在');
  const b = req.body || {};
  const patch = {};
  // 字段白名单：id/created_at 与 pass 不在这里，pass 走下面"非空才改"的专门通道
  for (const key of ['name', 'host', 'user', 'from_addr', 'from_name']) {
    if (b[key] !== undefined) patch[key] = b[key];
  }
  // 端口填了但解析不出数字时退回现值：手滑输入不该把一个能用的通道改成 0/NaN
  if (b.port !== undefined) patch.port = Number(b.port) || current.port;
  if (b.secure !== undefined) patch.secure = b.secure ? 1 : 0;
  // 假值（不传/空串）一律视为"不改口令"：编辑表单里口令框留空就是默认意图
  if (b.pass) patch.pass = b.pass;
  // 必填校验对着"合并后的完整行"做：一次只改几个字段，也不许把 host/账号/发信地址掏空
  const merged = { ...current, ...patch };
  if (!merged.host || !merged.user || !merged.from_addr) return badRequest(res, 'SMTP 主机、账号、发信地址必填');
  update('smtp_profiles', current.id, patch);
  // 重读写入侧实况再回给前端与审计：不要拿写之前的 patch 反推"库里现在长什么样"
  const fresh = get('SELECT * FROM smtp_profiles WHERE id=?', [current.id]);
  writeAudit(req, 'smtp.update', {
    targetKind: 'smtp_profile',
    targetId: current.id,
    // 口令以"是否更换"入审计，不落敏感值
    detail: {
      changed: Object.keys(patch),
      host: fresh.host,
      port: fresh.port,
      from_addr: fresh.from_addr,
      pass_changed: Boolean(patch.pass),
    },
  });
  ok(res, { ...fresh, pass: MASK });
});

/**
 * 连通性测试：拿库里凭据向 host 真实建立 SMTP 连接并登录验证（nodemailer verify），不发送任何邮件。
 * 不回显口令；账号不存在/连接被拒/认证失败统一折成 400。本域唯一 async 处理器，异常必须 catch 否则落 500。
 */
senderApi.post('/smtp-profiles/:id/test', async (req, res) => {
  try {
    ok(res, await testProfile(req.params.id));
  } catch (err) {
    badRequest(res, `SMTP 测试失败：${err.message}`);
  }
});

/**
 * 删除发信账号（物理删除）：先判 id 存在否则删 0 行也回成功。只删本行，历史投递结果不受影响；
 * 之后仍引用该通道的任务再投递会报"SMTP 配置不存在"，是预期行为。审计 smtp.delete 只留 host 与发信地址。
 */
senderApi.delete('/smtp-profiles/:id', (req, res) => {
  const current = get('SELECT * FROM smtp_profiles WHERE id=?', [req.params.id]);
  if (!current) return notFound(res, '发信账号不存在');
  run('DELETE FROM smtp_profiles WHERE id=?', [req.params.id]);
  // 只留主机与发信地址：审计表不该顺手复制一份 SMTP 凭据
  writeAudit(req, 'smtp.delete', { targetKind: 'smtp_profile', targetId: current.id, detail: { host: current.host, from_addr: current.from_addr } });
  ok(res, true);
});

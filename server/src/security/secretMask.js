/**
 * 采集内容的字段级脱敏：判定哪些表单字段属于凭据并换成掩码，列表/详情默认掩码，看明文只走 reveal 接口并写审计。
 * 只做读侧脱敏，绝不改写库里的 form_json（证据要保真）；掩码是不可逆固定串，不含长度信息。
 * 字段名来自访客表单、大小写写法千奇百怪，比对前统一小写并把 -/_/空格归一再走关键字与中文两套正则；判定宁宽勿窄，拿不准的一律当凭据掩掉。
 */

/** 掩码串：固定 8 个圆点，不反映原值长度 */
export const SECRET_MASK = '••••••••';

/** 归一化字段名：小写并把分隔符统一成下划线，让 card-cvv / Card CVV / card_cvv 走同一条规则；非字符串输入返回空串。 */
function normalize(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[\s.-]+/g, '_');
}

// 英文关键字：口令/一次性码/卡证/令牌/密保族，用包含而非相等匹配，真实表单是 user_password、sms_otp_code 这种拼法
const SECRET_WORD = /(pass|pwd|passwd|password|otp|mfa|2fa|code|pin|cvv|cvc|card|secret|token|credential|security_answer|secret_question)/;

// 中文字段名：仿冒页常用中文 label 当 name（一键仿站抓下来的页面尤其如此）
const SECRET_CN = /(密码|口令|验证码|动态码|校验码|银行卡|卡号|安全码|密保|私钥|密钥|凭证)/;

/**
 * 字段名是否属于该掩掉的凭据：只按字段名判不看值（按值猜会漏掉 p1 这种短键名），true 时读侧默认掩码、看明文走 reveal 并留审计。
 * code 也在名单里，会连带掩掉 zip_code、employee_code：误掩只是多点一次显示明文，漏掩会把验证码印进交付物，所以宁宽勿窄。
 */
export function isSecretField(name) {
  const key = normalize(name);
  if (!key) return false;
  return SECRET_WORD.test(key) || SECRET_CN.test(key);
}

/**
 * 把一组采集字段做成可对外展示的副本：凭据字段换成掩码，其余原样；返回新对象不改入参，非对象入参返回 {}。
 * 按 Object.keys 原序返回，前端表格与 CSV 的列顺序因此与采集时一致。
 */
export function maskFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  for (const [name, value] of Object.entries(fields)) {
    // 空值不掩：字段在但访客没填，显示掩码会让人误以为填了又被藏起来
    out[name] = isSecretField(name) && value !== '' && value != null ? SECRET_MASK : value;
  }
  return out;
}

/**
 * 邮箱部分掩码：保留首字符与完整域名、中间打星，如 z***@corp.example；空值返回占位串而非空串。
 * 保留域名是因为报告要按部门/子公司分组看中招率，只留首字符是不把员工身份印进多方流转的交付物。
 */
export function maskEmail(email) {
  const raw = String(email == null ? '' : email).trim();
  if (!raw) return '—';
  const at = raw.indexOf('@');
  if (at < 0) return `${raw.slice(0, 1)}***`;
  const local = raw.slice(0, at);
  return `${local.slice(0, 1)}***@${raw.slice(at + 1)}`;
}

/**
 * 把展平后的采集历史整条脱敏，并给每项标上是不是凭据；返回新数组不改入参。
 * flattenHistory 出的是数组、maskFields 收的是对象，形状不同但脱敏口径必须一致，列表/详情/甲方报告/交付 CSV 四处都走这条数组口径所以集中在这里；secret 标记随值返回，前端据此决定要不要给显示明文按钮。
 */
export function maskHistory(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const secret = isSecretField(item?.name);
    // 空值不掩，同 maskFields
    return { ...item, value: secret && item.value !== '' && item.value != null ? SECRET_MASK : item.value, secret };
  });
}

/** 一组采集字段里有几个属于凭据：报告与推送只报数量不报字段名，字段名本身就能说明钓的是什么。 */
export function countSecretFields(fields) {
  if (!fields || typeof fields !== 'object') return 0;
  return Object.keys(fields).filter((name) => isSecretField(name)).length;
}

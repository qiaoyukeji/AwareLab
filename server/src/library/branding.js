/**
 * 内置模板的"改成自己单位"工具：把虚构品牌与主色替换掉，省得操作员在几百行 HTML 里手改十几处。
 *
 * 为什么放在服务端而不是前端：复制内置模板这个动作本身就在服务端（POST /library/use），
 * 替换逻辑贴着落库那一步，别的入口（脚本、命令行、以后的批量导入）也能复用同一套口径。
 *
 * 只动两样东西：品牌名（含左上角的单字标识）与主色。版式、文案、字段名一律不改——
 * 改版式是设计工作，交给操作员复制之后自己动手，平台不猜。
 */
import { BUILTIN_BRAND, BUILTIN_MARK } from './builtinTemplates.js';

/** 主色只认 #rgb / #rrggbb 两种写法；别的一律当"没填"处理，不猜颜色名 */
function normalizeHex(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return '';
  if (raw.length === 4) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  return raw.toLowerCase();
}

/** 往黑里混：深色渐变端用，ratio 越大越深。内置模板的 accentDark 大致就是主色压暗 45% 的效果 */
function darken(hex, ratio) {
  const num = Number.parseInt(hex.slice(1), 16);
  const mix = (channel) => Math.max(0, Math.round(channel * (1 - ratio)))
    .toString(16)
    .padStart(2, '0');
  return `#${mix((num >> 16) & 255)}${mix((num >> 8) & 255)}${mix(num & 255)}`;
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 模板自己的主色：页面写在 CSS 变量 --brand 上，邮件写在表头的 background 上。
 * 读不到就返回空串——那种模板只替换品牌名，不碰颜色。
 */
export function templateAccent(html) {
  const source = String(html ?? '');
  return (
    /--brand:\s*(#[0-9a-f]{6})/i.exec(source)?.[1] ||
    /background:\s*(#[0-9a-f]{6})/i.exec(source)?.[1] ||
    ''
  );
}

/**
 * 把模板里的品牌与主色换掉，返回新 HTML。两个参数都缺省时原样返回，便于调用方无脑透传。
 * 品牌名超过 24 个字符会被截断：左上角那一栏放不下，长名字会把版式撑坏。
 */
export function applyBranding(html, { brand, accent } = {}) {
  let out = String(html ?? '');
  const nextBrand = typeof brand === 'string' ? brand.trim().replace(/\s+/g, ' ').slice(0, 24) : '';
  const nextAccent = normalizeHex(accent);

  if (nextBrand && nextBrand !== BUILTIN_BRAND) {
    out = out.split(BUILTIN_BRAND).join(nextBrand);
    // 单字标识只换页面上那一个 <div class="logo">，不做全文替换——正文里的"远"字不都是品牌
    const mark = [...nextBrand][0] || BUILTIN_MARK;
    out = out.replace(
      new RegExp(`(<div class="logo">)${escapeRe(BUILTIN_MARK)}(</div>)`),
      (_all, open, close) => `${open}${mark}${close}`
    );
  }

  if (nextAccent) {
    const sourceAccent = templateAccent(out);
    if (sourceAccent) {
      const dark = /--brand-dark:\s*(#[0-9a-f]{6})/i.exec(out)?.[1] || '';
      out = out.replace(new RegExp(escapeRe(sourceAccent), 'gi'), nextAccent);
      if (dark) out = out.replace(new RegExp(escapeRe(dark), 'gi'), darken(nextAccent, 0.45));
    }
  }

  return out;
}

/** 给前端"可改点"提示用：同一份模板，操作员真正需要动的那几处 */
export function editablePoints(kind, html) {
  const accent = templateAccent(html);
  if (kind === 'page') {
    return [
      `品牌名「${BUILTIN_BRAND}」`,
      accent ? `主色 ${accent.toUpperCase()}` : '主色',
      '标题与副标题',
      '表单字段（input name）',
      '提交后提示语',
    ];
  }
  if (kind === 'mail') {
    return ['品牌名', accent ? `主色 ${accent.toUpperCase()}` : '主色', '主题行', '正文与按钮文案', '落点路径'];
  }
  return ['标题与导语', '要点条目'];
}

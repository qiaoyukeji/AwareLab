<template>
  <!-- 品牌方块：64x64 手绘 SVG，只靠 viewBox 缩放，显示尺寸由外层 .lab-brand-mark 决定 -->
  <!-- role="img" 与 aria-label 给读屏用；图标本身承担品牌识别，不能当纯装饰去掉 -->
  <svg class="lab-brand-mark" viewBox="0 0 64 64" role="img" aria-label="AwareLab">
    <defs>
      <!-- 渐变 id 见脚本，每次实例化都换新值，避免同页两个实例串色 -->
      <linearGradient :id="gid" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1c2b39" />
        <stop offset="1" stop-color="#0d151d" />
      </linearGradient>
    </defs>
    <!-- 底板：x/y 内缩 1.5 配 stroke-width 2，让描边压在框内不被 viewBox 裁掉 -->
    <rect x="1.5" y="1.5" width="61" height="61" rx="15" :fill="`url(#${gid})`" stroke="#0f766e" stroke-width="2" />
    <!-- 水纹：左上角两道同心弧，只描边不填充 -->
    <g fill="none" stroke="#12897f" stroke-linecap="round">
      <path d="M22 8a14 14 0 0 1-14 14" stroke-width="3.4" />
      <path d="M29 8a21 21 0 0 1-21 21" stroke-width="2.6" />
    </g>
    <!-- 鱼钩：小圆是挂线结，竖线接钩身，9.5 半径的弧是钩弯，短斜线是倒刺 -->
    <g fill="none" stroke="#ffffff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="27" cy="15" r="3.4" />
      <path d="M27 18.4V34a9.5 9.5 0 0 0 19 0v-4.5" />
      <path d="M46 29.5 49.4 31.9" stroke-width="3.6" />
    </g>
  </svg>
</template>

<script setup>
/**
 * 品牌标记，纯 SVG，无 props / emits / 请求。尺寸由外层 CSS（panes.css 的 .lab-brand-mark）决定。
 * 只出现在登录页与顶栏，不要放进仿造的钓鱼页面向访客露出。
 */
// 渐变 id 随机取 6 位 base36：只为避免同页撞车，不承担安全语义
const gid = `al-tile-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
  <!-- 页头一行两栏：左边标题 + 说明，右边 ops 插槽放页面级按钮 -->
  <header class="lab-page-hd">
    <div>
      <h2 class="lab-page-title">{{ title }}</h2>
      <p class="lab-page-note">{{ note }}</p>
    </div>
    <div class="lab-page-ops"><slot name="ops" /></div>
  </header>
</template>

<script setup>
/**
 * 工作区页头，纯展示组件。样式来自 panes.css 的 .lab-page-*，改类名会同时影响 7 个页面。
 * 文案用操作员口径，专业术语只留在系统设置的协议文档页；note 是文本插值，传 HTML 会被转义。
 */
defineProps({
  // 主标题，与各工作区路由的 meta.title 同名，改文案时两边一起改
  title: { type: String, required: true },
  // 一句说明，讲清这页管什么、下一步去哪；.lab-page-note 限了 max-width，长了自动折行
  note: { type: String, default: '' },
});
</script>

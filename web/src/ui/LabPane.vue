<template>
  <!-- 面板三段：标题栏 / 内容 / 页脚 -->
  <section class="lab-pane" :class="{ 'lab-pane--flush': flush }">
    <!-- 有标题或有 ops 插槽时才渲染标题栏 -->
    <header v-if="title || $slots.ops" class="lab-pane-hd">
      <div>
        <span class="lab-pane-t">{{ title }}</span>
        <span v-if="hint" class="lab-hint" style="margin-left: 10px">{{ hint }}</span>
      </div>
      <div class="lab-pane-ops"><slot name="ops" /></div>
    </header>
    <div class="lab-pane-bd"><slot /></div>
    <footer v-if="$slots.ft" class="lab-pane-ft"><slot name="ft" /></footer>
  </section>
</template>

<script setup>
/**
 * 面板容器，只负责版式，不发请求、不碰 store。样式来自 panes.css 的 .lab-pane*，本组件无 <style>。
 * 三个插槽（默认/ops/ft）改一个就得扫一遍全部调用点。
 */
defineProps({
  // 留空且没有 ops 插槽时整条标题栏不渲染
  title: { type: String, default: '' },
  // 一句说明，讲清这一块的前置条件与后果
  hint: { type: String, default: '' },
  // 布尔开关：写裸属性 flush 即开启，写 flush="false" 是字符串不是布尔，消掉 .lab-pane-bd 的 14px 内边距让表格贴边
  flush: { type: Boolean, default: false },
});
</script>

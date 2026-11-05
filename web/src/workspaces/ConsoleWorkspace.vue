<template>
  <div class="lab-page">
    <PageHead title="演练总览" note="授权状态、素材齐不齐、实时命中情况都在这页；哪一步越界了，这里最先反映出来。" />
    <!-- gate 决定 BoardPane 授权卡的文案与灯色 -->
    <BoardPane :gate="gate" />
  </div>
</template>

<script setup>
/** 演练总览工作区外壳（路由 #/console，登录后默认落地页）：零请求，取数全在 console/BoardPane.vue。
 *  七个外壳形状统一（lab-page + PageHead + 面板），除 /screen 外管理面所有页面都走这套。 */
import PageHead from '../ui/PageHead.vue';
import BoardPane from './console/BoardPane.vue';

defineProps({ gate: { type: Object, default: null } });
</script>

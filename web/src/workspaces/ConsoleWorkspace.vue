<template>
  <div class="lab-page">
    <PageHead title="演练总览" note="授权状态、素材齐不齐、实时命中情况都在这页；哪一步越界了，这里最先反映出来。" />
    <BoardPane :gate="gate" />
  </div>
</template>

<script setup>
import PageHead from '../ui/PageHead.vue';
import BoardPane from './console/BoardPane.vue';

defineProps({ gate: { type: Object, default: null } });
</script>

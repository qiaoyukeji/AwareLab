<template>
  <div class="lab-page">
    <PageHead title="演练授权" note="平台能不能干活全看这里：授权主体、有效期、允许仿冒的域名三项齐备才解锁，吊销即全部停下。" />
    <MandatePane :gate="gate" />
  </div>
</template>

<script setup>
import PageHead from '../ui/PageHead.vue';
import MandatePane from './mandate/MandatePane.vue';

defineProps({ gate: { type: Object, default: null } });
</script>

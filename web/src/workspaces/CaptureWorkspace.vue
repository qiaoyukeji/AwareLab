<template>
  <div class="lab-page">
    <PageHead title="钓鱼网站" note="每个假登录页独占一个端口对外访问，只服务授权名单里的域名；保存即开始收集访客输入。" />
    <SitesPane :gate="gate" />
  </div>
</template>

<script setup>
import PageHead from '../ui/PageHead.vue';
import SitesPane from './capture/SitesPane.vue';

defineProps({ gate: { type: Object, default: null } });
</script>

<template>
  <router-link to="/mandate" class="lab-top-btn" :title="tip">
    <span class="lab-dot" :class="{ 'is-live': !!mandate }" />
    <span>{{ mandate ? `授权余 ${remain}` : '未授权 · 平台已锁' }}</span>
  </router-link>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ mandate: { type: Object, default: null } });

const remain = computed(() => {
  if (!props.mandate) return '';
  const hours = (new Date(props.mandate.end_at).getTime() - Date.now()) / 3600000;
  if (hours <= 0) return '已到期';
  if (hours < 24) return `${Math.max(1, Math.round(hours))} 小时`;
  return `${hours / 24 > 30 ? Math.round(hours / 24) : (hours / 24).toFixed(1)} 天`;
});

const tip = computed(() =>
  props.mandate ? `授权主体：${props.mandate.scope} · 允许仿冒 ${props.mandate.allowed_hosts?.length || 0} 个域名` : '还没有登记生效中的演练授权'
);
</script>

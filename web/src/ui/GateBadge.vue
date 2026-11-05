<template>
  <!-- 顶栏授权角标：整枚按钮就是通往演练授权的链接，操作员一眼看到锁/开 -->
  <router-link to="/mandate" class="lab-top-btn" :title="tip">
    <!-- 灰点=没有生效中的授权，绿点 .is-live=有；颜色语义在 panes.css 的 .lab-dot -->
    <span class="lab-dot" :class="{ 'is-live': !!mandate }" />
    <span>{{ mandate ? `授权余 ${remain}` : '未授权 · 平台已锁' }}</span>
  </router-link>
</template>

<script setup>
/**
 * 授权门禁状态角标，只读展示、不发请求；它是进入工作区前必须先确认的一栏。
 * mandate 由 AppShell 从授权列表里挑出 effective === 'active' 的那条传入，没有则传 null，用到 scope / end_at / allowed_hosts。
 * "未授权 · 平台已锁"必须照实说。放行判定在 server/src/security/mandate.js，这里绿点亮了也不代表后端会放过越权动作。
 */
import { computed } from 'vue';

// mandate 是 AppShell 30 秒轮询的快照，刚被吊销或刚过期的授权会在这段时间里显示成旧状态
const props = defineProps({ mandate: { type: Object, default: null } });

/**
 * 授权剩余时长的口语化写法。起点用 Date.now()，与后端 effectiveStatus 同口径；只算不提。
 * 24 小时内说小时并用 Math.max(1, …) 兜底，免得报"0 小时"像已过期；end_at 不可解析会算出 NaN，登记入口拦掉了，手改库则绕过。
 */
const remain = computed(() => {
  if (!props.mandate) return '';
  const hours = (new Date(props.mandate.end_at).getTime() - Date.now()) / 3600000;
  if (hours <= 0) return '已到期';
  if (hours < 24) return `${Math.max(1, Math.round(hours))} 小时`;
  return `${hours / 24 > 30 ? Math.round(hours / 24) : (hours / 24).toFixed(1)} 天`;
});

/**
 * 悬停提示摊开授权主体与允许仿冒的域名数，省掉一次点进授权页。
 * allowed_hosts 由后端 toView() 还原成数组，这里只取长度；域名数为 0 时后端不会让这条授权生效，看到 0 就是数据出了问题。
 */
const tip = computed(() =>
  props.mandate ? `授权主体：${props.mandate.scope} · 允许仿冒 ${props.mandate.allowed_hosts?.length || 0} 个域名` : '还没有登记生效中的演练授权'
);
</script>

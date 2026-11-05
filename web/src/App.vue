<!-- 管理端根组件：只放一个 router-view。 -->
<!-- 别在这里加包裹元素或路由过渡：AppShell 与观测大屏按整屏高度做 flex，多插一层就得重算高度。下面空的 script setup 是故意的。 -->
<template>
  <router-view />
</template>

<script setup></script>

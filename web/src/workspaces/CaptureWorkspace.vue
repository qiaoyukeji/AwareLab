<template>
  <div class="lab-page">
    <PageHead title="钓鱼网站" note="每个假登录页独占一个端口对外访问，只服务授权名单里的域名；保存即开始收集访客输入。" />
    <!-- 无标签页，直接挂唯一面板；gate 只决定面板顶部横幅文案，放行与否由服务端判 -->
    <SitesPane :gate="gate" />
  </div>
</template>

<script setup>
/** 钓鱼网站工作区薄外壳（路由 #/capture）：零请求，业务全在 capture/SitesPane.vue。
 *  gate 透传不是冗余：面板靠它显示警示条或授权状态条；放行判定永远在服务端。 */
import PageHead from '../ui/PageHead.vue';
import SitesPane from './capture/SitesPane.vue';

defineProps({ gate: { type: Object, default: null } });
</script>

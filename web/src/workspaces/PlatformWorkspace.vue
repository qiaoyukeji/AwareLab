<template>
  <div class="lab-page">
    <PageHead title="系统设置" note="授权硬边界、模型与通知通道都在这里；协议文档是给写模板和排查上报用的接口说明。" />
    <!-- tab 走 URL query，排查采集不上报时可发协议文档直达链接 -->
    <LabTabs v-model="tab" :items="TABS" />
    <!-- KeepAlive 保住未保存的表单改动，切回不重新请求 -->
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
/** 系统设置外壳（路由 #/platform）：config 读写 /settings（授权硬边界、模型 provider、通知通道、监听默认值），
 *  contract 纯静态渲染采集协议 v2 文档；?tab= 直接下标取组件，没登记只白屏不报错。
 *  协议文案是与 server 断言一起冻结的对接契约，改这里必须同步改那边；ConfigPane 只挂载时拉一次，外部改配置要点面板里的重新读取。 */
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import ConfigPane from './platform/ConfigPane.vue';
import ContractPane from './platform/ContractPane.vue';

defineProps({ gate: { type: Object, default: null } });

// 先可改的运行参数，后只读的协议文档
const TABS = [
  { key: 'config', label: '运行参数' },
  { key: 'contract', label: '协议文档' },
];
const PANES = { config: ConfigPane, contract: ContractPane };
const tab = useTab('config');
</script>

<template>
  <div class="lab-page">
    <PageHead title="系统设置" note="授权硬边界、模型与通知通道都在这里；协议文档是给写模板和排查上报用的接口说明。" />
    <LabTabs v-model="tab" :items="TABS" />
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import ConfigPane from './platform/ConfigPane.vue';
import ContractPane from './platform/ContractPane.vue';

defineProps({ gate: { type: Object, default: null } });

const TABS = [
  { key: 'config', label: '运行参数' },
  { key: 'contract', label: '协议文档' },
];
const PANES = { config: ConfigPane, contract: ContractPane };
const tab = useTab('config');
</script>

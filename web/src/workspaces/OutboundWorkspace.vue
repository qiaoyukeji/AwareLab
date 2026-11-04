<template>
  <div class="lab-page">
    <PageHead title="钓鱼邮件" note="发信邮箱是留存资产，发送任务是一次次演练。默认沙箱：只把邮件存成文件给你检查，不会真的寄出去。" />
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
import SenderPane from './outbound/SenderPane.vue';
import CampaignPane from './outbound/CampaignPane.vue';

defineProps({ gate: { type: Object, default: null } });

const TABS = [
  { key: 'sender', label: '发信邮箱' },
  { key: 'campaign', label: '发送任务' },
];
const PANES = { sender: SenderPane, campaign: CampaignPane };
const tab = useTab('campaign');
</script>

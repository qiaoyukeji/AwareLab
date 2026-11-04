<template>
  <div class="lab-page">
    <PageHead title="上钩记录" note="谁打开了页面、谁提交了什么、谁回传了附件，这里逐条可查；先按每一个钓鱼网页、每一封钓鱼邮件分组，点任意一行进入这组的全部上钩记录与详情。导出报表、通知发送记录，以及谁在平台上做过高危动作的操作审计都归档在这里。" />
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
import CapturePane from './evidence/CapturePane.vue';
import ExportPane from './evidence/ExportPane.vue';
import NotifyPane from './evidence/NotifyPane.vue';
import AuditPane from './evidence/AuditPane.vue';

defineProps({ gate: { type: Object, default: null } });

const TABS = [
  { key: 'capture', label: '网页与邮件分组' },
  { key: 'export', label: '导出报表' },
  { key: 'notify', label: '通知记录' },
  { key: 'audit', label: '操作审计' },
];
const PANES = { capture: CapturePane, export: ExportPane, notify: NotifyPane, audit: AuditPane };
const tab = useTab('capture');
</script>

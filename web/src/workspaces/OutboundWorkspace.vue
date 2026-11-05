<template>
  <div class="lab-page">
    <PageHead title="钓鱼邮件" note="发信邮箱是留存资产，发送任务是一次次演练。默认沙箱：只把邮件存成文件给你检查，不会真的寄出去。" />
    <!-- tab 走 URL query，可发直达链接 -->
    <LabTabs v-model="tab" :items="TABS" />
    <!-- KeepAlive 保住任务草稿（素材、收件人名单），切回不重新请求 -->
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
/** 钓鱼邮件外壳（路由 #/outbound）：邮箱是跨演练资产、任务是一次性投放，生命周期不同故分两面板。
 *  ?tab= 直接下标取组件，没登记的 key 是空白页不报错；沙箱兜底在服务端 campaignRunner，前端只负责置灰。 */
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import SenderPane from './outbound/SenderPane.vue';
import CampaignPane from './outbound/CampaignPane.vue';

// 无生效授权时用来禁发送类按钮，不是权限校验
defineProps({ gate: { type: Object, default: null } });

const TABS = [
  { key: 'sender', label: '发信邮箱' },
  { key: 'campaign', label: '发送任务' },
];
// TABS 与 PANES 同步，少一边就是空白标签
const PANES = { sender: SenderPane, campaign: CampaignPane };
// 缺省进发送任务，这是主行动入口
const tab = useTab('campaign');
</script>

<template>
  <div class="lab-page">
    <PageHead title="上钩记录" note="谁打开了页面、谁提交了什么、谁回传了附件，这里逐条可查；先按每一个钓鱼网页、每一封钓鱼邮件分组，点任意一行进入这组的全部上钩记录与详情。导出报表、通知发送记录，以及谁在平台上做过高危动作的操作审计都归档在这里。" />
    <!-- tab 写进 URL query，可发直达某一屏的链接 -->
    <LabTabs v-model="tab" :items="TABS" />
    <!-- KeepAlive 保住分组看板的筛选条件与滚动位置，取证时不用重筛 -->
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
/** 上钩记录外壳（路由 #/evidence）：四个只读证据面板，分组看板、导出 CSV、通知流水、操作审计。
 *  KeepAlive 切走再回不重新请求；?tab= 直接下标取组件，key 没登记只白屏不报错。
 *  明文口令出口在各面板自己（表单原文只在详情抽屉、导出 CSV 双留痕），别在外壳预取全部记录。 */
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import CapturePane from './evidence/CapturePane.vue';
import ExportPane from './evidence/ExportPane.vue';
import NotifyPane from './evidence/NotifyPane.vue';
import AuditPane from './evidence/AuditPane.vue';

// 证据只读，四个面板都不解释 gate，透传只为外壳形状统一
defineProps({ gate: { type: Object, default: null } });

// 标签顺序按取证动线：上钩 → 导出 → 通知 → 审计
const TABS = [
  { key: 'capture', label: '网页与邮件分组' },
  { key: 'export', label: '导出报表' },
  { key: 'notify', label: '通知记录' },
  { key: 'audit', label: '操作审计' },
];
// 新增证据出口要 TABS 与 PANES 同步登记，服务端还得有对应只读接口；
// GroupBoard 没声明 props，gate 以透传属性落到其根 div（变多根节点会冒 inheritAttrs 警告）
const PANES = { capture: CapturePane, export: ExportPane, notify: NotifyPane, audit: AuditPane };
// 没带 ?tab= 时进分组看板（主视图）
const tab = useTab('capture');
</script>

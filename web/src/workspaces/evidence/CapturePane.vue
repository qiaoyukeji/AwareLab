<template>
  <!-- active 为空停在分组看板（一行一个网站或一个任务），点开某行才换成那一组的记录列表 -->
  <GroupBoard v-if="!active" @open="open" />
  <!-- back 把状态清空就回到看板 -->
  <GroupRecords v-else :group="active" :gate="gate" @back="active = null" />
</template>

<script setup>
/**
 * 两段式下钻的控制器：只管看板与某一组之间切换，取数都在子组件里。
 * 看板数字与下钻列表同源（/records/groups 与 /records 的过滤条件是一对），改一处要改另一处。
 * 记录列表与详情默认掩码，明文只在 GroupRecords 里逐字段 reveal，这里不做预先拉全量记录。
 */
import { ref } from 'vue';
import GroupBoard from './GroupBoard.vue';
import GroupRecords from './GroupRecords.vue';

// 生效授权对象（AppShell 轮询得来），原样往下透传，本面板不判断
defineProps({ gate: { type: Object, default: null } });

// null = 停在分组看板，否则放那一组的聚合行；全部上钩记录用下面的 ALL_GROUP（没有 id，等于不加归属过滤）
const active = ref(null);

/**
 * 全部上钩记录这一档的静态替身：字段名照后端分组桶的形状对齐，否则 GroupRecords 直接取值会 undefined。
 * group:'all' 走不加归属过滤的分支，id 为 null 是没有 site_id/task_id 可筛，exists:true 让它不带载体已删除标记。
 */
const ALL_GROUP = {
  group: 'all',
  id: null,
  label: '全部上钩记录',
  terminals: 0,
  submitted: 0,
  page_opens: 0,
  mail_opens: 0,
  submits: 0,
  attachments: 0,
  field_names: [],
  recipients: 0,
  exists: true,
};

/** 只改 active，不发请求：null 来自全部上钩记录按钮，未归属桶由 GroupBoard 直接传对象走 unassigned=1 */
function open(group) {
  active.value = group ?? ALL_GROUP;
}
</script>

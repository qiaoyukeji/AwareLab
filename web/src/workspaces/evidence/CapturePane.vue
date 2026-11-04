<template>
  <GroupBoard v-if="!active" @open="open" />
  <GroupRecords v-else :group="active" :gate="gate" @back="active = null" />
</template>

<script setup>
import { ref } from 'vue';
import GroupBoard from './GroupBoard.vue';
import GroupRecords from './GroupRecords.vue';

defineProps({ gate: { type: Object, default: null } });

// null = 停在分组看板；点开某一行后放那一组的聚合行；看板上的「全部上钩记录」放 ALL_GROUP（没有 id，等于不加归属过滤）
const active = ref(null);

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

function open(group) {
  active.value = group ?? ALL_GROUP;
}
</script>

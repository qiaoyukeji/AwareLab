<template>
  <div class="lab-tabs" role="tablist">
    <button
      v-for="item in items"
      :key="item.key"
      class="lab-tab"
      :class="{ 'is-on': modelValue === item.key }"
      role="tab"
      :aria-selected="modelValue === item.key"
      @click="pick(item.key)"
    >
      {{ item.label }}
      <span v-if="countOf(item) != null" class="lab-tab-n">{{ countOf(item) }}</span>
    </button>
  </div>
</template>

<script setup>
const props = defineProps({
  items: { type: Array, required: true },
  modelValue: { type: String, required: true },
  counts: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['update:modelValue']);

function countOf(item) {
  const v = props.counts[item.key];
  return typeof v === 'number' ? v : null;
}
function pick(key) {
  if (key !== props.modelValue) emit('update:modelValue', key);
}
</script>

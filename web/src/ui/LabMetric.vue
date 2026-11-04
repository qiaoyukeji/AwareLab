<template>
  <div class="lab-metric" :class="tone ? `is-${tone}` : ''">
    <div class="lab-metric-k">{{ label }}</div>
    <div class="lab-metric-v">{{ value }}<small v-if="unit" style="font-size: 13px; font-weight: 600"> {{ unit }}</small></div>
    <div v-if="extra" class="lab-metric-x">{{ extra }}</div>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '-' },
  unit: { type: String, default: '' },
  extra: { type: String, default: '' },
  tone: { type: String, default: '' },
});
</script>

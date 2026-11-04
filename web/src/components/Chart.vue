<template>
  <div ref="el" :style="{ height }" />
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '260px' },
});

const el = ref(null);
let chart = null;

function render() {
  if (!chart) return;
  chart.setOption(props.option, true);
}

const onResize = () => chart?.resize();

onMounted(() => {
  chart = echarts.init(el.value);
  render();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
});

watch(() => props.option, render, { deep: true });
</script>

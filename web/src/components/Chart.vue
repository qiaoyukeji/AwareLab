<template>
  <div ref="el" :style="{ height }" />
</template>

<script setup>
/**
 * ECharts 薄壳组件：把一个 option 变成自适应、会重绘的图表容器。
 * 无状态、不发请求，数据全来自父组件传下的 option；图表里只放聚合计数与去标识后的时间，明文提交内容不能进 option。
 * 别在模板根 div 旁加 HTML 注释：编译器会把它编成 comment 节点，根级多一个节点就变 Fragment，影响属性透传与 diff。
 */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts';

/**
 * option：父组件算好的完整 ECharts 配置，required（画空白图不如不画）。
 * height：容器高度，须是带单位的字符串，默认 260px。
 */
const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '260px' },
});

// 模板 ref：mounted 之后才是真实 <div>，之前是 null，所以初始化只能等 onMounted
const el = ref(null);
// 图表实例放 setup 作用域的 let 而非 ref：不是响应式数据，包进 ref 会让 Vue 深度代理 echarts 内部对象
let chart = null;

/**
 * 把 props.option 全量刷进图表。
 * 先判 !chart：option 可能在挂载前就变、或卸载后 watcher 还在队列里，对 null 调方法会崩整块大屏。
 */
function render() {
  if (!chart) return;
  // notMerge=true：换数据集时旧 series 整个消失；默认合并会把上次画的线留下，掉到 0 看着像没掉
  chart.setOption(props.option, true);
}

/**
 * 窗口 resize 时让图表重算布局（canvas 不跟 CSS 自动缩放）；?. 是因为卸载瞬间 chart 可能已 null。
 * 只监听 window：容器宽度单独变化（面板折叠）不会触发重算。
 */
const onResize = () => chart?.resize();

/** 挂载：init → 首绘 → 挂窗口监听。顺序不能换：init 依赖 el.value 已是真实 DOM，render 依赖 chart 已存在。 */
onMounted(() => {
  chart = echarts.init(el.value);
  render();
  window.addEventListener('resize', onResize);
});

/** 卸载：先摘 resize 监听再 dispose。漏摘监听会留下指向已销毁实例的回调，漏 dispose 会泄漏 canvas 与定时器。 */
onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  chart?.dispose();
});

// option 是嵌套对象，父组件轮询时原地改 option.series[0].data，浅比较看不出变化，所以要 deep
watch(() => props.option, render, { deep: true });
</script>

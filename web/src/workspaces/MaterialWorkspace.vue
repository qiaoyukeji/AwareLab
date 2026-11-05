<template>
  <div class="lab-page">
    <PageHead title="钓鱼素材" note="先从模板库挑一个常见场景，复制后改字段与文案即可；也可以自己写 HTML、从真实站点仿制。" />
    <!-- tab 走 URL query（?tab=email），可发直达链接 -->
    <LabTabs v-model="tab" :items="TABS" />
    <!-- KeepAlive 保住面板草稿与分页，切回不重新请求；复制模板后靠 refreshKey 强制重挂载刷新列表 -->
    <KeepAlive>
      <component :is="PANES[tab]" :key="`${tab}:${refreshKey}`" :gate="gate" v-on="tab === 'library' ? { used: onUsed } : {}" />
    </KeepAlive>
  </div>
</template>

<script setup>
/** 钓鱼素材外壳（路由 #/material）：五面板互不知晓，自己不取数，gate 只透传。
 *  ?tab= 直接下标取组件，没登记的 key 是空白页不报错；面板 onMounted 只跑一次，切回不自动刷新。 */
import { ref } from 'vue';
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import LibraryPane from './material/LibraryPane.vue';
import PagePane from './material/PagePane.vue';
import EmailPane from './material/EmailPane.vue';
import LessonPane from './material/LessonPane.vue';
import ClonePane from './material/ClonePane.vue';

defineProps({ gate: { type: Object, default: null } });

// 标签顺序按准备流程：模板库 → 假登录页 → 邮件文案 → 教学页 → 一键仿站
const TABS = [
  { key: 'library', label: '模板库' },
  { key: 'page', label: '假登录页' },
  { key: 'email', label: '邮件文案' },
  { key: 'lesson', label: '教学页' },
  { key: 'clone', label: '一键仿站' },
];
// 新增标签页要这里和 TABS 同步登记，只改一边就是"标签在、点了空白"
const PANES = { library: LibraryPane, page: PagePane, email: EmailPane, lesson: LessonPane, clone: ClonePane };
const tab = useTab('library');

// 模板库复制成功后 +1 并跳到对应面板：key 变了组件重新挂载，列表能看到刚复制的那一条
const refreshKey = ref(0);
function onUsed(kind) {
  refreshKey.value += 1;
  tab.value = kind === 'mail' ? 'email' : kind === 'lesson' ? 'lesson' : 'page';
}
</script>

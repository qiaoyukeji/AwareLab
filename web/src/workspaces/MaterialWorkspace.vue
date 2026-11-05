<template>
  <div class="lab-page">
    <PageHead title="钓鱼素材" note="假登录页、邮件文案、上钩后看的教学页都在这里准备；后面建站和发信只引用这里存好的素材。" />
    <!-- tab 走 URL query（?tab=email），可发直达链接 -->
    <LabTabs v-model="tab" :items="TABS" />
    <!-- KeepAlive 保住面板草稿与分页，切回不重新请求 -->
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
/** 钓鱼素材外壳（路由 #/material）：四面板互不知晓，自己不取数，gate 只透传。
 *  ?tab= 直接下标取组件，没登记的 key 是空白页不报错；面板 onMounted 只跑一次，切回不自动刷新。 */
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import PagePane from './material/PagePane.vue';
import EmailPane from './material/EmailPane.vue';
import LessonPane from './material/LessonPane.vue';
import ClonePane from './material/ClonePane.vue';

defineProps({ gate: { type: Object, default: null } });

// 标签顺序按准备流程：假登录页 → 邮件文案 → 教学页 → 一键仿站
const TABS = [
  { key: 'page', label: '假登录页' },
  { key: 'email', label: '邮件文案' },
  { key: 'lesson', label: '教学页' },
  { key: 'clone', label: '一键仿站' },
];
// 新增标签页要这里和 TABS 同步登记，只改一边就是"标签在、点了空白"
const PANES = { page: PagePane, email: EmailPane, lesson: LessonPane, clone: ClonePane };
const tab = useTab('page');
</script>

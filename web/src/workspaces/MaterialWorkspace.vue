<template>
  <div class="lab-page">
    <PageHead title="钓鱼素材" note="假登录页、邮件文案、上钩后看的教学页都在这里准备；后面建站和发信只引用这里存好的素材。" />
    <LabTabs v-model="tab" :items="TABS" />
    <KeepAlive>
      <component :is="PANES[tab]" :gate="gate" />
    </KeepAlive>
  </div>
</template>

<script setup>
import PageHead from '../ui/PageHead.vue';
import LabTabs from '../ui/LabTabs.vue';
import { useTab } from '../ui/useTab';
import PagePane from './material/PagePane.vue';
import EmailPane from './material/EmailPane.vue';
import LessonPane from './material/LessonPane.vue';
import ClonePane from './material/ClonePane.vue';

defineProps({ gate: { type: Object, default: null } });

const TABS = [
  { key: 'page', label: '假登录页' },
  { key: 'email', label: '邮件文案' },
  { key: 'lesson', label: '教学页' },
  { key: 'clone', label: '一键仿站' },
];
const PANES = { page: PagePane, email: EmailPane, lesson: LessonPane, clone: ClonePane };
const tab = useTab('page');
</script>

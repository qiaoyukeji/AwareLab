<template>
  <div class="lab-page">
    <PageHead title="演练总览" note="授权状态、素材齐不齐、实时命中情况都在这页；哪一步越界了，这里最先反映出来。">
      <!-- 使用说明常驻页头：新操作员第一眼就能找到入口，不用去翻 docs -->
      <template #ops>
        <el-button plain @click="guide = true">
          <el-icon><QuestionFilled /></el-icon>使用说明
        </el-button>
      </template>
    </PageHead>
    <!-- gate 决定 BoardPane 授权卡的文案与灯色 -->
    <BoardPane :gate="gate" />
    <!-- 首次进入管理面自动展开一次（localStorage 记住已看过），之后从页头按钮打开 -->
    <GuideDrawer v-model="guide" />
  </div>
</template>

<script setup>
/** 演练总览工作区外壳（路由 #/console，登录后默认落地页）：零请求，取数全在 console/BoardPane.vue。
 *  七个外壳形状统一（lab-page + PageHead + 面板），除 /screen 外管理面所有页面都走这套。 */
import { onMounted, ref } from 'vue';
import PageHead from '../ui/PageHead.vue';
import GuideDrawer from '../ui/GuideDrawer.vue';
import BoardPane from './console/BoardPane.vue';

defineProps({ gate: { type: Object, default: null } });

const guide = ref(false);

// 只自动弹一次：弹过就写标记，之后刻意点开才算。标记跟着浏览器走，换机器会再弹一次，可以接受。
onMounted(() => {
  if (localStorage.getItem('awarelab.guide.seen') === '1') return;
  guide.value = true;
  localStorage.setItem('awarelab.guide.seen', '1');
});
</script>

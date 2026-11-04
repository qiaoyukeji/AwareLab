<template>
  <div class="lab-shell">
    <header class="lab-top">
      <div class="lab-brand">
        <BrandMark />
        <div class="lab-brand-txt">
          <b>AwareLab</b>
          <small>安全意识演练平台</small>
        </div>
      </div>

      <nav class="lab-stages">
        <router-link
          v-for="s in STAGES"
          :key="s.to"
          :to="s.to"
          class="lab-stage"
          :class="{ 'is-on': activeStage === s.to }"
        >
          <span class="lab-stage-no">{{ s.no }}</span>
          <span>{{ s.label }}</span>
        </router-link>
      </nav>

      <div class="lab-top-side">
        <GateBadge :mandate="mandate" />
        <router-link to="/screen" class="lab-top-btn" title="沉浸式观测视图">
          <el-icon><Expand /></el-icon><span>观测视图</span>
        </router-link>
        <el-dropdown @command="onCommand">
          <span class="lab-top-btn" style="cursor: pointer">
            <el-icon><User /></el-icon>{{ session.username || '管理员' }}
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="platform">系统设置</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <div v-if="!mandate" class="lab-gate is-danger">
      <el-icon><WarnTriangleFilled /></el-icon>
      <span><b>尚未授权，平台已锁住</b>：没有生效中的演练授权，建钓鱼网站和发钓鱼邮件都会被拒绝。请先到「演练授权」登记授权主体、有效期和允许仿冒的域名。</span>
      <router-link to="/mandate">前往登记</router-link>
    </div>

    <main class="lab-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" :gate="mandate" />
      </router-view>
      <footer class="lab-foot">AwareLab · 本工具仅可用于授权范围内使用的安全意识演练，所有采集数据与凭据只保留在本机</footer>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '../api/client';
import { useSession } from '../stores/session';
import GateBadge from './GateBadge.vue';
import BrandMark from './BrandMark.vue';

const STAGES = [
  { no: '01', to: '/console', label: '演练总览' },
  { no: '02', to: '/mandate', label: '演练授权' },
  { no: '03', to: '/material', label: '钓鱼素材' },
  { no: '04', to: '/capture', label: '钓鱼网站' },
  { no: '05', to: '/outbound', label: '钓鱼邮件' },
  { no: '06', to: '/evidence', label: '上钩记录' },
  { no: '07', to: '/platform', label: '系统设置' },
];

const route = useRoute();
const router = useRouter();
const session = useSession();
const mandates = ref([]);

const mandate = computed(() => mandates.value.find((m) => m.effective === 'active') ?? null);
const activeStage = computed(() => '/' + String(route.path).split('/')[1]);

async function loadMandates() {
  try {
    mandates.value = (await http.get('/authorizations')) || [];
  } catch {
    mandates.value = [];
  }
}

async function onCommand(cmd) {
  if (cmd === 'logout') {
    await session.logout();
    router.replace('/login');
  } else if (cmd === 'platform') {
    router.push('/platform');
  }
}

let timer = null;
onMounted(() => {
  loadMandates();
  timer = setInterval(loadMandates, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>

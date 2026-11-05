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

      <!-- 观测视图 /screen 是脱离本外壳的全屏看板，所以做成顶栏按钮而不是导轨阶段 -->
      <div class="lab-top-side">
        <GateBadge :mandate="mandate" />
        <router-link to="/screen" class="lab-top-btn" title="沉浸式观测视图">
          <el-icon><Expand /></el-icon><span>观测视图</span>
        </router-link>
        <el-dropdown @command="onCommand">
          <span class="lab-top-btn" style="cursor: pointer">
            <!-- 用户名登录时由后端回写进 store；兜底"管理员"是给本地有令牌但没存用户名的老会话 -->
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

    <!-- 没有生效授权时常驻这条，把建不了站、发不了信的原因说在前台；文案要给出下一步动作，不许软化成"配置不完整" -->
    <!-- 真正的拒绝在后端 security/mandate.js 的 assertDeployment，这条只是显示 -->
    <div v-if="!mandate" class="lab-gate is-danger">
      <el-icon><WarnTriangleFilled /></el-icon>
      <span><b>尚未授权，平台已锁住</b>：没有生效中的演练授权，建钓鱼网站和发钓鱼邮件都会被拒绝。请先到「演练授权」登记授权主体、有效期和允许仿冒的域名。</span>
      <router-link to="/mandate">前往登记</router-link>
    </div>

    <main class="lab-main">
      <!-- 同一条生效授权喂给 7 个工作区，面板用它预置灰按钮和前置提示；gate 只影响界面，服务端每次投放都重新判定 -->
      <router-view v-slot="{ Component }">
        <component :is="Component" :gate="mandate" />
      </router-view>
      <!-- 页脚是使用边界声明，改动前要确认仍说清"授权范围内 + 数据只留本机" -->
      <footer class="lab-foot">AwareLab · 本工具仅可用于授权范围内使用的安全意识演练，所有采集数据与凭据只保留在本机</footer>
    </main>
  </div>
</template>

<script setup>
/**
 * 管理端外壳，路由 '/' 的布局组件，包住 7 个工作区（/login 与 /screen 不走这里）。
 * 拉取授权列表算出当前生效授权，喂给 GateBadge、未授权横幅和子视图的 gate prop；授权状态是进工作区前先看的一栏。
 * STAGES 与 router/index.js 的 WORKSPACES 是同一份顺序的两处拷贝，加/改名必须两边同改。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '../api/client';
import { useSession } from '../stores/session';
import GateBadge from './GateBadge.vue';
import BrandMark from './BrandMark.vue';

// 顶栏导轨：to 必须与 router/index.js 的子路由路径逐字一致；label 用操作员口径，术语只留在协议文档页
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
// GET /authorizations 的原样结果，含已吊销/已过期的历史行
const mandates = ref([]);

/**
 * 当前生效的授权，门禁显示的唯一依据。effective 由后端每次请求按此刻重算，库里 status 只表达有没有被吊销，
 * 所以这里只认 active 不比时间；已到期与待生效都落到 null，也就是显示成锁住。
 */
const mandate = computed(() => mandates.value.find((m) => m.effective === 'active') ?? null);

// 取路径第一段归一化，工作区内部的抽屉与子路径下导轨项才仍高亮
const activeStage = computed(() => '/' + String(route.path).split('/')[1]);

/**
 * 失败时静默置空：显示侧宁可报未授权，也不凭旧数据假装绿着；真正的拦截在后端 assertDeployment，这里不必弹窗。
 */
async function loadMandates() {
  try {
    mandates.value = (await http.get('/authorizations')) || [];
  } catch {
    mandates.value = [];
  }
}

/**
 * 账号下拉的命令分发。logout 走 session.logout() 作废令牌，本地令牌与用户名在 stores/session.js 的 finally 里清掉；
 * 用 replace 导航是防"后退"退回一个令牌已失效的控制台。
 */
async function onCommand(cmd) {
  if (cmd === 'logout') {
    await session.logout();
    router.replace('/login');
  } else if (cmd === 'platform') {
    router.push('/platform');
  }
}

// 门禁轮询 30 秒一次，接得住授权到期与吊销后级联停站的状态变化，又不至于反复拉全量列表
let timer = null;
onMounted(() => {
  // 先立即拉一次，免得外壳刚挂载时顶栏闪一下未授权
  loadMandates();
  timer = setInterval(loadMandates, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>

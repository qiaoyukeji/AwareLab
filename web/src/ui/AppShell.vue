<template>
  <div class="lab-shell" :class="{ 'is-fold': fold }">
    <!-- 左侧导航：常见管理后台的形态（分组 + 图标 + 文字），比原来横向 7 个阶段链接更好扫。
         收起态只留图标，窄屏（≤980）自动收起，靠 title 与悬浮提示辨认。 -->
    <aside class="lab-side">
      <div class="lab-side-brand">
        <BrandMark />
        <div class="lab-side-brand-txt">
          <b>AwareLab</b>
          <small>安全意识演练平台 · {{ VERSION_TAG }}</small>
        </div>
      </div>

      <nav class="lab-nav">
        <template v-for="group in visibleNav" :key="group.title">
          <div class="lab-nav-group">{{ group.title }}</div>
          <router-link
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="lab-nav-item"
            :class="{ 'is-on': activeStage === item.to }"
            :title="item.label"
          >
            <el-icon class="lab-nav-ico"><component :is="item.icon" /></el-icon>
            <span class="lab-nav-txt">{{ item.label }}</span>
            <span v-if="item.badge" class="lab-nav-badge">{{ item.badge }}</span>
          </router-link>
        </template>
      </nav>

      <div class="lab-side-foot">
        <router-link to="/screen" class="lab-nav-item" title="全屏观测视图">
          <el-icon class="lab-nav-ico"><DataLine /></el-icon>
          <span class="lab-nav-txt">观测视图</span>
        </router-link>
        <button type="button" class="lab-nav-item lab-nav-fold" title="收起 / 展开导航" @click="toggleFold">
          <el-icon class="lab-nav-ico"><component :is="fold ? 'Expand' : 'Fold'" /></el-icon>
          <span class="lab-nav-txt">收起导航</span>
        </button>
      </div>
    </aside>

    <div class="lab-body">
      <!-- 顶栏只放位置与状态：面包屑说清"我在哪"，右侧是授权状态与账号，操作按钮都留在页面里 -->
      <header class="lab-topbar">
        <div class="lab-crumb">
          <span class="lab-crumb-home">{{ currentGroup }}</span>
          <el-icon class="lab-crumb-sep"><ArrowRight /></el-icon>
          <b>{{ currentStage?.label || '工作台' }}</b>
        </div>
        <div class="lab-topbar-side">
          <GateBadge :mandate="mandate" />
          <el-dropdown @command="onCommand">
            <span class="lab-user">
              <span class="lab-avatar">{{ (session.username || 'A').slice(0, 1).toUpperCase() }}</span>
              <span class="lab-user-txt">
                <b class="lab-user-name">{{ session.displayName || session.username || '管理员' }}</b>
                <small class="lab-user-role">{{ session.isAdmin ? '管理员' : '普通用户' }}</small>
              </span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="password">修改口令</el-dropdown-item>
                <el-dropdown-item command="mandate">授权与演练信息</el-dropdown-item>
                <el-dropdown-item v-if="session.isAdmin" command="accounts">账号管理</el-dropdown-item>
                <el-dropdown-item v-if="session.isAdmin" command="platform">系统设置</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <PasswordDialog v-model="pwdOpen" />

      <!-- 没有生效授权时常驻这条，把建不了站、发不了信的原因说在前台；文案要给出下一步动作，不许软化成"配置不完整" -->
      <!-- 真正的拒绝在后端 security/mandate.js 的 assertDeployment，这条只是显示 -->
      <div v-if="!mandate" class="lab-gate is-danger">
        <el-icon><WarnTriangleFilled /></el-icon>
        <span><b>尚未授权，平台已锁住</b>：没有生效中的演练授权，建钓鱼网站和发钓鱼邮件都会被拒绝。</span>
        <router-link to="/mandate">一分钟完成登记</router-link>
      </div>

      <main class="lab-main">
        <!-- 同一条生效授权喂给 7 个工作区，面板用它预置灰按钮和前置提示；gate 只影响界面，服务端每次投放都重新判定 -->
        <router-view v-slot="{ Component }">
          <component :is="Component" :gate="mandate" />
        </router-view>
        <!-- 页脚是使用边界声明，改动前要确认仍说清"授权范围内 + 数据只留本机" -->
        <!-- 版本号同时留在页脚：导航收起时左上角的副标题会隐藏，这里始终可读 -->
        <footer class="lab-foot">AwareLab {{ VERSION_TAG }} · 本工具仅可用于授权范围内使用的安全意识演练，所有采集数据与凭据只保留在本机</footer>
      </main>
    </div>
  </div>
</template>

<script setup>
/**
 * 管理端外壳，路由 '/' 的布局组件，包住 7 个工作区（/login 与 /screen 不走这里）。
 * 拉取授权列表算出当前生效授权，喂给 GateBadge、未授权横幅和子视图的 gate prop；授权状态是进工作区前先看的一栏。
 * NAV 与 router/index.js 的 WORKSPACES 是同一份路径的两处拷贝，加/改名必须两边同改。
 *
 * 版式说明（2026-11 改版）：顶栏横排 7 个阶段在窄屏会被压成横滚条、也看不出分组，
 * 换成左侧分组导航 + 顶栏面包屑的常见后台形态；类名继续沿用 lab-*，工作区面板一行都不用改。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import http from '../api/client';
import { VERSION_TAG } from '../version';
import { useSession } from '../stores/session';
import GateBadge from './GateBadge.vue';
import BrandMark from './BrandMark.vue';
import PasswordDialog from './PasswordDialog.vue';

// 导航分组按"准备 → 投放 → 复盘 → 系统"的顺序，组内顺序就是操作顺序。
// icon 取 @element-plus/icons-vue 的组件名，main.js 里已全量注册，模板用 <component :is> 解析。
const NAV = [
  {
    title: '演练',
    items: [
      { to: '/console', label: '演练总览', icon: 'Odometer' },
      { to: '/mandate', label: '演练授权', icon: 'Stamp' },
    ],
  },
  {
    title: '素材与投放',
    items: [
      { to: '/material', label: '钓鱼素材', icon: 'Files' },
      { to: '/capture', label: '钓鱼网站', icon: 'Monitor' },
      { to: '/outbound', label: '钓鱼邮件', icon: 'Promotion' },
    ],
  },
  {
    title: '复盘',
    items: [{ to: '/evidence', label: '上钩记录', icon: 'Aim' }],
  },
  {
    title: '系统',
    items: [
      { to: '/platform', label: '系统设置', icon: 'Setting', admin: true },
      { to: '/accounts', label: '账号管理', icon: 'User', admin: true },
    ],
  },
];

const FLAT = NAV.flatMap((group) => group.items.map((item) => ({ ...item, group: group.title })));

const route = useRoute();
const router = useRouter();
const session = useSession();
// 改口令弹窗：普通用户进不了系统设置，只能从右上角账号菜单改自己的口令
const pwdOpen = ref(false);
// 导航按角色裁剪：普通用户看不到系统设置与账号管理（后端同样 403，这里只是不摆一个点了必然失败的入口）
const visibleNav = computed(() =>
  NAV.map((group) => ({ ...group, items: group.items.filter((item) => !item.admin || session.isAdmin) })).filter(
    (group) => group.items.length,
  ),
);
// GET /authorizations 的原样结果，含已吊销/已过期的历史行
const mandates = ref([]);
// 导航收起状态存本地：同一台机器上操作员偏好固定，刷新后不该弹回展开
const fold = ref(localStorage.getItem('awarelab.nav-fold') === '1');

/**
 * 当前生效的授权，门禁显示的唯一依据。effective 由后端每次请求按此刻重算，库里 status 只表达有没有被吊销，
 * 所以这里只认 active 不比时间；已到期与待生效都落到 null，也就是显示成锁住。
 */
const mandate = computed(() => mandates.value.find((m) => m.effective === 'active') ?? null);

// 取路径第一段归一化，工作区内部的抽屉与子路径下导航项才仍高亮
const activeStage = computed(() => '/' + String(route.path).split('/')[1]);
const currentStage = computed(() => FLAT.find((item) => item.to === activeStage.value) ?? null);
const currentGroup = computed(() => currentStage.value?.group || '工作台');

function toggleFold() {
  fold.value = !fold.value;
  localStorage.setItem('awarelab.nav-fold', fold.value ? '1' : '0');
}

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
  } else if (cmd === 'password') {
    pwdOpen.value = true;
  } else if (cmd === 'platform') {
    router.push('/platform');
  } else if (cmd === 'accounts') {
    router.push('/accounts');
  } else if (cmd === 'mandate') {
    router.push('/mandate');
  }
}

// 门禁轮询 30 秒一次，接得住授权到期与吊销后级联停站的状态变化，又不至于反复拉全量列表
let timer = null;
onMounted(() => {
  // 先立即拉一次，免得外壳刚挂载时顶栏闪一下未授权
  loadMandates();
  // 角色以服务端为准：本地 localStorage 只用于首屏渲染，账号被停用或降级后这里会回 401/更新角色
  session.me().catch(() => {});
  timer = setInterval(loadMandates, 30000);
});
onUnmounted(() => clearInterval(timer));
</script>

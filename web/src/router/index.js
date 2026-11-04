import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from '../ui/AppShell.vue';
import { readToken } from '../api/client';

// 顶栏按演练动作排序：拿授权 → 备素材 → 建钓鱼网站 → 发钓鱼邮件 → 查上钩记录 → 导出与设置
// 命名以"操作员一眼看懂干什么"为准；专业术语（钓鱼网站/信标面/契约）只留在「系统设置 · 协议文档」里
const WORKSPACES = [
  { path: 'console', title: '演练总览', file: 'ConsoleWorkspace' },
  { path: 'mandate', title: '演练授权', file: 'MandateWorkspace' },
  { path: 'material', title: '钓鱼素材', file: 'MaterialWorkspace' },
  { path: 'capture', title: '钓鱼网站', file: 'CaptureWorkspace' },
  { path: 'outbound', title: '钓鱼邮件', file: 'OutboundWorkspace' },
  { path: 'evidence', title: '上钩记录', file: 'EvidenceWorkspace' },
  { path: 'platform', title: '系统设置', file: 'PlatformWorkspace' },
];

const routes = [
  { path: '/login', name: 'login', component: () => import('../ui/LoginView.vue') },
  {
    path: '/',
    component: AppShell,
    children: [
      ...WORKSPACES.map((w) => ({
        path: w.path,
        name: w.path,
        meta: { title: w.title },
        component: () => import(`../workspaces/${w.file}.vue`),
      })),
      { path: '', redirect: '/console' },
    ],
  },
  // 观测视图脱离管理端外壳，单独占满整屏
  { path: '/screen', name: 'screen', meta: { title: '观测视图' }, component: () => import('../workspaces/ScreenView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/console' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach((to) => {
  const authed = !!readToken();
  if (!authed && to.name !== 'login') return { name: 'login', query: { redirect: to.fullPath } };
  if (authed && to.name === 'login') return { name: 'console' };
  return true;
});

router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · AwareLab` : 'AwareLab';
});

export default router;

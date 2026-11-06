/**
 * 管理端路由表 + 两道守卫：本地会话闸门与标签页标题。
 * 用哈希路由：服务端不需要为 SPA 做 rewrite，且 base:'./' 的相对资源在 history 路由深链下会指错目录。
 * readToken 只看本机存没存令牌，不是安全边界，真正的鉴权在后端。
 */
import { createRouter, createWebHashHistory } from 'vue-router';
import AppShell from '../ui/AppShell.vue';
import { readToken } from '../api/client';
import { VERSION_TAG } from '../version';

// 顶栏按演练动作排序
/**
 * 7 个工作区的清单，下面用 map() 批量生成子路由，顺序即演练动作顺序。
 * path 不带前导斜杠（挂在 / 的 AppShell 下，绝对路径会跳出外壳）；file 须与 workspaces/ 文件名逐字一致。
 * 加一项不会自动上顶栏：顶栏读 AppShell.vue 的 STAGES。
 */
const WORKSPACES = [
  { path: 'console', title: '演练总览', file: 'ConsoleWorkspace' },
  { path: 'mandate', title: '演练授权', file: 'MandateWorkspace' },
  { path: 'material', title: '钓鱼素材', file: 'MaterialWorkspace' },
  { path: 'capture', title: '钓鱼网站', file: 'CaptureWorkspace' },
  { path: 'outbound', title: '钓鱼邮件', file: 'OutboundWorkspace' },
  { path: 'evidence', title: '上钩记录', file: 'EvidenceWorkspace' },
  // 系统设置与账号管理只给管理员：后端对 /settings 与 /users 都挂了 requireAdmin，普通用户进来只会看到一片 403
  { path: 'platform', title: '系统设置', file: 'PlatformWorkspace', admin: true },
  { path: 'accounts', title: '账号管理', file: 'AccountsWorkspace', admin: true },
];

/**
 * 路由清单：登录页（匿名、不带外壳）、AppShell 之下的 7 个工作区子路由、观测大屏（全屏无外壳）与兜底重定向。
 * 全用 () => import(...) 懒加载：壳页先到，工作区按需再拉，登进总览就不会被大屏的 echarts 拖进首屏体积。
 */
const routes = [
  { path: '/login', name: 'login', component: () => import('../ui/LoginView.vue') },
  {
    path: '/',
    component: AppShell,
    children: [
      ...WORKSPACES.map((w) => ({
        path: w.path,
        // name 取自 path：beforeEach 用 { name: 'console' } 回跳靠的就是这个约定
        name: w.path,
        meta: { title: w.title, admin: Boolean(w.admin) },
        // 模板串的前缀 '../workspaces/' 与后缀 '.vue' 必须是字面量：Vite 靠它切按需 chunk，整段塞进变量里构建期分析不出来、运行时会 404
        component: () => import(`../workspaces/${w.file}.vue`),
      })),
      { path: '', redirect: '/console' },
    ],
  },
  // 观测视图脱离管理端外壳，单独占满整屏；总屏之外，每个站点与每个发送任务各有一条深链
  { path: '/screen', name: 'screen', meta: { title: '观测视图' }, component: () => import('../workspaces/ScreenView.vue') },
  { path: '/screen/site/:id', name: 'screen-site', meta: { title: '站点大屏' }, component: () => import('../workspaces/ScreenView.vue') },
  { path: '/screen/task/:id', name: 'screen-task', meta: { title: '任务大屏' }, component: () => import('../workspaces/ScreenView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/console' },
];

const router = createRouter({ history: createWebHashHistory(), routes });

/**
 * 进路由前的本地闸门：只看本机有没有令牌，不发请求、不验有效期。
 * 未登录去任何页 → 登录页并带 ?redirect=原路径（登录成功后据此送回）；已登录还去登录页 → 演练总览。
 * 管理员页再做一道本地角色过滤：普通用户手敲 #/accounts 也不该进得去（真正的拦截仍在后端）。
 */
router.beforeEach((to) => {
  const authed = !!readToken();
  if (!authed && to.name !== 'login') return { name: 'login', query: { redirect: to.fullPath } };
  if (authed && to.name === 'login') return { name: 'console' };
  if (authed && to.meta?.admin && localStorage.getItem('alab_role') !== 'admin') return { name: 'console' };
  return true;
});

/** 落地后同步标签页标题为 工作区名 · AwareLab v版本号；没有 meta.title 的（登录页、兜底）只留产品名。
 *  标题栏是最容易被截图带走的一处，带上版本号，用户反馈问题时报的那串字就能直接对上构建。 */
router.afterEach((to) => {
  document.title = to.meta?.title ? `${to.meta.title} · AwareLab ${VERSION_TAG}` : `AwareLab ${VERSION_TAG}`;
});

export default router;

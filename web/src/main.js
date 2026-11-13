/**
 * 管理端前端的启动入口：把 Vue 应用、Pinia、路由和 Element Plus 装到 #app。
 * 样式顺序有意义（Element Plus → tokens.css → panes.css），换序会被组件库默认值盖掉；#app 的 id 须与 index.html 一致。
 * 这些 import 保持静态：壳页 head 的内联脚本先写好 window.__ALAB_PANEL__，client.js 求值时才拿得到随机入口。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import * as Icons from '@element-plus/icons-vue';
import 'element-plus/dist/index.css';
import './styles/tokens.css';
import './styles/panes.css';
import App from './App.vue';
import router from './router';
import { showRecovery } from './ui/recover';

const app = createApp(App);
// 图标全量注册，换打包体积免去逐处 import，省得漏 import 渲染成未知组件
for (const [name, comp] of Object.entries(Icons)) app.component(name, comp);
// Pinia 要早于任何 store 的首次实例化（AppShell 一挂载就 useSession），也早于 mount
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

/**
 * 运行期兜底只管"白屏"这一种：渲染异常与 chunk 加载失败。
 * 不接管 unhandledrejection——HTTP 层的 400/403 都会 reject 成 Error，
 * 挨个弹兜底层反而把正常的业务提示盖住；那类错误由调用方 catch 后弹 ElMessage。
 */
app.config.errorHandler = (err, _vm, info) => {
  console.error('[ui] 渲染异常', info, err);
  showRecovery('界面渲染时出了异常，已经停在这里，避免继续白下去。', `${info}\n${err?.stack || err}`);
};

router.onError((err, to) => {
  console.error('[router] 路由失败', to?.fullPath, err);
  // 换版本后旧的 chunk 名字对不上，重新加载一次基本就能拿到新入口
  const stale = /Failed to fetch dynamically imported module|Importing a module script failed/i.test(String(err?.message));
  showRecovery(
    stale ? '这是旧版本留下的页面，正在取的脚本已经不在服务器上了，刷新一次即可。' : '页面模块加载失败，可以回首页或刷新重试。',
    `${to?.fullPath || ''}\n${err?.message || err}`
  );
});

app.mount('#app');
// 挂载成功后给 index.html 的静态兜底留个标记，免得它 4 秒后把正常页面盖住
document.getElementById('app')?.setAttribute('data-mounted', '1');

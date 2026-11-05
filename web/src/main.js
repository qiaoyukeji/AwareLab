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

const app = createApp(App);
// 图标全量注册，换打包体积免去逐处 import，省得漏 import 渲染成未知组件
for (const [name, comp] of Object.entries(Icons)) app.component(name, comp);
// Pinia 要早于任何 store 的首次实例化（AppShell 一挂载就 useSession），也早于 mount
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');

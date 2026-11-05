/**
 * 会话 store：登录 / 自检 / 退出 / 全量注销 / 改口令，前端唯一碰 /auth/* 的地方。
 * 令牌只落 localStorage 不进 store（store 会随热更新重建），username 仅显示、不参与权限判断。
 * 登录时后端把令牌同时写进 SameSite=Strict 的 alab_token cookie，同站 window.open 打开报告链接因此自带鉴权。
 */
import { defineStore } from 'pinia';
import http, { TOKEN_KEY, USER_KEY } from '../api/client';

/**
 * 会话作废后的收尾：清本地令牌与显示名并送回登录页，revokeAll / changePassword 共用。
 * 改 location.hash 而非 import router（router 与 client.js 已互相引用，会成环）；已在登录页不跳。
 */
function dropLocalSession(store) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  store.username = '';
  if (!location.hash.startsWith('#/login')) location.hash = '#/login';
}

export const useSession = defineStore('session', {
  // 初值直接读 localStorage：刷新页面后顶栏不该闪一下"管理员"再去等接口回来
  state: () => ({ username: localStorage.getItem(USER_KEY) || '', checked: false }),
  actions: {
    /** 账密登录：POST /auth/login，成功后写两条 localStorage 并同步 username，失败一条都不写。账密错与限速锁命中的中文理由由后端给，本层不加工。 */
    async login(username, password) {
      const data = await http.post('/auth/login', { username, password });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, data.username);
      this.username = data.username;
      return data;
    },
    /**
     * 用当前令牌向后端确认会话并刷新显示名：GET /auth/me。令牌失效会 401，拦截器已顺手清本地并跳登录。
     * me() 与 state.checked 目前无调用方，预留给启动时向后端校准会话，删改前先全局搜一遍。
     */
    async me() {
      const data = await http.get('/auth/me');
      this.username = data.username;
      return data;
    },
    /** 退出登录：POST /auth/logout，但清理放 finally，后端不可达或令牌已过期（必 401）时也要清干净本地，不留半截会话。无 catch，后端错误仍冒给调用方。 */
    async logout() {
      try {
        await http.post('/auth/logout');
      } finally {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        this.username = '';
      }
    },
    /**
     * 退出所有会话（含自己）：POST /auth/sessions/revoke-all，后端清空 sessions 表并写一条 revoke_all 审计，返回被清会话数。
     * 语义是怀疑令牌泄露时全量作废；finally 走 dropLocalSession（理由同 logout），跳转用 location.hash。
     */
    async revokeAll() {
      try {
        return await http.post('/auth/sessions/revoke-all');
      } finally {
        dropLocalSession(this);
      }
    },
    /**
     * 改后台口令：POST /auth/password，body {current_password,new_password}（新口令 8~64 且须不同于当前，否则 400）。
     * 后端只换 config.yaml 的 panel.password 一行、内存同步生效不用重启，再清空 sessions 并写 panel.password_change 审计；新旧口令都不落库。
     */
    async changePassword(currentPassword, newPassword) {
      // 新口令不进任何 state，也不做持久化；只在请求成功后收尾
      const data = await http.post('/auth/password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      // 不带 catch、清理也不放 finally：400 时会话并没被作废，此时踢回登录等于输错一次新口令就掉线
      dropLocalSession(this);
      return data;
    },
  },
});

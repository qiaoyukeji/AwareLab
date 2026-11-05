/**
 * 会话 store：登录（账密 + 短信两步）/ 自检 / 退出 / 全量注销 / 改口令，前端唯一碰 /auth/* 的地方。
 * 令牌只落 localStorage 不进 store（store 会随热更新重建），username/role 仅用于显示与隐藏入口，真正的权限判定一律在后端。
 * 登录时后端把令牌同时写进 SameSite=Strict 的 alab_token cookie，同站 window.open 打开报告链接因此自带鉴权。
 */
import { defineStore } from 'pinia';
import http, { TOKEN_KEY, USER_KEY } from '../api/client';

// 角色与显示名另存两个键：USER_KEY 的语义被各处当"用户名"用，塞 JSON 会把旧读取点全部带崩
export const ROLE_KEY = 'alab_role';
export const NAME_KEY = 'alab_name';

/**
 * 会话作废后的收尾：清本地令牌与显示名并送回登录页，revokeAll / changePassword 共用。
 * 改 location.hash 而非 import router（router 与 client.js 已互相引用，会成环）；已在登录页不跳。
 */
function dropLocalSession(store) {
  for (const key of [TOKEN_KEY, USER_KEY, ROLE_KEY, NAME_KEY]) localStorage.removeItem(key);
  store.username = '';
  store.role = '';
  store.displayName = '';
  if (!location.hash.startsWith('#/login')) location.hash = '#/login';
}

export const useSession = defineStore('session', {
  // 初值直接读 localStorage：刷新页面后顶栏不该闪一下"管理员"再去等接口回来
  state: () => ({
    username: localStorage.getItem(USER_KEY) || '',
    role: localStorage.getItem(ROLE_KEY) || '',
    displayName: localStorage.getItem(NAME_KEY) || '',
    phone: '',
    phoneVerified: false,
    smsEnabled: false,
    checked: false,
  }),
  getters: {
    /** 触发短信认证的只在普通用户：管理员是后台兜底入口，界面上也与这套流程无关。 */
    isAdmin: (state) => state.role === 'admin',
  },
  actions: {
    /** 把一次成功签发的会话落到本地：令牌、用户名、角色、显示名。 */
    acceptSession(data) {
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, data.username || '');
      localStorage.setItem(ROLE_KEY, data.role || 'user');
      localStorage.setItem(NAME_KEY, data.display_name || data.username || '');
      this.username = data.username || '';
      this.role = data.role || 'user';
      this.displayName = data.display_name || data.username || '';
      this.checked = true;
      return data;
    },
    /**
     * 账密登录（第一步）：POST /auth/login。
     * 回 `{sms_required:true, purpose, ticket, phone_masked}` 时不写任何本地状态，交给登录页进第二步；
     * 管理员或未开短信时直接拿到 token，走 acceptSession。
     */
    async login(username, password) {
      const data = await http.post('/auth/login', { username, password });
      if (data?.sms_required) return data;
      return this.acceptSession(data);
    },
    /** 第二步发码：POST /auth/sms/send {ticket, phone?}；bind 场景 phone 必填，login 场景后端只认票据里的号。 */
    async sendSmsCode(ticket, phone) {
      return http.post('/auth/sms/send', { ticket, phone: phone || undefined });
    },
    /** 第二步验码：POST /auth/sms/verify {ticket, code, phone?}，PASS 后落会话。 */
    async verifySmsCode(ticket, code, phone) {
      const data = await http.post('/auth/sms/verify', { ticket, code, phone: phone || undefined });
      return this.acceptSession(data);
    },
    /**
     * 用当前令牌向后端确认会话并刷新身份：GET /auth/me。令牌失效会 401，拦截器已顺手清本地并跳登录。
     * 同时把 role / 手机号 / 短信开关带回来，导航据此隐藏管理员入口。
     */
    async me() {
      const data = await http.get('/auth/me');
      this.username = data.username;
      this.role = data.role || 'user';
      this.displayName = data.display_name || data.username;
      this.phone = data.phone || '';
      this.phoneVerified = Boolean(data.phone_verified);
      this.smsEnabled = Boolean(data.sms_enabled);
      this.checked = true;
      localStorage.setItem(USER_KEY, this.username);
      localStorage.setItem(ROLE_KEY, this.role);
      localStorage.setItem(NAME_KEY, this.displayName);
      return data;
    },
    /** 退出登录：POST /auth/logout，但清理放 finally，后端不可达或令牌已过期（必 401）时也要清干净本地，不留半截会话。 */
    async logout() {
      try {
        await http.post('/auth/logout');
      } finally {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(ROLE_KEY);
        localStorage.removeItem(NAME_KEY);
        this.username = '';
        this.role = '';
        this.displayName = '';
      }
    },
    /**
     * 退出所有会话（含自己）：POST /auth/sessions/revoke-all，管理员专属，后端清空 sessions 表并写审计。
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
     * 改自己的口令：POST /auth/password，body {current_password,new_password}（新口令 8~64 且须不同于当前，否则 400）。
     * 后端改 users.password_hash（管理员同步 config.yaml），再清空 sessions 并写审计；新旧口令都不落库。
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

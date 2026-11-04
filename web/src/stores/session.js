import { defineStore } from 'pinia';
import http, { TOKEN_KEY, USER_KEY } from '../api/client';

export const useSession = defineStore('session', {
  state: () => ({ username: localStorage.getItem(USER_KEY) || '', checked: false }),
  actions: {
    async login(username, password) {
      const data = await http.post('/auth/login', { username, password });
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(USER_KEY, data.username);
      this.username = data.username;
      return data;
    },
    async me() {
      const data = await http.get('/auth/me');
      this.username = data.username;
      return data;
    },
    async logout() {
      try {
        await http.post('/auth/logout');
      } finally {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        this.username = '';
      }
    },
  },
});

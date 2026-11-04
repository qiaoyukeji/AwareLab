import axios from 'axios';

const raw = window.__ALAB_PANEL__;
export const PANEL = raw && raw !== '__ALAB_PANEL_VALUE__' ? raw : null;
export const API_BASE = PANEL ? `/${PANEL}/api` : '/api';
export const TOKEN_KEY = 'alab_token';
export const USER_KEY = 'alab_user';
export const TOKEN_HEADER = 'x-alab-token';

export function readToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

const http = axios.create({ baseURL: API_BASE, timeout: 180000 });

http.interceptors.request.use((cfg) => {
  const token = readToken();
  if (token) cfg.headers[TOKEN_HEADER] = token;
  return cfg;
});

// 后端统一返回 { code, data, message }，这里直接把 data 摊平给业务层
http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    return body;
  },
  (err) => {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.message || '网络异常';
    if (status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    }
    return Promise.reject(new Error(message));
  }
);

/** CSV 等导出走原生 fetch，避免被拦截器当成 JSON 协议解析 */
export async function download(path, filename) {
  const token = readToken();
  const res = await fetch(API_BASE + path, { headers: token ? { [TOKEN_HEADER]: token } : {} });
  if (!res.ok) throw new Error(`导出失败 ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 假登录页预览是 POST 接口且要带会话头，返回渲染后的 HTML，由面板写进 iframe 的 srcdoc */
export default http;

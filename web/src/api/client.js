/**
 * 管理面前端的唯一 HTTP 出口：axios 实例、后台随机入口路径与会话令牌读写。
 * 响应拦截器已把后端的 { code, data, message } 摊平成 data，业务层直接拿数据，别再 .data.data。
 */
import axios from 'axios';

// 壳页面注入的随机入口值：占位符状态下（未构建/未替换）视为"没有入口信息"
const raw = window.__ALAB_PANEL__;
/** 后台入口随机段（32 位十六进制，来自 config.panel.path），拿不到时为 null。 */
export const PANEL = raw && raw !== '__ALAB_PANEL_VALUE__' ? raw : null;
/**
 * 管理面接口前缀：注入成功为 /<随机入口>/api，占位符未替换时退回 /api（dev 由 vite 代理重写到随机入口）。
 * 线上必须带随机入口，否则后台路径等于公开。
 */
export const API_BASE = PANEL ? `/${PANEL}/api` : '/api';
/** 会话令牌的 localStorage 键名。 */
export const TOKEN_KEY = 'alab_token';
/** 登录名键名，仅顶栏显示用，不参与鉴权。 */
export const USER_KEY = 'alab_user';
/** 会话头名，需与后端读取的一致。 */
export const TOKEN_HEADER = 'x-alab-token';

/**
 * 读本机保存的会话令牌，没有则返回空串（不返回 null，方便调用方直接 !! 或拼接）。
 * 只表示本机存没存，令牌有没有过期要打到接口才知道。
 */
export function readToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

/**
 * 管理面请求用的 axios 实例。timeout 180s 要大于后端仿站的 120s，
 * 让长请求的后端中文错误先返回，而不是被 axios 超时抢先顶掉。
 */
const http = axios.create({ baseURL: API_BASE, timeout: 180000 });

/** 请求拦截：每次现读令牌，登录写入 localStorage 后下一个请求自动带上，无需重建实例；无令牌不加会话头。 */
http.interceptors.request.use((cfg) => {
  const token = readToken();
  if (token) cfg.headers[TOKEN_HEADER] = token;
  return cfg;
});

// 后端统一返回 { code, data, message }，这里直接把 data 摊平给业务层
/** 响应拦截：非 0 业务码和 HTTP 错误都收敛成一个中文 Error 后 reject，业务层只需 catch 弹 e.message。 */
http.interceptors.response.use(
  (res) => {
    const body = res.data;
    // 有 code 字段才按信封协议处理；'code' in 对字符串会抛 TypeError，所以先确认是对象
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      // code 非 0：后端 message 是给操作员看的中文，直接当错误抛出
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    // 非信封响应（少数直出资源）原样返回
    return body;
  },
  (err) => {
    const status = err.response?.status;
    // 优先用后端响应体里的 message，其次才是 axios 文案
    const message = err.response?.data?.message || err.message || '网络异常';
    if (status === 401) {
      // 会话失效：令牌和用户名一起清
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      // 用 location.hash 跳转而不 import router：router 反过来 import 本文件的 readToken，会成环
      // 已在登录页就不跳，避免登录请求 401 造成死循环
      if (!location.hash.startsWith('#/login')) location.hash = '#/login';
    }
    // 一律 reject：调用方 catch 到即操作未成，文案可直接展示
    return Promise.reject(new Error(message));
  }
);

/**
 * 导出下载（CSV 等）：走原生 fetch GET path，把响应存成 blob 落盘，失败抛 `导出失败 <HTTP 状态码>`。
 * 绕开 http 实例是因为拦截器只交出 res.data、拿不到 blob；revokeObjectURL 必须排在 click() 之后，提前释放会下到 0 字节文件。
 */
export async function download(path, filename) {
  const token = readToken();
  // fetch 无拦截器兜着，会话头自己补；没令牌传空对象
  const res = await fetch(API_BASE + path, { headers: token ? { [TOKEN_HEADER]: token } : {} });
  if (!res.ok) throw new Error(`导出失败 ${res.status}`);
  const blob = await res.blob();
  // 临时 URL + <a download> 触发保存，不跳出当前页
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 默认导出：管理面用的 axios 实例。假登录页预览等 POST 走它，需带会话头拿 HTML 字符串，所以不用 download 那条原生 fetch 的路。 */
export default http;

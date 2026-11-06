/**
 * 当前构建的版本号，界面上所有显示版本的地方都从这里取。
 *
 * 值由构建期注入：vite.config.js 读 server/package.json 后把 __APP_VERSION__ 替换成字符串字面量
 * （web 与 server 版本不一致时构建直接失败）。前端不再自己维护一份版本号——两处各写一份，
 * 迟早出现"界面写着 v2.3.0、实际跑的是 2.2.2"这种最难查的偏差。
 *
 * typeof 判断是给未经过 vite 处理的环境（比如脚本里直接 import 这个模块）兜底，避免 ReferenceError。
 */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** 展示形态：带 v 前缀，例如 v2.3.0 */
export const VERSION_TAG = `v${APP_VERSION}`;

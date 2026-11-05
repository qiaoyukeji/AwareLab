/**
 * 工作区标签状态存在 URL 的 ?tab=xxx 上，方便把某个视图分享给同事复现。
 * 只能在 setup 期间调用（useRoute/useRouter 依赖当前组件实例）。
 * 标签名会出现在地址栏和分享链接里，属于操作员可见文案。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/**
 * 返回一个可写 computed：读 URL 上的 tab，写时 replace 路由。
 * fallback 由调用方给死，默认停在哪个标签仍归各工作区管；只写 URL，不写存储、不发请求。
 */
export function useTab(fallback) {
  const route = useRoute();
  const router = useRouter();
  return computed({
    // 只认字符串：?tab=a&tab=b 会被 vue-router 解析成数组，空串与数组都落回 fallback
    get: () => (typeof route.query.tab === 'string' && route.query.tab) || fallback,
    // 用 replace 不往历史栈堆记录；展开 route.query 保住其它查询参数
    set: (tab) => router.replace({ query: { ...route.query, tab } }),
  });
}

import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/** 工作区标签写进 URL query，便于把「上钩记录-采集记录」这类视图直接分享给同事 */
export function useTab(fallback) {
  const route = useRoute();
  const router = useRouter();
  return computed({
    get: () => (typeof route.query.tab === 'string' && route.query.tab) || fallback,
    set: (tab) => router.replace({ query: { ...route.query, tab } }),
  });
}

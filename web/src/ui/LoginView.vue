<template>
  <div class="gate-view">
    <!-- 本机管理面的入口，未拿到会话令牌前什么都看不到（守卫见 router/index.js） -->
    <div class="gate-card">
      <div class="gate-hd">
        <BrandMark />
        <div>
          <b>AwareLab</b>
          <!-- 点明"管理端"：这一页只给操作员看，访客侧永远看不到本平台的任何标识 -->
          <small>安全意识演练平台 · 管理端</small>
        </div>
      </div>

      <!-- 不做前端校验规则，空值由 submit() 一句提示挡下 -->
      <el-form class="gate-form" :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="管理员账号" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="口令">
          <el-input v-model="form.password" type="password" show-password placeholder="管理员口令" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" class="gate-submit" :loading="loading" @click="submit">进入控制台</el-button>
      </el-form>

      <!-- 这三条口径与产品定位一致：只服务授权范围内使用、无授权一律拒、默认沙箱且数据只留本机 -->
      <ul class="gate-rules">
        <li><el-icon><Lock /></el-icon>仅可用于授权范围内使用的安全意识演练</li>
        <li><el-icon><Upload /></el-icon>未登记有效授权时，建站与发送一律拒绝</li>
        <li><el-icon><Message /></el-icon>邮件默认沙箱发送，采集数据只留在本机</li>
      </ul>

      <!-- 后台路径 / 账号 / 口令首次启动随机生成并写进 server/config.yaml，所以这里不放"默认口令"提示 -->
      <p class="gate-note">
        首次启动时后台路径、账号与口令随机写入 <code>server/config.yaml</code>，仅在本机可见。
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * 管理端登录页，路由 /login，不带 AppShell 外壳。
 * 这一页只面向操作员，演练 / 授权 / 采集这类词可以照实写；访客能看到的仿造登录页、教学页、邮件正文不复用这里的文案。
 * 口令只留在内存的 reactive form 里，提交后随组件卸载消失，不写进 localStorage。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSession } from '../stores/session';
import BrandMark from './BrandMark.vue';

const route = useRoute();
const router = useRouter();
const session = useSession();
// 提交中标志，驱动按钮转圈与禁用，防连点重复送出失败计数
const loading = ref(false);
const form = reactive({ username: '', password: '' });

/**
 * 提交登录。字段为空只弹提示不打后端，省一次必然 401 的往返，也不白耗该 IP 的失败计数；
 * 成功后 localStorage 由 stores/session.js 写，这里 replace 到 redirect 目标或 /console（不留历史记录，
 * 否则后退会退回一个已登录的登录页再被守卫弹回来）。
 * 失败不分类，直接弹 err.message。锁定按来源 IP 计数（默认 panel.trust_proxy=false，取 socket 对端地址，
 * 伪造 X-Forwarded-For 绕不过），10 分钟窗口内 8 次失败才锁，计数只存后端内存、重启清零；
 * 前端不做本地失败次数与倒计时，换浏览器或清缓存就能重置的闸门不算闸门。
 */
async function submit() {
  if (!form.username || !form.password) return ElMessage.warning('请输入账号与口令');
  loading.value = true;
  try {
    await session.login(form.username, form.password);
    // redirect 由 router/index.js 的 beforeEach 在未登录拦截时写入
    router.replace(route.query.redirect || '/console');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    // 401/429 之后还得能再试，不能把按钮留在转圈态
    loading.value = false;
  }
}
</script>

<style scoped>
/* 暗底两层叠加：青色径向光 + 细网格纹理 */
.gate-view {
  height: 100%;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 18% 12%, rgba(15, 118, 110, 0.35), transparent 42%),
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 26px),
    var(--lab-ink);
  padding: 24px;
}
.gate-card {
  width: 396px;
  background: var(--lab-surface);
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r-lg);
  padding: 24px 26px 20px;
}
.gate-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
.gate-hd b { display: block; font-size: 17px; color: var(--lab-ink); line-height: 1.2; }
.gate-hd small { display: block; font-size: 12px; color: var(--lab-ink-4); }
.gate-form :deep(.el-form-item__label) { padding-bottom: 2px; }
.gate-submit { width: 100%; margin-top: 4px; }
.gate-rules { list-style: none; margin: 20px 0 0; padding: 12px 0 0; border-top: 1px dashed var(--lab-line); }
.gate-rules li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--lab-ink-3); padding: 3px 0; }
.gate-rules .el-icon { color: var(--lab-accent); }
.gate-note { font-size: 11.5px; color: var(--lab-ink-4); margin: 14px 0 0; line-height: 1.7; }
.gate-note code { background: var(--lab-fill); border-radius: 3px; padding: 1px 4px; }
</style>

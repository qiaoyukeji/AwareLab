<template>
  <div class="gate-view">
    <div class="gate-card">
      <div class="gate-hd">
        <BrandMark />
        <div>
          <b>AwareLab</b>
          <small>安全意识演练平台 · 管理端</small>
        </div>
      </div>

      <el-form class="gate-form" :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="管理员账号" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="口令">
          <el-input v-model="form.password" type="password" show-password placeholder="管理员口令" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" class="gate-submit" :loading="loading" @click="submit">进入控制台</el-button>
      </el-form>

      <ul class="gate-rules">
        <li><el-icon><Lock /></el-icon>仅可用于授权范围内使用的安全意识演练</li>
        <li><el-icon><Upload /></el-icon>未登记有效授权时，建站与发送一律拒绝</li>
        <li><el-icon><Message /></el-icon>邮件默认沙箱发送，采集数据只留在本机</li>
      </ul>

      <p class="gate-note">
        首次启动时后台路径、账号与口令随机写入 <code>server/config.yaml</code>，仅在本机可见。
      </p>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSession } from '../stores/session';
import BrandMark from './BrandMark.vue';

const route = useRoute();
const router = useRouter();
const session = useSession();
const loading = ref(false);
const form = reactive({ username: '', password: '' });

async function submit() {
  if (!form.username || !form.password) return ElMessage.warning('请输入账号与口令');
  loading.value = true;
  try {
    await session.login(form.username, form.password);
    router.replace(route.query.redirect || '/console');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
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

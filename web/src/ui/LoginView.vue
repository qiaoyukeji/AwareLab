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

      <!-- 第一步：账密。不做前端校验规则，空值由 submit() 一句提示挡下 -->
      <el-form v-if="step === 'account'" class="gate-form" :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="管理员或普通用户账号" @keyup.enter="submit" />
        </el-form-item>
        <el-form-item label="口令">
          <el-input v-model="form.password" type="password" show-password placeholder="登录口令" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" class="gate-submit" :loading="loading" @click="submit">进入控制台</el-button>
      </el-form>

      <!-- 第二步：短信验证码。普通用户开了短信认证后必经此步；管理员不会走到这里 -->
      <div v-else class="gate-form">
        <div class="gate-sms-hd">
          <el-icon><Cellphone /></el-icon>
          <div>
            <b>{{ purpose === 'bind' ? '验证手机号' : '短信验证' }}</b>
            <small v-if="purpose === 'bind' && hasStoredPhone">管理员已登记 {{ maskedPhone }}，验证码发到这个号；验证通过后不再需要每次输号</small>
            <small v-else-if="purpose === 'bind'">首次登录需要先绑定手机号，验证码会发到该号码</small>
            <small v-else>验证码已发送至 {{ maskedPhone }}，{{ validMinutes }} 分钟内有效</small>
          </div>
        </div>

        <el-form label-position="top" @submit.prevent="verify">
          <el-form-item v-if="purpose === 'bind'" label="手机号">
            <!-- 管理员建号时已登记号码：直接沿用，避免再手输一遍；要换号才展开输入框 -->
            <div v-if="hasStoredPhone && !useNewPhone" class="gate-phone-fixed">
              <b>{{ maskedPhone }}</b>
              <el-button text size="small" @click="switchPhone">换一个号码</el-button>
            </div>
            <el-input v-else v-model="form.phone" maxlength="11" placeholder="11 位手机号" @keyup.enter="sendCode" />
          </el-form-item>
          <el-form-item label="验证码">
            <div class="gate-code">
              <el-input v-model="form.code" maxlength="6" placeholder="6 位数字" @keyup.enter="verify" />
              <el-button :disabled="countdown > 0 || sending" :loading="sending" @click="sendCode">
                {{ countdown > 0 ? `${countdown}s 后重发` : '获取验证码' }}
              </el-button>
            </div>
          </el-form-item>
        </el-form>

        <el-button type="primary" class="gate-submit" :loading="verifying" @click="verify">验证并进入</el-button>
        <el-button text class="gate-back" @click="backToAccount">返回重新输入账号</el-button>
      </div>

      <!-- 这三条口径与产品定位一致：只服务授权范围内使用、无授权一律拒、默认沙箱且数据只留本机 -->
      <ul class="gate-rules">
        <li><el-icon><Lock /></el-icon>仅可用于授权范围内使用的安全意识演练</li>
        <li><el-icon><Upload /></el-icon>未登记有效授权时，建站与发送一律拒绝</li>
        <li><el-icon><Message /></el-icon>邮件默认沙箱发送，采集数据只留在本机</li>
      </ul>

      <!-- 后台路径 / 账号 / 口令首次启动随机生成并写进 server/config.yaml，所以这里不放"默认口令"提示 -->
      <p class="gate-note">
        首次启动时后台路径、管理员账号与口令随机写入 <code>server/config.yaml</code>，仅在本机可见。
      </p>
    </div>
  </div>
</template>

<script setup>
/**
 * 管理端登录页，路由 /login，不带 AppShell 外壳。
 * 两步：账密 → 短信验证码。是否进第二步完全由后端 /auth/login 的 sms_required 决定：
 * 管理员账号永远是单步；普通用户只有在管理员开启短信认证后才需要验码（未绑号时先绑号）。
 * 口令与验证码只留在内存的 reactive form 里，提交后随组件卸载消失，不写进 localStorage。
 */
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Cellphone, Lock, Message, Upload } from '@element-plus/icons-vue';
import { useSession } from '../stores/session';
import BrandMark from './BrandMark.vue';

const route = useRoute();
const router = useRouter();
const session = useSession();
// 提交中标志，驱动按钮转圈与禁用，防连点重复送出失败计数
const loading = ref(false);
const sending = ref(false);
const verifying = ref(false);
const step = ref('account');
const ticket = ref('');
const purpose = ref('login');
const maskedPhone = ref('');
const validMinutes = ref(5);
const countdown = ref(0);
// 管理员建号时可能已登记手机号：默认沿用，用户点「换一个号码」才展开输入框
const useNewPhone = ref(false);
const form = reactive({ username: '', password: '', phone: '', code: '' });
let timer = null;

const hasStoredPhone = computed(() => purpose.value === 'bind' && Boolean(maskedPhone.value));
const needPhoneInput = computed(() => purpose.value === 'bind' && (!hasStoredPhone.value || useNewPhone.value));
const phoneReady = computed(() => !needPhoneInput.value || /^1[3-9]\d{9}$/.test(form.phone));

/** 重发倒计时：后端 interval_seconds 是权威值，这里只做按钮可用性，不做安全判定。 */
function startCountdown(seconds) {
  countdown.value = Number(seconds) || 60;
  clearInterval(timer);
  timer = setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) clearInterval(timer);
  }, 1000);
}

onBeforeUnmount(() => clearInterval(timer));

/** 进入第二步：bind 场景不自动发码（还没确认号码），login 场景直接发。 */
async function enterSms(data) {
  ticket.value = data.ticket;
  purpose.value = data.purpose === 'bind' ? 'bind' : 'login';
  maskedPhone.value = data.phone_masked || '';
  step.value = 'sms';
  form.code = '';
  form.phone = '';
  useNewPhone.value = false;
  // 号已定（已绑定或管理员预填）就直接发码，不用再点一次「获取验证码」
  if (purpose.value === 'login' || hasStoredPhone.value) await sendCode();
}

/** 换号：清空输入，走「填写新号码」分支；新号同样要过验证码才生效。 */
function switchPhone() {
  useNewPhone.value = true;
  form.phone = '';
  form.code = '';
  maskedPhone.value = '';
  countdown.value = 0;
  clearInterval(timer);
}

/**
 * 提交登录。字段为空只弹提示不打后端，省一次必然 401 的往返，也不白耗该 IP 的失败计数；
 * 成功（或需要短信）后由后端决定下一步；直接签发时 replace 到 redirect 目标或 /console。
 */
async function submit() {
  if (!form.username || !form.password) return ElMessage.warning('请输入账号与口令');
  loading.value = true;
  try {
    const data = await session.login(form.username, form.password);
    if (data?.sms_required) return await enterSms(data);
    router.replace(route.query.redirect || '/console');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

/** 发码 / 重发：有已登记号码时后端直接用票据里的号；换号或从未登记才把输入框的值带上。 */
async function sendCode() {
  if (sending.value || countdown.value > 0) return;
  if (!phoneReady.value) return ElMessage.warning('请输入正确的 11 位手机号');
  sending.value = true;
  try {
    const data = await session.sendSmsCode(ticket.value, needPhoneInput.value ? form.phone : '');
    maskedPhone.value = data.phone_masked || maskedPhone.value;
    validMinutes.value = Math.max(1, Math.round((data.valid_time || 300) / 60));
    startCountdown(data.interval_seconds || 60);
    ElMessage.success(`验证码已发送至 ${maskedPhone.value}`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sending.value = false;
  }
}

/** 校验验证码：PASS 后后端签发会话，直接进控制台，不再回第一步。 */
async function verify() {
  if (!/^\d{4,8}$/.test(form.code)) return ElMessage.warning('请输入短信里的数字验证码');
  verifying.value = true;
  try {
    await session.verifySmsCode(ticket.value, form.code, needPhoneInput.value ? form.phone : '');
    router.replace(route.query.redirect || '/console');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    verifying.value = false;
  }
}

function backToAccount() {
  step.value = 'account';
  ticket.value = '';
  form.code = '';
  form.phone = '';
  useNewPhone.value = false;
  clearInterval(timer);
  countdown.value = 0;
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
.gate-back { width: 100%; margin: 8px 0 0; color: var(--lab-ink-3); }
.gate-sms-hd { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin-bottom: 14px; background: var(--lab-accent-soft); border-radius: var(--lab-r-sm); }
.gate-sms-hd .el-icon { color: var(--lab-accent); font-size: 18px; margin-top: 2px; }
.gate-sms-hd b { display: block; font-size: 13.5px; color: var(--lab-ink); }
.gate-sms-hd small { display: block; font-size: 12px; color: var(--lab-ink-3); line-height: 1.6; margin-top: 2px; }
.gate-code { display: flex; gap: 8px; width: 100%; }.gate-code .el-input { flex: 1; }
.gate-code .el-button { flex: none; width: 116px; }
/* 已登记号码：只读展示 + 换号入口，占位高度与 el-input 对齐 */
.gate-phone-fixed {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 32px;
  padding: 0 11px;
  background: var(--lab-fill);
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r-sm);
}
.gate-phone-fixed b { font-family: var(--lab-mono, ui-monospace), monospace; letter-spacing: 0.5px; }
.gate-rules { list-style: none; margin: 20px 0 0; padding: 12px 0 0; border-top: 1px dashed var(--lab-line); }
.gate-rules li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--lab-ink-3); padding: 3px 0; }
.gate-rules .el-icon { color: var(--lab-accent); }
.gate-note { font-size: 11.5px; color: var(--lab-ink-4); margin: 14px 0 0; line-height: 1.7; }
.gate-note code { background: var(--lab-fill); border-radius: 3px; padding: 1px 4px; }
</style>

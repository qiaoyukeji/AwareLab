<template>
  <el-dialog
    :model-value="modelValue"
    title="修改登录口令"
    width="420px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="reset"
  >
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="当前口令">
        <el-input v-model="form.current" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新口令">
        <el-input v-model="form.next" type="password" show-password autocomplete="new-password" placeholder="8~64 位，且不能与当前口令相同" />
      </el-form-item>
      <el-form-item label="再输一次">
        <el-input v-model="form.repeat" type="password" show-password autocomplete="new-password" />
      </el-form-item>
    </el-form>
    <p class="lab-hint is-mute" style="margin: 0">
      改完会注销本账号的所有会话（含当前这条），需要用新口令重新登录；其他账号的会话不受影响。
    </p>
    <template #footer>
      <el-button size="small" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" size="small" :loading="saving" :disabled="!ready" @click="submit">保存并重新登录</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
/**
 * 改口令弹窗：任何登录账号都能用（普通用户没有系统设置页，只能从这里改）。
 * 只做前端形状校验，长度/重复规则最终以后端 400 文案为准；成功后 stores/session.js 会清本地并跳登录，这里不再导航。
 */
import { computed, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useSession } from '../stores/session';

defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue']);

const session = useSession();
const saving = ref(false);
const form = reactive({ current: '', next: '', repeat: '' });

const ready = computed(() => form.current && form.next.length >= 8 && form.next.length <= 64 && form.repeat === form.next);

function reset() {
  form.current = '';
  form.next = '';
  form.repeat = '';
}

async function submit() {
  if (!ready.value) return;
  saving.value = true;
  try {
    await session.changePassword(form.current, form.next);
    ElMessage.success('口令已修改，请用新口令重新登录');
    emit('update:modelValue', false);
  } catch (error) {
    ElMessage.error(error?.message || '修改失败，请检查当前口令');
  } finally {
    saving.value = false;
  }
}
</script>

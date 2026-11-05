<template>
  <div class="lab-stack">
    <LabPane
      title="账号管理"
      hint="管理员账号只有启动时那一个；这里创建和维护普通用户，短信认证开启后他们登录要验手机号"
    >
      <template #ops>
        <el-button size="small" @click="load">刷新</el-button>
        <el-button type="primary" size="small" @click="openCreate">新建普通用户</el-button>
      </template>

      <div class="acct-summary">
        <div class="acct-stat">
          <span class="acct-num">{{ items.length }}</span>
          <span class="acct-label">账号总数</span>
        </div>
        <div class="acct-stat">
          <span class="acct-num">{{ admins }}</span>
          <span class="acct-label">启用中的管理员</span>
        </div>
        <div class="acct-stat" :class="{ 'is-warn': smsOn }">
          <span class="acct-num">{{ smsOn ? '已开启' : '未开启' }}</span>
          <span class="acct-label">短信认证</span>
        </div>
        <p class="lab-hint is-mute acct-tip">
          {{ smsOn
            ? '短信认证已开启：普通用户登录时除账号口令外还要短信验证码；未绑定手机号的会先走绑定流程。管理员账号不受影响。'
            : '短信认证未开启：普通用户仅凭账号口令登录。开启入口在「系统设置 · 短信认证」，需要先填阿里云密钥。' }}
        </p>
      </div>

      <el-table :data="items" size="small" v-loading="loading">
        <el-table-column prop="username" label="账号" min-width="140">
          <template #default="{ row }">
            <b>{{ row.username }}</b>
            <span v-if="row.role === 'admin'" class="lab-chip is-accent acct-role">管理员</span>
          </template>
        </el-table-column>
        <el-table-column prop="display_name" label="显示名" min-width="110">
          <template #default="{ row }">{{ row.display_name || '—' }}</template>
        </el-table-column>
        <el-table-column label="手机号" min-width="150">
          <template #default="{ row }">
            <span v-if="row.phone" class="mono-inline">{{ row.phone }}</span>
            <span v-else class="lab-hint is-mute">未绑定</span>
            <span v-if="row.phone && row.phone_verified" class="lab-chip is-ok acct-role">已验证</span>
            <span v-else-if="row.phone" class="lab-chip is-warn acct-role">待验证</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="88">
          <template #default="{ row }">
            <span class="lab-dot" :class="row.status === 'active' ? 'is-ok' : 'is-mute'" />
            {{ row.status === 'active' ? '启用' : '停用' }}
          </template>
        </el-table-column>
        <el-table-column prop="last_login_at" label="最近登录" min-width="160">
          <template #default="{ row }">{{ fmt(row.last_login_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="252" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.role !== 'admin'" link type="primary" @click="openReset(row)">重置口令</el-button>
            <el-button
              v-if="row.role !== 'admin'"
              link
              :type="row.status === 'active' ? 'warning' : 'success'"
              @click="toggleStatus(row)"
            >
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
            <el-button v-if="row.role !== 'admin' && row.username !== session.username" link type="danger" @click="removeUser(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </LabPane>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="dialog" :title="editing ? '编辑账号' : '新建普通用户'" width="480px">
      <el-form label-position="top">
        <el-form-item label="账号（登录名）">
          <el-input v-model="form.username" :disabled="editing" maxlength="32" placeholder="3-32 位字母、数字、下划线、点或短横线" />
        </el-form-item>
        <el-form-item label="显示名">
          <el-input v-model="form.display_name" maxlength="40" placeholder="如：市场部 张三（可留空）" />
        </el-form-item>
        <el-form-item v-if="!editing" label="初始口令">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 8 位，交付后请本人自行修改" />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input v-model="form.phone" maxlength="11" placeholder="11 位手机号；短信认证开启时必填" />
          <div class="lab-hint is-mute" style="margin-top: 4px">
            管理员代填的号码尚未验证，本人首次登录会收到一次验证码并完成绑定。
          </div>
        </el-form-item>
        <el-form-item v-if="editing" label="状态">
          <el-radio-group v-model="form.status">
            <el-radio-button value="active">启用</el-radio-button>
            <el-radio-button value="disabled">停用</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ editing ? '保存' : '创建账号' }}</el-button>
      </template>
    </el-dialog>

    <!-- 重置口令 -->
    <el-dialog v-model="resetDialog" title="重置口令" width="420px">
      <p class="lab-hint" style="margin-top: 0">
        为 <b>{{ resetTarget?.username }}</b> 设置新的初始口令；本人下次登录后应立即修改。该账号现有会话不会被清掉。
      </p>
      <el-input v-model="resetPasswordValue" type="password" show-password placeholder="至少 8 位" />
      <template #footer>
        <el-button @click="resetDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitReset">确认重置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
/**
 * 账号管理（管理员）：列出 users、建普通用户、改显示名/手机号/状态、重置口令、删除。
 * 管理员账号本身只由启动种子产生：界面既不提供「新建管理员」，也不提供改角色，避免互相提权。
 * 手机号由管理员代填时是「待验证」，本人首次登录会走短信绑定；短信开关状态只是提示，真正的拦截在后端登录流程。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import { useSession } from '../../stores/session';

const session = useSession();
const items = ref([]);
const admins = ref(0);
const smsOn = ref(false);
const loading = ref(false);
const saving = ref(false);

const dialog = ref(false);
const editing = ref(false);
const editId = ref('');
const form = reactive({ username: '', display_name: '', password: '', phone: '', status: 'active' });

const resetDialog = ref(false);
const resetTarget = ref(null);
const resetPasswordValue = ref('');

const fmt = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');

/** 拉账号列表与短信开关：/users 只给管理员，普通用户访问会 403（导航里也不会出现本页）。 */
async function load() {
  loading.value = true;
  try {
    const data = await http.get('/users');
    items.value = data.items || [];
    admins.value = data.admins || 0;
    const settings = await http.get('/settings');
    smsOn.value = Boolean(settings.sms?.enabled) && settings.sms_ready !== false;
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = false;
  editId.value = '';
  Object.assign(form, { username: '', display_name: '', password: '', phone: '', status: 'active' });
  dialog.value = true;
}

function openEdit(row) {
  editing.value = true;
  editId.value = row.id;
  Object.assign(form, {
    username: row.username,
    display_name: row.display_name || '',
    password: '',
    phone: row.phone || '',
    status: row.status,
  });
  dialog.value = true;
}

async function submit() {
  if (!editing.value) {
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(form.username)) return ElMessage.warning('账号需 3-32 位字母、数字、下划线、点或短横线');
    if (String(form.password).length < 8) return ElMessage.warning('初始口令至少 8 位');
  }
  saving.value = true;
  try {
    if (editing.value) {
      await http.put(`/users/${editId.value}`, {
        display_name: form.display_name,
        phone: form.phone,
        status: form.status,
      });
      ElMessage.success('已保存');
    } else {
      await http.post('/users', {
        username: form.username,
        display_name: form.display_name,
        password: form.password,
        phone: form.phone,
      });
      ElMessage.success('账号已创建');
    }
    dialog.value = false;
    await load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row) {
  const next = row.status === 'active' ? 'disabled' : 'active';
  if (next === 'disabled') {
    try {
      await ElMessageBox.confirm(`停用后「${row.username}」将立即掉线且无法登录，确定继续？`, '停用账号', {
        type: 'warning',
        confirmButtonText: '停用',
        cancelButtonText: '取消',
      });
    } catch {
      return;
    }
  }
  try {
    await http.put(`/users/${row.id}`, { status: next });
    ElMessage.success(next === 'active' ? '已启用' : '已停用');
    await load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

function openReset(row) {
  resetTarget.value = row;
  resetPasswordValue.value = '';
  resetDialog.value = true;
}

async function submitReset() {
  if (String(resetPasswordValue.value).length < 8) return ElMessage.warning('新口令至少 8 位');
  saving.value = true;
  try {
    await http.post(`/users/${resetTarget.value.id}/password`, { password: resetPasswordValue.value });
    ElMessage.success('口令已重置');
    resetDialog.value = false;
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function removeUser(row) {
  try {
    await ElMessageBox.confirm(`删除「${row.username}」后该账号的会话一并失效，操作不可撤销。`, '删除账号', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  try {
    await http.delete(`/users/${row.id}`);
    ElMessage.success('已删除');
    await load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

onMounted(load);
</script>

<style scoped>
.acct-summary {
  display: grid;
  grid-template-columns: repeat(3, 150px) minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}
.acct-stat {
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r-sm);
  padding: 10px 12px;
  background: var(--lab-fill-2);
}
.acct-stat.is-warn { border-color: #f0d9b5; background: var(--lab-warn-soft); }
.acct-num { display: block; font-size: 18px; font-weight: 600; color: var(--lab-ink); line-height: 1.3; }
.acct-stat.is-warn .acct-num { color: var(--lab-warn); }
.acct-label { font-size: 11.5px; color: var(--lab-ink-4); }
.acct-tip { margin: 0; }
.acct-role { margin-left: 6px; }
</style>

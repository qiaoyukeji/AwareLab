<template>
  <div class="lab-stack">
    <LabPane title="发信邮箱" hint="账号是留存资产：在此登记一次，发送任务里一键复用，无需重复录入。">
      <template #ops>
        <span class="lab-chip" :class="gate ? 'is-ok' : 'is-warn'">
          {{ gate ? `授权生效 · ${gate.scope}` : '未登记有效授权' }}
        </span>
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增账号</el-button>
      </template>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="密码只写不读"
        description="授权码 / 密码仅保存在本机 SQLite 文件中，列表与编辑面板均不回显明文；发送任务选择账号后即可复用，不需要再次输入。"
        style="margin-bottom: 12px"
      />

      <el-table :data="rows" size="small">
        <el-table-column prop="name" label="配置名称" min-width="140" show-overflow-tooltip />
        <el-table-column prop="host" label="SMTP 主机" min-width="160" show-overflow-tooltip />
        <el-table-column prop="port" label="端口" width="80" />
        <el-table-column label="加密" width="120">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.secure ? 'is-accent' : ''">{{ row.secure ? 'SSL/TLS' : 'STARTTLS/明文' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="user" label="登录账号" min-width="160" show-overflow-tooltip />
        <el-table-column label="密码" width="90">
          <template #default="{ row }"><span class="lab-mono" style="background: var(--lab-fill); color: var(--lab-ink-3); padding: 2px 6px">{{ row.pass }}</span></template>
        </el-table-column>
        <el-table-column prop="from_addr" label="发信地址" min-width="160" show-overflow-tooltip />
        <el-table-column prop="from_name" label="发件人名称" min-width="130" show-overflow-tooltip />
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :loading="testingId === row.id" @click="test(row)">连通性测试</el-button>
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty><div class="lab-empty">还没有留存发信邮箱，点击右上角「新增账号」登记。</div></template>
      </el-table>
    </LabPane>
  </div>

  <el-drawer v-model="drawer" :title="editingId ? '编辑发信邮箱' : '新增发信邮箱'" size="560px">
    <div class="lab-stack" style="padding: 4px 2px">
      <div class="lab-stack">
        <div class="sec-title lab-strong">连接参数</div>
        <el-form label-width="110px" label-position="left">
          <el-form-item label="配置名称"><el-input v-model="form.name" placeholder="如：企业微信邮箱" /></el-form-item>
          <el-form-item label="SMTP 主机" required><el-input v-model="form.host" placeholder="smtp.example.com" /></el-form-item>
          <el-form-item label="端口" required><el-input-number v-model="form.port" :min="1" :max="65535" /></el-form-item>
          <el-form-item label="SSL/TLS"><el-switch v-model="form.secure" /></el-form-item>
        </el-form>
      </div>

      <div class="lab-stack">
        <div class="sec-title lab-strong">凭据与署名</div>
        <el-form label-width="110px" label-position="left">
          <el-form-item label="登录账号" required><el-input v-model="form.user" /></el-form-item>
          <el-form-item label="授权码/密码" :required="!editingId">
            <el-input v-model="form.pass" type="password" show-password :placeholder="editingId ? '留空表示不修改原密码' : '仅保存在本机，不回显'" />
          </el-form-item>
          <el-form-item label="发信地址" required><el-input v-model="form.from_addr" placeholder="it-center@example.com" /></el-form-item>
          <el-form-item label="发件人名称"><el-input v-model="form.from_name" placeholder="企业IT服务中心" /></el-form-item>
        </el-form>
        <p class="lab-hint is-mute">保存后密码即“只写不读”：接口返回列表统一以掩码展示，平台不提供读取入口。</p>
      </div>
    </div>
    <template #footer>
      <el-button @click="drawer = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-drawer>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

defineProps({ gate: { type: Object, default: null } });

const rows = ref([]);
const drawer = ref(false);
const editingId = ref('');
const saving = ref(false);
const testingId = ref('');
const form = reactive({
  name: '', host: '', port: 465, secure: true, user: '', pass: '', from_addr: '', from_name: '',
});

async function load() {
  const data = await http.get('/smtp-profiles');
  rows.value = data.rows;
}

function openCreate() {
  editingId.value = '';
  Object.assign(form, { name: '', host: '', port: 465, secure: true, user: '', pass: '', from_addr: '', from_name: '' });
  drawer.value = true;
}

function openEdit(row) {
  editingId.value = row.id;
  Object.assign(form, {
    name: row.name, host: row.host, port: row.port, secure: Boolean(row.secure),
    user: row.user, pass: '', from_addr: row.from_addr, from_name: row.from_name || '',
  });
  drawer.value = true;
}

async function save() {
  if (!form.host || !form.user || !form.from_addr) return ElMessage.warning('SMTP 主机、登录账号、发信地址必填');
  if (!editingId.value && !form.pass) return ElMessage.warning('新增账号必须填写授权码/密码');
  saving.value = true;
  try {
    if (editingId.value) {
      const payload = { ...form };
      if (!payload.pass) delete payload.pass;
      await http.put(`/smtp-profiles/${editingId.value}`, payload);
    } else {
      await http.post('/smtp-profiles', form);
    }
    ElMessage.success('已保存');
    drawer.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function test(row) {
  testingId.value = row.id;
  try {
    const data = await http.post(`/smtp-profiles/${row.id}/test`);
    ElMessage.success(`连接成功：${data.host}:${data.port}`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    testingId.value = '';
  }
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除发信邮箱「${row.name}」？已绑定该账号的发送任务需重新选择。`, '删除确认', { type: 'warning' });
  await http.delete(`/smtp-profiles/${row.id}`);
  load();
}

onMounted(load);
</script>

<style scoped>
.sec-title {
  font-size: 12.5px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--lab-line-2);
}
</style>

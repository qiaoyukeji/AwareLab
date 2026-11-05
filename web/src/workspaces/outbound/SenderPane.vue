<template>
  <div class="lab-stack">
    <!-- 账号是留存资产：任务删了账号还在，换身份只改下拉，不必重录主机端口口令 -->
    <LabPane title="发信邮箱" hint="账号是留存资产：在此登记一次，发送任务里一键复用，无需重复录入。">
      <template #ops>
        <!-- 本页不过门禁：登记账号不发信，这里只提示配好账号不等于现在能发 -->
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
        <!-- 只判 secure 布尔：界面不说破 465 与 587 的协议差别，选错口由连通性测试兜住 -->
        <el-table-column label="加密" width="120">
          <template #default="{ row }">
            <span class="lab-chip" :class="row.secure ? 'is-accent' : ''">{{ row.secure ? 'SSL/TLS' : 'STARTTLS/明文' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="user" label="登录账号" min-width="160" show-overflow-tooltip />
        <!-- 这列是服务端下发的固定掩码，不是前端打码的真口令；user 可读、pass 永不可读 -->
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

  <!-- 新增与编辑共用一个抽屉，标题和必填标记随 editingId 切换 -->
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
        <!-- 敏感区：口令只写不读，编辑时框里永远是空的，必填标记也跟着 editingId 变 -->
        <div class="sec-title lab-strong">凭据与署名</div>
        <el-form label-width="110px" label-position="left">
          <el-form-item label="登录账号" required><el-input v-model="form.user" /></el-form-item>
          <!-- 新增没口令连不上；编辑留空表示保持原口令，不是清空 -->
          <el-form-item label="授权码/密码" :required="!editingId">
            <el-input v-model="form.pass" type="password" show-password :placeholder="editingId ? '留空表示不修改原密码' : '仅保存在本机，不回显'" />
          </el-form-item>
          <!-- 发信地址必填，且可以与登录账号不同；收件人看到的 From 由它决定 -->
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
/**
 * 发信邮箱（SMTP 配置档）台账：登记一次、发送任务里复用，任务删了账号还在。
 * 口令只写不读，服务端每个出口都把 pass 换成掩码；编辑时留空表示不改口令，
 * 把掩码串当新口令提交会让库里的凭据变成星号，之后所有真实发信都认证失败。
 */
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Plus, Refresh } from '@element-plus/icons-vue';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

// gate 为 null 表示没有生效授权；本页只用它写提示，不参与请求放行
defineProps({ gate: { type: Object, default: null } });

// 服务端已把 pass 换成掩码，界面从不接触真口令
const rows = ref([]);
const drawer = ref(false);
// 空串=新增，非空=编辑这个 id；决定走 POST 还是 PUT，也决定口令是否必填
const editingId = ref('');
// 防一次点击发出两条 POST，SMTP 档会多出一行重复凭据
const saving = ref(false);
// 只有被点的那行转圈，共用一个布尔会点亮整列表
const testingId = ref('');
// 默认 465 + secure=true 就是新账号的默认出口，明文 25 一旦成为默认，口令能在链路上被读到；pass 初值必须是空串
const form = reactive({
  name: '', host: '', port: 465, secure: true, user: '', pass: '', from_addr: '', from_name: '',
});

/** GET /smtp-profiles 无分页，服务端一次给全；每次写操作后重跑，用掩码行覆盖本地状态 */
async function load() {
  const data = await http.get('/smtp-profiles');
  rows.value = data.rows;
}

/** 表单回到空白默认值；口令必须是空串，上一账号的凭据不能残留进下一个提交体 */
function openCreate() {
  editingId.value = '';
  // 与 reactive 初值逐字段对齐，漏一个就把上一次编辑的值带给新账号
  Object.assign(form, { name: '', host: '', port: 465, secure: true, user: '', pass: '', from_addr: '', from_name: '' });
  drawer.value = true;
}

/**
 * 用列表行回填表单，口令强制留空：row.pass 是掩码，一旦当真口令提交，库里的凭据就变成星号。
 * 不带 pass 的 PUT 被服务端解释成不改口令。
 */
function openEdit(row) {
  editingId.value = row.id;
  Object.assign(form, {
    name: row.name, host: row.host, port: row.port, secure: Boolean(row.secure),
    user: row.user, pass: '', from_addr: row.from_addr, from_name: row.from_name || '',
  });
  drawer.value = true;
}

/**
 * 新增走 POST，编辑走 PUT；host/user/from_addr 必填，新增还必须有口令，服务端同一套再验一遍。
 * 服务端审计 smtp.create / smtp.update 只记口令换没换；失败直回服务端原因，不静默。
 */
async function save() {
  if (!form.host || !form.user || !form.from_addr) return ElMessage.warning('SMTP 主机、登录账号、发信地址必填');
  if (!editingId.value && !form.pass) return ElMessage.warning('新增账号必须填写授权码/密码');
  saving.value = true;
  try {
    if (editingId.value) {
      // 先浅拷贝再动字段，直接 delete form.pass 会抹掉输入框里的口令
      const payload = { ...form };
      // 空口令 = 不改口令：字段整个删掉再提交，服务端才分不清传了空串和没传
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

/**
 * 连通性测试让服务端真连一次 SMTP 并登录：只建外连，不发消息、不写业务表，不等于投放。
 * 耗时可能几十秒所以按行转圈；演练前先在这里验通，否则任务页一投就整批失败。
 */
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

/** 已绑定该档的发送任务不级联删除，但下次发送会因为没有发信邮箱被拒，所以必须人工确认 */
async function remove(row) {
  await ElMessageBox.confirm(`确认删除发信邮箱「${row.name}」？已绑定该账号的发送任务需重新选择。`, '删除确认', { type: 'warning' });
  try {
    await http.delete(`/smtp-profiles/${row.id}`);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

// KeepAlive 缓存标签页，只有首次挂载走这里，切回来靠刷新按钮
onMounted(load);
</script>

<style scoped>
/* 小节标题用虚线分隔，不和面板自身的实线边框抢注意力 */
.sec-title {
  font-size: 12.5px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--lab-line-2);
}
</style>

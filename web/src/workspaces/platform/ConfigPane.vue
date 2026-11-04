<template>
  <div class="lab-stack">
    <!-- ① 平台运行参数 -->
    <LabPane title="平台运行参数" hint="端口、沙箱与模型服务；改完即刻生效，无需重启">
      <template #ops>
        <el-button size="small" @click="load">重新读取</el-button>
      </template>

      <div class="lab-kv run-kv">
        <span>管理后台路径 <b>/{{ info.panel_path || 'panel' }}/</b></span>
        <span>管理端口 <b>{{ info.panel_port ?? '—' }}</b></span>
        <span>采集端口范围 <b>{{ (info.capture_port_range || []).join(' - ') || '—' }}</b></span>
        <span>邮件默认沙箱 <b>{{ info.mail_default_dry_run ? '是（不真实发信）' : '否（真实发送）' }}</b></span>
        <span>数据库 <b>{{ info.db_driver || '—' }} · {{ info.db_path || '—' }}</b></span>
      </div>
      <p class="lab-hint is-mute">
        管理端口、采集端口范围与邮件默认沙箱在 <span class="mono-inline">server/config.yaml</span> 中修改后重启生效；
        这里的模型服务与通知通道属于运行期数据，保存在平台自己的设置表里。
      </p>

      <div class="sub-hd">
        <span class="lab-strong">模型服务</span>
        <span class="lab-hint">兼容 OpenAI Chat Completions 协议的任意服务（DeepSeek、阿里云百炼、硅基流动、MiniMax 等），用于网站素材的生成辅助。</span>
      </div>
      <el-table :data="ai.providers" size="small">
        <el-table-column prop="name" label="厂商名称" min-width="110" />
        <el-table-column prop="base_url" label="接口地址" min-width="200" show-overflow-tooltip />
        <el-table-column prop="model" label="模型" min-width="120" show-overflow-tooltip />
        <el-table-column prop="api_key" label="API Key" min-width="130">
          <template #default="{ row }"><span class="mono-inline">{{ mask(row.api_key) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ $index }">
            <el-button link type="primary" @click="editProvider($index)">编辑</el-button>
            <el-button link type="danger" @click="removeProvider($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!ai.providers.length" class="lab-empty">还没有模型服务配置项，可直接新建假登录页模板替代。</div>
      <div class="lab-toolbar" style="margin-top: 12px; margin-bottom: 0">
        <el-button size="small" @click="createProvider">新增厂商</el-button>
        <span class="lab-spacer" />
        <el-button type="primary" size="small" :loading="saving === 'ai'" @click="save('ai')">保存模型服务</el-button>
      </div>
    </LabPane>

    <!-- ② 通知通道 -->
    <LabPane title="通知通道" hint="演练事件推送到协作机器人：默认脱敏，不含邮箱、凭据与被提交的字段名">
      <template #ops>
        <el-switch v-model="push.redact" active-text="脱敏推送" />
        <el-switch v-model="push.enabled" active-text="启用事件推送" />
      </template>

      <el-table :data="push.channels" size="small">
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ CHANNEL_LABEL[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column prop="url" label="Webhook 地址" min-width="220" show-overflow-tooltip />
        <el-table-column label="订阅事件" min-width="220">
          <template #default="{ row }">
            <span v-for="e in row.events || []" :key="e" class="lab-chip is-accent ev-chip">{{ EVENTS[e] || e }}</span>
            <span v-if="!row.events?.length" class="lab-chip is-warn">未订阅任何事件</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ $index }">
            <el-button link type="primary" @click="editChannel($index)">编辑</el-button>
            <el-button link type="danger" @click="removeChannel($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="!push.channels.length" class="lab-empty">尚未配置通知通道。</div>
      <div class="lab-toolbar" style="margin-top: 12px; margin-bottom: 0">
        <el-button size="small" @click="createChannel">新增通道</el-button>
        <span class="lab-spacer" />
        <el-button type="primary" size="small" :loading="saving === 'push'" @click="save('push')">保存推送配置</el-button>
      </div>
      <p class="lab-hint is-mute" style="margin: 12px 0 0">
        网页打开、网页填写、邮件打开、附件运行等事件可推送至钉钉 / 企业微信 / 飞书机器人 Push 接口；
        推送记录本身在「上钩记录 · 通知记录」可回溯。
      </p>
      <p class="lab-hint is-mute" style="margin: 6px 0 0">
        脱敏推送开启时，消息里的员工邮箱换成不可逆短代号（同一个人每次相同，便于对上号），提交的字段名只报数量。
        关掉它就等于把「谁在什么时间上钩、交了哪些栏位」原样寄给第三方 IM 群，请确认群成员范围后再关。
        机器人地址走明文 http 会被拒绝，本机回环（127.0.0.1）除外，方便本地联调。
      </p>
    </LabPane>

    <!-- ③ 演练边界 -->
    <LabPane title="演练边界" hint="这一节是只读约束，不是可协商开关">
      <div class="edge">
        <div class="edge-row">
          <span class="lab-chip" :class="info.require_authorization ? 'is-ok' : 'is-danger'">
            {{ info.require_authorization ? '授权硬性要求：开启' : '授权硬性要求：已在配置文件中关闭' }}
          </span>
          <p class="lab-hint">
            <span class="lab-strong">require_authorization 属硬性要求，不提供在线关闭入口。</span>
            无有效授权时建站、开启监听与邮件发送一律被拒绝；不在授权名单里的域名访问钓鱼网站，只会看到服务不可用。
            该值在 <span class="mono-inline">server/config.yaml</span> 的 <span class="mono-inline">exercise.require_authorization</span> 定义，
            AwareLab 把它作为前置硬约束保留，界面上没有任何绕过开关。
          </p>
        </div>

        <div class="edge-row">
          <span class="lab-strong">以下能力被刻意不做实现，因为它们只服务于真实攻击、与演练目标无关：</span>
          <ul class="edge-list">
            <li>反溯源 / 反检测（沙箱逃逸、杀软绕过、指纹伪装、验证码规避）</li>
            <li>凭据实时转发到第三方网站（会让被采集口令直接流入攻击者）</li>
            <li>免杀载荷生成、木马投递</li>
          </ul>
        </div>

        <div class="edge-row">
          <span class="lab-strong">数据留存：</span>
          <p class="lab-hint">
            采集到的字段只写入本机数据库（<span class="mono-inline">{{ info.db_path || '本机 SQLite' }}</span>），
            CSV 导出由操作者自行保管与销毁；开始演练前必须登记授权主体、时间窗口与授权名单。
          </p>
        </div>
      </div>
    </LabPane>

    <!-- 抽屉式编辑：不弹窗 -->
    <el-drawer v-model="drawer" :title="drawerTitle" size="440px" direction="rtl">
      <el-form v-if="kind === 'ai'" label-position="top">
        <el-form-item label="厂商名称"><el-input v-model="draft.name" placeholder="如 DeepSeek" /></el-form-item>
        <el-form-item label="接口地址"><el-input v-model="draft.base_url" placeholder="https://api.example.com/v1" /></el-form-item>
        <el-form-item label="模型"><el-input v-model="draft.model" placeholder="deepseek-chat" /></el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="draft.api_key" type="password" show-password placeholder="仅保存在本机设置表" />
        </el-form-item>
        <p class="lab-hint is-mute">Key 只写进本机数据库，读取列表时一律掩码回显，不会出现在导出与推送内容里。</p>
      </el-form>

      <el-form v-else label-position="top">
        <el-form-item label="通道类型">
          <el-select v-model="draft.type" style="width: 100%">
            <el-option v-for="(label, key) in CHANNEL_LABEL" :key="key" :label="label" :value="key" />
          </el-select>
        </el-form-item>
        <el-form-item label="Webhook 地址"><el-input v-model="draft.url" placeholder="https://oapi.example.com/robot/send?access_token=…" /></el-form-item>
        <el-form-item label="订阅事件">
          <el-select v-model="draft.events" multiple collapse-tags placeholder="选择要推送的事件" style="width: 100%">
            <el-option v-for="(label, key) in EVENTS" :key="key" :label="label" :value="key" />
          </el-select>
        </el-form-item>
        <p class="lab-hint is-mute">推送内容仅含事件类型、时间与目标标识，不包含表单字段值。</p>
      </el-form>

      <template #footer>
        <div class="drawer-foot">
          <el-button @click="drawer = false">取消</el-button>
          <el-button type="primary" @click="applyDraft">确定</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';

defineProps({ gate: { type: Object, default: null } });

const EVENTS = {
  page_open: '网页打开',
  form_fill: '网页填写',
  mail_open: '邮件打开',
  mail_send: '邮件发送',
  attachment_run: '附件运行',
};
const CHANNEL_LABEL = { dingtalk: '钉钉', wecom: '企业微信', feishu: '飞书' };

const ai = reactive({ providers: [] });
const push = reactive({ enabled: false, channels: [], redact: true });
const info = ref({});
const saving = ref('');

const drawer = ref(false);
const kind = ref('ai');
const draftIndex = ref(-1);
const draft = reactive({ id: '', name: '', base_url: '', model: '', api_key: '', type: 'dingtalk', url: '', events: [] });

const drawerTitle = computed(() => {
  if (kind.value === 'ai') return draftIndex.value >= 0 ? '编辑模型服务' : '新增模型服务';
  return draftIndex.value >= 0 ? '编辑通知通道' : '新增通知通道';
});

const mask = (k) => (k ? `${String(k).slice(0, 4)}****${String(k).slice(-4)}` : '未设置');

async function load() {
  const data = await http.get('/settings');
  Object.assign(ai, { providers: data.ai?.providers || [] });
  Object.assign(push, { enabled: !!data.push?.enabled, channels: data.push?.channels || [], redact: data.push?.redact !== false });
  info.value = data;
}

function saveDraft() {
  drawer.value = true;
}

function createProvider() {
  kind.value = 'ai';
  draftIndex.value = -1;
  Object.assign(draft, { id: '', name: '', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: '' });
  saveDraft();
}

function editProvider(index) {
  kind.value = 'ai';
  draftIndex.value = index;
  const row = ai.providers[index] || {};
  Object.assign(draft, { id: row.id || '', name: row.name || '', base_url: row.base_url || '', model: row.model || '', api_key: row.api_key || '' });
  saveDraft();
}

function removeProvider(index) {
  ai.providers.splice(index, 1);
}

function createChannel() {
  kind.value = 'push';
  draftIndex.value = -1;
  Object.assign(draft, { type: 'dingtalk', url: '', events: [] });
  saveDraft();
}

function editChannel(index) {
  kind.value = 'push';
  draftIndex.value = index;
  const row = push.channels[index] || {};
  Object.assign(draft, { type: row.type || 'dingtalk', url: row.url || '', events: [...(row.events || [])] });
  saveDraft();
}

function removeChannel(index) {
  push.channels.splice(index, 1);
}

function applyDraft() {
  if (kind.value === 'ai') {
    // id 是这一行的身份：带着它回填，改名就不会被服务端当成新厂商而清掉密钥
    const row = { id: draft.id || crypto.randomUUID(), name: draft.name, base_url: draft.base_url, model: draft.model, api_key: draft.api_key };
    if (draftIndex.value >= 0) ai.providers.splice(draftIndex.value, 1, row);
    else ai.providers.push(row);
  } else {
    const row = { type: draft.type, url: draft.url, events: [...draft.events] };
    if (draftIndex.value >= 0) push.channels.splice(draftIndex.value, 1, row);
    else push.channels.push(row);
  }
  drawer.value = false;
  ElMessage.success('已写入待保存列表，记得点「保存」');
}

async function save(key) {
  saving.value = key;
  try {
    await http.put(`/settings/${key}`, {
      value: key === 'ai' ? { providers: ai.providers } : { enabled: push.enabled, channels: push.channels, redact: push.redact },
    });
    ElMessage.success('已保存');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = '';
  }
}

onMounted(load);
</script>

<style scoped>
.run-kv { margin-bottom: 10px; }
.sub-hd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 16px 0 10px; padding-top: 12px; border-top: 1px solid var(--lab-line-2); }
.ev-chip { margin: 2px 4px 2px 0; }
.edge { display: flex; flex-direction: column; gap: 14px; }
.edge-row > .lab-chip { margin-bottom: 8px; }
.edge-list { margin: 8px 0 0; padding-left: 18px; color: var(--lab-ink-2); font-size: 12.5px; line-height: 1.9; }
.drawer-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>

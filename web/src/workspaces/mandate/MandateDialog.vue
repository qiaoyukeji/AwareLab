<template>
  <!-- 登记 / 修改授权的唯一入口。旧版把"逐字键入承诺"当成唯一放行条件，操作员要先读一屏规则再手抄一句话，
       实际部署里没人愿意用。现在把必填压到三项（主体 / 域名 / 有效期），承诺改成一次勾选，
       勾选后仍把完整承诺原文写进档案（后端校验等价于旧流程），审计链不断。 -->
  <el-dialog
    v-model="visible"
    :title="editing ? '修改演练授权' : '登记演练授权'"
    width="560px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form label-position="top" class="quick-form" @submit.prevent>
      <el-form-item label="授权主体" required>
        <el-input v-model="form.scope" placeholder="如：远山科技 信息安全部" maxlength="120" />
        <p class="lab-hint is-mute">写清被演练单位与部门，这一栏会印在交付报告首页。</p>
      </el-form-item>

      <el-form-item label="允许仿冒的域名" required>
        <el-input
          v-model="form.hosts"
          type="textarea"
          :rows="3"
          placeholder="每行一个：&#10;corp.example.com&#10;*.mail.example.com&#10;#ip（允许用 IP 直接访问）"
        />
        <div class="host-preview">
          <span v-for="(h, i) in hosts" :key="`${h}-${i}`" class="lab-chip is-accent">{{ h }}</span>
          <span v-if="!hosts.length" class="lab-chip is-danger">名单为空，无法保存</span>
        </div>
        <p class="lab-hint is-mute">
          只有名单里的域名能打开钓鱼网站；<span class="mono">#ip</span> 表示允许 IP 直连，内网演练通常要留着。
        </p>
      </el-form-item>

      <el-form-item label="有效期" required>
        <div class="preset-row">
          <el-radio-group v-model="form.preset" size="small">
            <el-radio-button :value="7">7 天</el-radio-button>
            <el-radio-button :value="30">30 天</el-radio-button>
            <el-radio-button :value="90">90 天</el-radio-button>
            <el-radio-button :value="0">自定义</el-radio-button>
          </el-radio-group>
          <span class="lab-hint">{{ rangeText }}</span>
        </div>
        <el-date-picker
          v-if="!form.preset"
          v-model="form.range"
          type="datetimerange"
          value-format="YYYY-MM-DDTHH:mm:ss.000Z"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          style="width: 100%; margin-top: 8px"
        />
      </el-form-item>

      <!-- 勾选即视为签署；未勾选时保存按钮直接禁用，后端仍会比对 pledge 原文 -->
      <div class="ack-box">
        <el-checkbox v-model="ack">
          我确认已获得被测单位的书面授权，并承诺仅在上述时间与域名范围内开展演练。
        </el-checkbox>
        <p class="ack-text">{{ statement || '本平台仅用于授权范围内的安全意识演练。' }}</p>
      </div>

      <el-collapse v-model="advanced" class="adv">
        <el-collapse-item name="more" title="更多信息（对接人、备注，可不填）">
          <el-form-item label="对接人 / 工单号">
            <el-input v-model="form.contact" placeholder="授权方联系人、审批工单号" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="授权文件编号、审批链等" />
          </el-form-item>
        </el-collapse-item>
      </el-collapse>
    </el-form>

    <template #footer>
      <div class="dialog-foot">
        <span v-if="!ack" class="lab-hint is-mute">勾选合规确认后可保存</span>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!canSave" @click="submit">
          {{ editing ? '保存并生效' : '登记并解锁' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
/**
 * 练习授权登记弹窗（新建与修改共用）。
 * 表单只暴露三项必填 + 一个勾选；pledge 不再让操作员手抄，勾选后直接把后端下发的承诺原文写进记录，
 * 与旧流程存下的字段完全一致，报告与审计里看到的仍是同一句话。
 */
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http from '../../api/client';

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  // 传入待修改的行；null 表示新建
  editing: { type: Object, default: null },
  // 后端下发的承诺原文；为空时不允许提交（fail-closed，和旧版一致）
  pledge: { type: String, default: '' },
  statement: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue', 'saved']);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const form = reactive({ scope: '', contact: '', note: '', hosts: '#ip\n', preset: 30, range: [] });
const ack = ref(false);
const saving = ref(false);
const advanced = ref([]);

// 换行与逗号都当分隔符，和后端 hostWhitelist 的解析口径一致
const hosts = computed(() => form.hosts.split(/[\n,]/).map((s) => s.trim()).filter(Boolean));

// 预设天数换算成绝对窗口；自定义时用日期选择器的值
const windowRange = computed(() => {
  if (!form.preset) return form.range;
  const start = Date.now();
  return [
    new Date(start).toISOString(),
    new Date(start + form.preset * 86400000).toISOString(),
  ];
});

const rangeText = computed(() => {
  if (!form.preset) return '选择精确起止时间';
  const day = form.preset;
  return `从今天起 ${day} 天，到期自动停站`;
});

const canSave = computed(() => ack.value && !!props.pledge && !!form.scope.trim() && hosts.value.length > 0 && !!windowRange.value?.[0]);

// 每次打开都重新铺表单：修改时回填主体与名单，承诺勾选永远重新来过
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    ack.value = false;
    advanced.value = [];
    const row = props.editing;
    if (row) {
      const start = new Date(row.start_at).getTime();
      const end = new Date(row.end_at).getTime();
      const days = Math.round((end - start) / 86400000);
      Object.assign(form, {
        scope: row.scope || '',
        contact: row.contact || '',
        note: row.note || '',
        hosts: (Array.isArray(row.allowed_hosts) ? row.allowed_hosts : []).join('\n') || '#ip\n',
        // 常见 7/30/90 天的窗口继续用预设，其余落到自定义，避免把 30 天改成 29.99 天
        preset: [7, 30, 90].includes(days) ? days : 0,
        range: [new Date(start).toISOString(), new Date(end).toISOString()],
      });
    } else {
      Object.assign(form, { scope: '', contact: '', note: '', hosts: '#ip\n', preset: 30, range: [] });
    }
  }
);

async function submit() {
  if (!canSave.value) return;
  const range = windowRange.value;
  const payload = {
    scope: form.scope.trim(),
    contact: form.contact.trim(),
    note: form.note.trim(),
    start_at: range[0],
    end_at: range[1],
    allowed_hosts: hosts.value,
    pledge: props.pledge,
  };
  saving.value = true;
  try {
    const res = props.editing
      ? await http.put(`/authorizations/${props.editing.id}`, payload)
      : await http.post('/authorizations', payload);
    if (props.editing && res?.stopped_sites) {
      ElMessage.warning(`已保存；授权已滑出生效窗口，停止 ${res.stopped_sites} 个网站监听`);
    } else if (props.editing && res?.reopened_sites) {
      ElMessage.success(`已保存并生效；恢复 ${res.reopened_sites} 个网站监听`);
    } else {
      ElMessage.success(props.editing ? '授权已更新' : '授权已登记，平台已解锁');
    }
    visible.value = false;
    emit('saved');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.quick-form :deep(.el-form-item) { margin-bottom: 16px; }
.host-preview { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.preset-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ack-box {
  border: 1px solid var(--lab-line);
  border-radius: var(--lab-r);
  background: var(--lab-fill-2);
  padding: 10px 12px;
  margin-bottom: 8px;
}
.ack-text { margin: 4px 0 0; font-size: 12px; line-height: 1.6; color: var(--lab-ink-3); }
.adv { border-top: 1px solid var(--lab-line-2); }
.adv :deep(.el-collapse-item__header) { font-size: 12.5px; color: var(--lab-ink-3); }
.dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
/* 相邻按钮默认 margin-left 会和 gap 叠出双倍缝 */
.dialog-foot .el-button + .el-button { margin-left: 0; }
.mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; }
</style>

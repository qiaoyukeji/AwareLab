<template>
  <!-- 使用说明：挂在演练总览的页头按钮上，首次进入管理面自动打开一次（见 ConsoleWorkspace.vue）。
       内容按"授权 → 素材 → 网站 → 邮件 → 复盘"的动作顺序组织，与左侧导航分组一一对应，
       每一步都给一个能直接跳过去的按钮，避免"说明里说要先授权，可我找不到在哪"。 -->
  <el-drawer v-model="open" :with-header="false" size="560px" class="guide-drawer">
    <div class="guide">
      <header class="guide-hd">
        <div class="guide-title">
          <b>使用说明</b>
          <span class="guide-ver">{{ VERSION_TAG }}</span>
        </div>
        <p class="guide-lead">
          按左侧导航从上到下走一遍就是一轮完整演练。第一次用建议从头看；已经建过站、发过信的，直接从第 2 步看。
        </p>
      </header>

      <ol class="guide-steps">
        <li v-for="step in STEPS" :key="step.no" class="guide-step">
          <span class="guide-no">{{ step.no }}</span>
          <div class="guide-body">
            <div class="guide-step-hd">
              <b>{{ step.title }}</b>
              <span class="guide-where">在「{{ step.where }}」</span>
            </div>
            <p class="guide-text">{{ step.text }}</p>
            <el-button text type="primary" size="small" class="guide-go" @click="go(step.to)">
              去{{ step.where }}<el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </li>
      </ol>

      <section class="guide-pit">
        <div class="guide-pit-hd"><el-icon><WarnTriangleFilled /></el-icon>几个最容易卡住的地方</div>
        <ul>
          <li v-for="(pit, i) in PITFALLS" :key="i">{{ pit }}</li>
        </ul>
      </section>

      <footer class="guide-foot">
        <p>完整说明见安装目录 <code>docs/使用手册.md</code>；部署、反代与端口排障见 <code>docs/部署与运维手册.md</code>。</p>
        <p class="guide-foot-ver">AwareLab {{ VERSION_TAG }} · 当前版本号同时显示在左侧导航、页面标题与观测视图页脚</p>
      </footer>
    </div>
  </el-drawer>
</template>

<script setup>
/** 使用说明抽屉，纯展示 + 跳转；不改任何数据。文案改动时同步 docs/使用手册.md 与培训讲稿的步骤顺序。 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { VERSION_TAG } from '../version';

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(['update:modelValue']);
const router = useRouter();

// 抽屉开合仍走 v-model，父组件只关心"开没开"
const open = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
});

// 五步与左侧导航一一对应：顺序即操作顺序，别按页面功能重新排列
const STEPS = [
  {
    no: 1,
    title: '登记演练授权',
    where: '演练授权',
    text: '填授权主体、允许仿冒的域名与有效期，勾一次合规承诺。域名决定后面能建哪些站点——演练要用的域名必须写进来，否则建站会被服务端拒绝。',
    to: '/mandate',
  },
  {
    no: 2,
    title: '挑素材或仿一个站',
    where: '钓鱼素材',
    text: '模板库有 21 套页面、18 套邮件、6 套教学页，点「使用此模板」复制成可改的副本；顶部还能填单位名称与主色，复制时一并换掉。也可以对真实站点做「一键仿站」再人工审一遍。',
    to: '/material',
  },
  {
    no: 3,
    title: '建钓鱼网站',
    where: '钓鱼网站',
    text: '选假登录页、选访问方式（域名反代 / IP:端口直连），抽屉底部的「链接拼接结果」会实时告诉你访客打开的是什么地址。反代时域名框只填域名，端口留给 nginx 回源。',
    to: '/capture',
  },
  {
    no: 4,
    title: '发钓鱼邮件',
    where: '钓鱼邮件',
    text: '先建一个发信邮箱，再新建发送任务：素材绑定里选邮件文案和刚建好的网站，正文用 {{site_url}} 让平台按网站地址展开。沙箱开启时只落 .eml 不真发，确认无误再关沙箱。',
    to: '/outbound',
  },
  {
    no: 5,
    title: '看结果并收尾',
    where: '上钩记录',
    text: '按网站/任务分组看打开与提交漏斗，给每条记录标处置状态，口令默认掩码、逐字段查看会留审计；最后导出交付报告与取证 CSV。所有高危动作都记在系统设置的审计里。',
    to: '/evidence',
  },
];

// 每条都对应一次真实踩过的坑，写"会发生什么 + 怎么改"，不要只写"注意配置"
const PITFALLS = [
  '站点域名不在授权名单里：建站直接 403，先把域名补进授权再建。',
  '反代站点没填「对外域名」：链接会回落成 127.0.0.1:端口，只有本机能打开，列表上会标「仅本机可达」。',
  '沙箱开关没关：邮件只生成 .eml，收件人什么都收不到。',
  '端口被其他程序占用：平台启动时会自动换到可用端口，实际端口以列表显示为准。',
  '反代到回环端口时，nginx 记得透传 Host，否则访客的域名对不上授权名单。',
];

function go(to) {
  open.value = false;
  router.push(to);
}
</script>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-bottom: 8px;
}

.guide-hd {
  border-bottom: 1px solid var(--lab-line-2);
  padding-bottom: 12px;
}

.guide-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.guide-title b {
  font-size: 17px;
  color: var(--lab-ink);
}

.guide-ver {
  font-size: 11px;
  font-family: Consolas, 'Cascadia Mono', monospace;
  color: var(--lab-accent);
  background: var(--lab-fill-2);
  border: 1px solid var(--lab-line-2);
  border-radius: 10px;
  padding: 1px 8px;
}

.guide-lead {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--lab-ink-3);
  line-height: 1.8;
}

.guide-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.guide-step {
  display: flex;
  gap: 12px;
}

.guide-no {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--lab-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.guide-body {
  flex: 1 1 auto;
  min-width: 0;
}

.guide-step-hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.guide-step-hd b {
  font-size: 13.5px;
  color: var(--lab-ink);
}

.guide-where {
  font-size: 11.5px;
  color: var(--lab-ink-4);
}

.guide-text {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--lab-ink-3);
}

.guide-go {
  margin-top: 2px;
  padding-left: 0;
  font-size: 12.5px;
}

.guide-go .el-icon {
  margin-left: 2px;
}

.guide-pit {
  background: var(--lab-fill-2);
  border: 1px solid var(--lab-line-2);
  border-radius: 6px;
  padding: 10px 12px;
}

.guide-pit-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--lab-warn);
}

.guide-pit ul {
  margin: 8px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.guide-pit li {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--lab-ink-3);
}

.guide-foot {
  border-top: 1px solid var(--lab-line-2);
  padding-top: 10px;
  font-size: 11.5px;
  color: var(--lab-ink-4);
  line-height: 1.7;
}

.guide-foot p {
  margin: 0;
}

.guide-foot-ver {
  margin-top: 4px !important;
  font-family: Consolas, 'Cascadia Mono', monospace;
}

.guide-foot code {
  font-family: Consolas, 'Cascadia Mono', monospace;
  background: var(--lab-fill-2);
  border-radius: 3px;
  padding: 0 3px;
}
</style>

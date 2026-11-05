<template>
  <div class="lab-stack">
    <!-- 平台运行参数 -->
    <!-- 上半屏六项是 server/config.yaml 的只读回显：启动读一次，界面没有写入口，改它们要改文件并重启进程；只有下半屏模型服务可写。 -->
    <LabPane title="平台运行参数" hint="端口、沙箱与模型服务；改完即刻生效，无需重启">
      <template #ops>
        <!-- 组件只在挂载时拉一次（KeepAlive 缓存标签页，切回来不重请），这是手动重读入口 -->
        <el-button size="small" @click="load">重新读取</el-button>
      </template>

      <!-- 随机路径等于入口地址、端口与绑定决定谁能连管理面；只在本机会话渲染，不进聊天、截图、日志或推送内容 -->
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

      <!-- 配了厂商，一键仿站就把提示词（含要仿冒的站点名与字段名）发给这家外部模型服务；一家都不配则这条出站通道不存在。 -->
      <!-- 后端保存时校验 base_url：公网必须 https（明文 HTTP 会让 Authorization 头可被链路读取），只有本机回环允许 http。 -->
      <div class="sub-hd">
        <span class="lab-strong">模型服务</span>
        <span class="lab-hint">兼容 OpenAI Chat Completions 协议的任意服务（DeepSeek、阿里云百炼、硅基流动、MiniMax 等），用于网站素材的生成辅助。</span>
      </div>
      <!-- 表格只做展示、编辑走抽屉；增删改只在内存里，按保存模型服务才整包 PUT 落库。
           空表直接换成一行虚线提示：留一个空表头再留半屏空白，看着像没加载出来 -->
      <el-table v-if="ai.providers.length" :data="ai.providers" size="small">
        <el-table-column prop="name" label="厂商名称" min-width="110" />
        <el-table-column prop="base_url" label="接口地址" min-width="200" show-overflow-tooltip />
        <el-table-column prop="model" label="模型" min-width="120" show-overflow-tooltip />
        <el-table-column prop="api_key" label="API Key" min-width="130">
          <!-- 后端 GET /settings 已把 api_key 换成星，这里再截一次头尾兜底：读到未掩码的脏数据时屏幕上最多露前后各 4 个字符 -->
          <template #default="{ row }"><span class="mono-inline">{{ mask(row.api_key) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ $index }">
            <el-button link type="primary" @click="editProvider($index)">编辑</el-button>
            <el-button link type="danger" @click="removeProvider($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <!-- 空列表是正常状态：不配外部模型，手写模板与新建假登录页照样能跑完整演练 -->
      <div v-else class="config-empty">还没有模型服务配置项，点下方「新增厂商」添加；也可以不配，直接用假登录页模板。</div>
      <div class="lab-toolbar" style="margin-top: 12px; margin-bottom: 0">
        <el-button size="small" @click="createProvider">新增厂商</el-button>
        <span class="lab-spacer" />
        <!-- saving 记的是正在保存哪一节，loading 只压这一颗钮，另一节不受影响 -->
        <el-button type="primary" size="small" :loading="saving === 'ai'" @click="save('ai')">保存模型服务</el-button>
      </div>
    </LabPane>

    <!-- 通知通道 -->
    <!-- 整包走 PUT /settings/push；后端保存前逐条过 URL 门禁（明文 http 只放行本机回环），每次改动写一条 settings.update 审计。审计与推送流水里的机器人地址一律 maskUrl（access_token 换星），只有本机 settings 表存原串。 -->
    <LabPane title="通知通道" hint="演练事件推送到协作机器人：默认脱敏，不含邮箱、凭据与被提交的字段名">
      <template #ops>
        <!-- 开关绑在 reactive 的 push 上：拨了不等于存了，还要再点保存推送配置 -->
        <el-switch v-model="push.redact" active-text="脱敏推送" />
        <el-switch v-model="push.enabled" active-text="启用事件推送" />
      </template>

      <!-- 通道表是整表替换：行内删除只 splice 内存，保存时全量 PUT，服务端不做逐行 diff。
           空表同样是正常态（多数演练不接机器人），走一行虚线提示，不留空表体 -->
      <el-table v-if="push.channels.length" :data="push.channels" size="small">
        <el-table-column label="类型" width="110">
          <template #default="{ row }">{{ CHANNEL_LABEL[row.type] || row.type }}</template>
        </el-table-column>
        <el-table-column prop="url" label="Webhook 地址" min-width="220" show-overflow-tooltip />
        <el-table-column label="订阅事件" min-width="220">
          <!-- 订阅清单标签取自 EVENTS，认不出的原样显示，后端新增事件时旧前端也不会渲染成空白 -->
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
      <div v-else class="config-empty">尚未配置通知通道，需要时点下方「新增通道」；不配置不影响演练与取证。</div>
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

    <!-- 短信认证 -->
    <!-- 阿里云号码认证服务（Dypnsapi，SendSmsVerifyCode / CheckSmsVerifyCode）。开关落 settings.sms，保存即刻生效。
         只拦普通用户：管理员是后台兜底入口，密钥过期或欠费时也必须进得来。
         密钥走掩码回传：眼睛看到的星号原样存回等于不修改，只有真的换了串才会覆盖。 -->
    <LabPane title="短信认证" hint="阿里云号码认证服务：普通用户登录时校验手机验证码；管理员账号不受影响">
      <template #ops>
        <el-switch v-model="sms.enabled" active-text="启用短信认证" />
      </template>

      <el-form label-position="top" class="sms-form">
        <div class="sms-grid">
          <el-form-item label="AccessKey ID">
            <el-input v-model="sms.access_key_id" placeholder="LTAI 开头的 AccessKey ID" />
          </el-form-item>
          <el-form-item label="AccessKey Secret">
            <el-input v-model="sms.access_key_secret" type="password" show-password placeholder="留空表示沿用已保存的密钥" />
          </el-form-item>
          <el-form-item label="短信签名">
            <el-input v-model="sms.sign_name" placeholder="控制台审核通过的签名，如：远山科技" />
          </el-form-item>
          <el-form-item label="模板 CODE">
            <el-input v-model="sms.template_code" placeholder="验证码模板 CODE，如：100001" />
          </el-form-item>
          <el-form-item label="验证码位数">
            <el-input-number v-model="sms.code_length" :min="4" :max="8" controls-position="right" />
          </el-form-item>
          <el-form-item label="有效期（秒）">
            <el-input-number v-model="sms.valid_time" :min="60" :max="1800" :step="30" controls-position="right" />
          </el-form-item>
          <el-form-item label="重发间隔（秒）">
            <el-input-number v-model="sms.interval_seconds" :min="30" :max="600" :step="10" controls-position="right" />
          </el-form-item>
          <el-form-item label="模板参数（必填，code 固定 ##code##）">
            <el-input v-model="sms.template_param" placeholder='{"code":"##code##"}' />
            <p class="lab-hint is-mute">
              验证码变量固定写 <code>##code##</code>，由云端生成后替换；模板里若还有 <code>${min}</code> 这类变量，一并写进来，例如
              <code>{"code":"##code##","min":"5"}</code>。只写变量名不够，模板正文的变量必须全部给值。
            </p>
          </el-form-item>
        </div>

        <el-collapse class="sms-adv">
          <el-collapse-item title="高级：网关地址与方案名（联调或专属网关才需要改）" name="adv">
            <div class="sms-grid">
              <el-form-item label="网关地址">
                <el-input v-model="sms.endpoint" placeholder="dypnsapi.aliyuncs.com" />
                <div class="lab-hint is-mute" style="margin-top: 4px">只接受 https；本机回环（127.0.0.1）可用 http 便于联调。</div>
              </el-form-item>
              <el-form-item label="方案名 SchemeName">
                <el-input v-model="sms.scheme_name" placeholder="可留空；按阿里云控制台的方案名填写" />
              </el-form-item>
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-form>

      <div class="lab-toolbar" style="margin-top: 12px; margin-bottom: 0">
        <span class="lab-hint is-mute">
          密钥仅以掩码回显；开关与配置保存后立即生效，无需重启。
        </span>
        <span class="lab-spacer" />
        <el-button type="primary" size="small" :loading="saving === 'sms'" @click="save('sms')">保存短信配置</el-button>
      </div>

      <p class="lab-hint is-mute" style="margin: 12px 0 0">
        开启后：普通用户登录除账号口令外还要输入短信验证码；未绑定手机号的账号会先要求绑定（管理员也可在「账号管理」里预填号码）。
        管理员账号始终只验口令，避免短信服务异常时把后台锁死。
      </p>
      <p class="lab-hint is-mute" style="margin: 6px 0 0">
        接口文档：阿里云号码认证服务
        <a class="sms-link" href="https://next.api.aliyun.com/document/Dypnsapi/2017-05-25/SendSmsVerifyCode" target="_blank" rel="noreferrer">SendSmsVerifyCode</a>
        ／
        <a class="sms-link" href="https://next.api.aliyun.com/document/Dypnsapi/2017-05-25/CheckSmsVerifyCode" target="_blank" rel="noreferrer">CheckSmsVerifyCode</a>。
      </p>
    </LabPane>

    <!-- 演练边界 -->
    <!-- 本节没有输入控件：授权硬要求、刻意不实现清单、数据留存规定都与协议文档第 8、9 节同源。改措辞等于改对外承诺，需与 docs/ 和 README 同步。 -->
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

    <!-- 账号与口令 -->
    <!-- 会话清单只读；退出所有会话与修改口令成功后后端把 sessions 整表清空（含当前这条），清本地令牌与跳登录交给 stores/session.js，本页不 import router（与 api/client.js 互依赖，引一次成环）。 -->
    <LabPane flush title="账号与口令" hint="谁在什么时候从哪台机器登录了；两个动作都会把你自己一起踢下线">
      <template #ops>
        <el-button size="small" :loading="sessionsLoading" @click="loadSessions">刷新会话</el-button>
      </template>

      <!-- 令牌只给前 6 位，接口用途是清点有没有陌生会话。ip / user_agent 对 v5 迁移前的老会话是 null（迁移只加列不回填），显示未记录而不是空值。 -->
      <el-table :data="sessions" size="small">
        <el-table-column label="令牌" width="100">
          <template #default="{ row }"><span class="mono-inline">{{ row.token_hint }}</span></template>
        </el-table-column>
        <el-table-column prop="username" label="登录名" width="110" />
        <el-table-column label="状态" width="160">
          <!-- is_current 与 expired 可以同时为真（自己这条已经过期还没被清），所以两颗 chip 各自独立判 -->
          <template #default="{ row }">
            <span v-if="row.is_current" class="lab-chip is-accent">当前会话</span>
            <span v-if="row.expired" class="lab-chip is-danger sess-chip">已过期</span>
            <span v-if="!row.is_current && !row.expired" class="lab-chip is-ok">有效</span>
          </template>
        </el-table-column>
        <el-table-column label="来源 IP" width="140">
          <template #default="{ row }"><span class="mono-inline">{{ row.ip || '未记录' }}</span></template>
        </el-table-column>
        <el-table-column label="登录时间" width="150">
          <template #default="{ row }">{{ fmt(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="到期时间" width="150">
          <template #default="{ row }">{{ fmtMs(row.expires_at) }}</template>
        </el-table-column>
        <el-table-column label="客户端" min-width="220">
          <template #default="{ row }"><span class="lab-hint is-mute">{{ row.user_agent || '未记录' }}</span></template>
        </el-table-column>
        <template #empty><div class="lab-empty">没有任何会话：本机令牌可能已被清空，请重新登录。</div></template>
      </el-table>

      <div class="pane-bd">
        <div class="lab-toolbar" style="margin-bottom: 0">
          <el-button type="danger" plain size="small" :loading="revoking" @click="revokeAllSessions">退出所有会话</el-button>
          <span class="lab-hint is-mute">怀疑令牌泄露时用：后端不留当前会话，所有人（含你自己）立刻掉线。</span>
        </div>

        <div class="sub-hd">
          <span class="lab-strong">修改口令</span>
          <span class="lab-hint">8~64 位且不得与当前口令相同；改完所有会话一并作废，必须重新登录。</span>
        </div>
        <el-form label-position="top" class="pwd-form">
          <el-form-item label="当前口令">
            <el-input v-model="pwd.current" type="password" show-password autocomplete="current-password" placeholder="现在生效的那一条" />
          </el-form-item>
          <el-form-item label="新口令">
            <el-input v-model="pwd.next" type="password" show-password autocomplete="new-password" placeholder="8~64 位" />
          </el-form-item>
          <el-form-item label="确认新口令">
            <el-input v-model="pwd.confirm" type="password" show-password autocomplete="new-password" placeholder="再输一遍新口令" @keyup.enter="submitPassword" />
          </el-form-item>
          <el-button type="primary" size="small" :loading="pwdSaving" @click="submitPassword">修改口令</el-button>
        </el-form>
        <p class="lab-hint is-mute" style="margin: 10px 0 0">
          新口令写回 <span class="mono-inline">server/config.yaml</span> 的 <span class="mono-inline">panel.password</span>
          （只换那一行，你自己写的注释不会被抹掉），内存里的配置同步生效，<span class="lab-strong">不必重启后端</span>。
          出厂口令没改过之前，平台拒绝新建钓鱼网站（见下面「配置体检」）。
          口令只出现在这一次请求体里：不落审计、不进日志，界面上也从不回显。
        </p>
      </div>
    </LabPane>

    <!-- 配置体检 -->
    <!-- 与启动横幅同一份判定（platform/configCheck.js），日志里说的和页面显示的对得上。只做手动刷新不轮询：配置不会自己变好，本节用于改完 config.yaml 回来对一眼。 -->
    <LabPane title="配置体检" hint="检查当前生效配置里有没有让防线失效的写法">
      <template #ops>
        <el-button size="small" :loading="checkLoading" @click="loadCheck">立即体检</el-button>
      </template>

      <div v-if="!check" class="lab-empty">还没有体检结论。点右上角「立即体检」；改过 server/config.yaml 后也要重新体检。</div>
      <template v-else>
        <el-alert v-if="check.fatal" type="error" :closable="false" show-icon class="gap-b">
          <template #title>
            <span class="lab-strong">配置校验未通过。</span>
            下面标「错误」的条目会让后端拒绝启动：先改 server/config.yaml 再重启进程，界面上改不了它们。
          </template>
        </el-alert>
        <el-alert v-if="check.factory_password" type="error" :closable="false" show-icon class="gap-b">
          <template #title>
            <span class="lab-strong">后台口令仍是首次启动生成的随机值，平台拒绝新建钓鱼网站。</span>
            <!-- deployment_block 是 POST /web-sites 会拿到的那句 409 原因，逐字展示：两个界面读同一条拒绝理由 -->
            <span class="lab-hint">{{ check.deployment_block || '请先在上面的「修改口令」里改成自己的口令。' }}</span>
          </template>
        </el-alert>
        <el-alert v-if="check.panel_exposed" type="warning" :closable="false" show-icon class="gap-b">
          <template #title>
            管理面正监听在非回环地址上，同一网络内任何终端都能到达后台；建议配 panel.allow_ips 白名单并改用 HTTPS。
          </template>
        </el-alert>

        <!-- findings.message 是后端写好的中文，不重排：后端已按 error→warn→info 排序，前端再排会与横幅顺序不同 -->
        <div v-if="check.findings?.length" class="lab-list">
          <div v-for="f in check.findings" :key="f.code" class="lab-list-item find-item">
            <span class="lab-chip" :class="FINDING_TONE[f.level] || ''">{{ FINDING_LABEL[f.level] || f.level }}</span>
            <span class="lab-hint">{{ f.message }}</span>
          </div>
        </div>
        <div v-else class="lab-empty">没有发现问题：当前生效配置逐项体检通过。</div>

        <div class="sub-hd">
          <span class="lab-strong">启动摘要</span>
          <span class="lab-hint">与后端开机横幅逐字相同的几行。</span>
        </div>
        <div class="lab-mono">{{ summaryText }}</div>

        <div class="sub-hd">
          <span class="lab-strong">登录安全</span>
          <span class="lab-hint">来自 security/session.js 的 loginSecurityStatus，与启动摘要同源。</span>
        </div>
        <div class="lab-grid" style="--cols: 4">
          <LabMetric
            label="登录白名单"
            :value="ls.allow_ips?.length || 0"
            unit="条"
            :tone="ls.allow_ips_enabled ? '' : 'warn'"
            :extra="allowIpsText"
          />
          <LabMetric label="锁定阈值" :value="ls.max_fails ?? '-'" unit="次" :extra="lockText" />
          <LabMetric
            label="当前锁定"
            :value="ls.active_locks ?? '-'"
            unit="个来源"
            :tone="(ls.active_locks || 0) > 0 ? 'danger' : ''"
            extra="按来源 IP 计数并落库，重启不清零"
          />
          <LabMetric label="活跃会话" :value="ls.sessions ?? '-'" unit="条" extra="未过期的后台会话，与上面那张清单同一张表" />
        </div>
        <p class="lab-hint is-mute" style="margin: 10px 0 0">
          <span class="mono-inline">panel.allow_ips</span> 写在 <span class="mono-inline">server/config.yaml</span> 里，
          <span class="lab-strong">本页只读</span>：要改白名单必须编辑那个文件并重启后端（启动时读一次，没有热加载）。
          名单为空等于不启用，任何来源都能尝试登录；写成字符串而不是数组会让白名单静默失效，上面那条 panel_allow_ips 就是在说这件事。
        </p>
      </template>
    </LabPane>

    <!-- 数据保留与清理 -->
    <!-- 后端每 6 小时自动跑一次，本节只负责看得见与手动补一次。GET /maintenance/status 带 withFiles，会 stat 三个目录里的每个文件，文件上万时明显变慢，所以只手动刷新不轮询。 -->
    <LabPane title="数据保留与清理" hint="到期数据与落盘产物的自动清理，可先试算再执行">
      <template #ops>
        <el-button size="small" :loading="maintLoading" @click="loadMaint">重新读取</el-button>
      </template>

      <div v-if="!maint" class="lab-empty">还没有读到保留期状态。点右上角「重新读取」拉一次。</div>
      <template v-else>
        <!-- enabled=false 不是故障，是操作员选了长期留存证据这条退路；两个动作按钮一起置灰，保留期没启用时后端直接返回 skipped -->
        <el-alert v-if="!maint.enabled" type="warning" :closable="false" show-icon class="gap-b">
          <template #title><span class="lab-strong">未配置保留期，平台不会自动删除任何数据。</span>演练数据与采集到的明文口令将永久留存。</template>
        </el-alert>

        <div class="lab-kv run-kv">
          <span>演练数据保留期 <b>{{ retentionText(maint.retention_days) }}</b></span>
          <span>审计保留期 <b>{{ retentionText(maint.audit_retention_days) }}</b></span>
          <span>数据清理线 <b>{{ fmt(maint.cutoff_at) }}</b></span>
          <span>审计清理线 <b>{{ fmt(maint.audit_cutoff_at) }}</b></span>
          <span>最早数据时间 <b>{{ fmt(maint.oldest_created_at) }}</b></span>
          <span>下次自动清理 <b>{{ fmt(maint.next_sweep_at) }}</b></span>
        </div>

        <div class="lab-grid" style="--cols: 4">
          <LabMetric v-for="row in pendingRows" :key="row.key" :label="row.label" :value="row.count" unit="条" :extra="row.extra" :tone="row.tone" />
        </div>

        <!-- files_pending 只在保留期启用时显示：未启用时后端传的 cutoff 是 null，collectPrunableFiles(null) 数的是三个目录文件总数而非待清理数，摆出来是假数字 -->
        <div v-if="maint.enabled && maint.files_pending" class="lab-kv" style="margin-top: 10px">
          <span v-for="(count, key) in maint.files_pending" :key="key">
            {{ DIR_LABEL[key] || key }} <b>{{ count }}</b> 个文件待清理
          </span>
        </div>

        <div class="lab-toolbar" style="margin: 14px 0 0">
          <el-button size="small" :disabled="!maint.enabled" :loading="sweeping === 'dry'" @click="runSweep(true)">试算（不删任何数据）</el-button>
          <el-button size="small" type="danger" plain :disabled="!maint.enabled" :loading="sweeping === 'run'" @click="runSweep(false)">立即清理</el-button>
          <span class="lab-spacer" />
          <span class="lab-hint is-mute">试算不删任何行、不删任何文件，也不写审计。</span>
        </div>

        <!-- 最近一次 POST /maintenance/run 的结果：试算与真删共用这一块，靠 dry_run 切措辞 -->
        <div v-if="sweep" class="sweep-box">
          <el-alert v-if="sweep.skipped" type="info" :closable="false" show-icon :title="`本次没有执行：${sweep.reason || '保留期未启用'}`" />
          <template v-else>
            <div class="lab-toolbar" style="margin-bottom: 8px">
              <span class="lab-chip" :class="sweep.dry_run ? 'is-accent' : 'is-warn'">
                {{ sweep.dry_run ? '试算结果 · 没有删除任何东西' : '已执行清理' }}
              </span>
              <!-- 文件删除失败要露出来：真删时失败的文件留在磁盘上（行已删），吞掉数字会让操作员以为磁盘也干净了 -->
              <span v-if="(sweep.files_failed || 0) > 0" class="lab-chip is-danger">{{ sweep.files_failed }} 个文件删除失败，仍留在磁盘上</span>
              <span class="lab-hint is-mute">
                数据清理线 {{ fmt(sweep.cutoff_at) }} · 审计清理线 {{ fmt(sweep.audit_cutoff_at) }} ·
                文件 {{ fmtBytes(sweep.files_bytes) }} · 耗时 {{ sweep.seconds ?? 0 }} 秒
              </span>
            </div>
            <el-table :data="sweepRows" size="small">
              <el-table-column prop="label" label="数据表" min-width="140" />
              <el-table-column prop="pending" label="计划删除" width="110" />
              <el-table-column label="实际删除" width="110">
                <template #default="{ row }">{{ row.removed === null ? '—（试算）' : row.removed }}</template>
              </el-table-column>
            </el-table>
            <p class="lab-hint is-mute" style="margin: 8px 0 0">
              计划数与实际数不等是正常的：中间有新数据落库、或有文件被占用删不掉。
              落盘文件实际删除：{{ filesText }}。
            </p>
          </template>
        </div>

        <p class="lab-hint is-mute" style="margin: 12px 0 0">
          <span class="mono-inline">audit_logs</span> 走更长的独立保留期
          <span class="mono-inline">exercise.audit_retention_days</span>（默认 365 天，写 0 表示永不清理）：
          审计必须比它记录的证据活得久，否则「谁在什么时候清走了什么」自己先没了。
          两项都写在 <span class="mono-inline">server/config.yaml</span>，改完重启生效。
        </p>
        <p class="lab-hint is-mute" style="margin: 6px 0 0">
          <span class="lab-strong">清空整场演练的数据是命令行专属动作</span>：
          <span class="mono-inline">node server/scripts/purge.mjs --purge-all --confirm=DELETE-ALL</span>，
          界面不提供这个按钮：它不分时间范围，会把上钩记录、事件、令牌、收件人、发送任务、推送流水与站点一起删除，
          也不会关掉正在监听的采集端口，需要先停服务再执行。
        </p>
      </template>
    </LabPane>

    <!-- 抽屉式编辑：不弹窗 -->
    <!-- 一个抽屉承载模型服务与通知通道两种表单，靠 kind 切字段、draftIndex 判新增或改行；确定只把 draft 并回内存，落库仍要各节自己保存，误关抽屉不会留下半条配置 -->
    <el-drawer v-model="drawer" :title="drawerTitle" size="440px" direction="rtl">
      <el-form v-if="kind === 'ai'" label-position="top">
        <el-form-item label="厂商名称"><el-input v-model="draft.name" placeholder="如 DeepSeek" /></el-form-item>
        <el-form-item label="接口地址"><el-input v-model="draft.base_url" placeholder="https://api.example.com/v1" /></el-form-item>
        <el-form-item label="模型"><el-input v-model="draft.model" placeholder="deepseek-chat" /></el-form-item>
        <!-- 编辑时回填的是后端掩码串，原样存回去服务端 keepStoredKeys 按这行密钥没改处理，改名不会把密钥洗成星号；要换就清空重填 -->
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
/** 系统设置 · 运行参数标签页：编辑模型服务与通知通道，只读展示 config.yaml 启动值与演练边界，另有账号口令、配置体检、保留期清理三节运维入口。
 *  改完前端要 vite build 并重启后端才生效（adminPlane.js 挂载时只读一次 web/dist/index.html）；config.yaml 的值改了同样要重启，只有口令是热更新。 */
import { ref, reactive, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import http from '../../api/client';
import LabPane from '../../ui/LabPane.vue';
import LabMetric from '../../ui/LabMetric.vue';
import { fmtTime } from '../../utils/time';
import { useSession } from '../../stores/session';

// gate 是各标签页统一入参（工作区下发的授权态），本页只读展示不做投放，收下不用
defineProps({ gate: { type: Object, default: null } });

/** 可订阅事件名→中文标签，键必须与后端 notifier 逐字一致；认不出的事件原样显示事件名，不渲染成空白。 */
const EVENTS = {
  page_open: '网页打开',
  form_fill: '网页填写',
  mail_open: '邮件打开',
  mail_send: '邮件发送',
  attachment_run: '附件运行',
};
// 机器人类型对照表：抽屉下拉与表格类型列共用，新增通道类型改这里 + notify 层
const CHANNEL_LABEL = { dingtalk: '钉钉', wecom: '企业微信', feishu: '飞书' };

// AI 设置：providers 里只有 api_key 被后端换成掩码，base_url 与 model 是原值
const ai = reactive({ providers: [] });
// 推送设置：enabled 默认关、redact 默认开，默认不向第三方群推、推出去的必须脱敏
const push = reactive({ enabled: false, channels: [], redact: true });
// 短信认证：enabled 默认关；密钥由后端掩码回传，留空/保留星号都表示「不修改已保存的密钥」
const sms = reactive({
  enabled: false,
  access_key_id: '',
  access_key_secret: '',
  sign_name: '',
  template_code: '',
  template_param: '{"code":"##code##"}',
  code_length: 6,
  valid_time: 300,
  interval_seconds: 60,
  endpoint: 'dypnsapi.aliyuncs.com',
  scheme_name: '',
});
// config.yaml 的只读回显值（panel_path / panel_port / capture_port_range / mail_default_dry_run / db_*）
const info = ref({});
// 正在保存哪一节（'ai' | 'push' | ''）：只用来把对应那颗按钮压成 loading，另一节不受影响
const saving = ref('');

// 抽屉状态：drawer 开关 / kind 决定渲染哪种表单 / draftIndex 为 -1 表示新增、否则是待改行的下标
const drawer = ref(false);
const kind = ref('ai');
const draftIndex = ref(-1);
// 草稿行：两种表单字段混在同一对象，切 kind 时只覆盖自己那几项，另一类残留值不会提交
const draft = reactive({ id: '', name: '', base_url: '', model: '', api_key: '', type: 'dingtalk', url: '', events: [] });

/** 抽屉标题由 kind + draftIndex 推出（新增/编辑 × 模型/通道）。 */
const drawerTitle = computed(() => {
  if (kind.value === 'ai') return draftIndex.value >= 0 ? '编辑模型服务' : '新增模型服务';
  return draftIndex.value >= 0 ? '编辑通知通道' : '新增通知通道';
});

/** 密钥回显掩码：留头 4 尾 4 中间四星。后端已掩码，这里是防脏数据的第二道兜底；空值回未设置以区分没配与看不见。 */
const mask = (k) => (k ? `${String(k).slice(0, 4)}****${String(k).slice(-4)}` : '未设置');

/** 拉 GET /settings 拆进 ai/push/info。用 Object.assign 保持两个 reactive 引用不变；redact !== false 让库里没该字段的老数据默认落在脱敏开的一侧。 */
async function load() {
  const data = await http.get('/settings');
  Object.assign(ai, { providers: data.ai?.providers || [] });
  Object.assign(push, { enabled: !!data.push?.enabled, channels: data.push?.channels || [], redact: data.push?.redact !== false });
  // 短信配置整包回填：密钥是掩码串，显示出来即可，保存时后端按「带星号 = 不改」处理
  if (data.sms) Object.assign(sms, data.sms);
  // 整包留一份原始响应：config.yaml 的只读值都在这一层，页面只读展示
  info.value = data;
}

/** 三种入口共用：只负责把抽屉打开，字段由各调用方备好。 */
function saveDraft() {
  drawer.value = true;
}

/** 新建模型服务：kind 切 ai、draftIndex 置 -1（applyDraft 会 push 而非 splice），预填一套默认地址与模型名。 */
function createProvider() {
  kind.value = 'ai';
  draftIndex.value = -1;
  Object.assign(draft, { id: '', name: '', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', api_key: '' });
  saveDraft();
}

/** 编辑第 index 行模型服务：带 row.id 回填，api_key 回填后端掩码串，原样存回即不改密钥。 */
function editProvider(index) {
  kind.value = 'ai';
  draftIndex.value = index;
  const row = ai.providers[index] || {};
  Object.assign(draft, { id: row.id || '', name: row.name || '', base_url: row.base_url || '', model: row.model || '', api_key: row.api_key || '' });
  saveDraft();
}

/** 删除第 index 行：只 splice 内存，不弹确认也不发请求，点保存整包覆盖才生效。 */
function removeProvider(index) {
  ai.providers.splice(index, 1);
}

/** 新建通道：kind 切 push、draftIndex 置 -1，给最保守起手值（默认钉钉、地址空、不订阅任何事件）。 */
function createChannel() {
  kind.value = 'push';
  draftIndex.value = -1;
  Object.assign(draft, { type: 'dingtalk', url: '', events: [] });
  saveDraft();
}

/** 编辑第 index 条通道。events 浅拷贝一份，否则抽屉里的勾选会实时改到表格行、取消也撤不回。 */
function editChannel(index) {
  kind.value = 'push';
  draftIndex.value = index;
  const row = push.channels[index] || {};
  Object.assign(draft, { type: row.type || 'dingtalk', url: row.url || '', events: [...(row.events || [])] });
  saveDraft();
}

/** 删除第 index 条通道：只动内存，保存整包覆盖才生效。 */
function removeChannel(index) {
  push.channels.splice(index, 1);
}

/** 抽屉确定：把草稿并回对应列表并关抽屉，只改内存不发请求。ai 行带 id（新建用 crypto.randomUUID），push 行整条替换；成功提示说待保存，用户还得点保存才落库。 */
function applyDraft() {
  if (kind.value === 'ai') {
    // id 是这一行的身份：带着它回填，改名就不会被服务端当成新厂商而清掉密钥
    const row = { id: draft.id || crypto.randomUUID(), name: draft.name, base_url: draft.base_url, model: draft.model, api_key: draft.api_key };
    if (draftIndex.value >= 0) ai.providers.splice(draftIndex.value, 1, row);
    else ai.providers.push(row);
  } else {
    // 只挑通道自己的三个字段：draft 里残留的模型商字段不会跟着提交
    const row = { type: draft.type, url: draft.url, events: [...draft.events] };
    if (draftIndex.value >= 0) push.channels.splice(draftIndex.value, 1, row);
    else push.channels.push(row);
  }
  drawer.value = false;
  ElMessage.success('已写入待保存列表，记得点「保存」');
}

/** 保存某节：PUT /settings/ai 或 /settings/push，整包覆盖。后端 UPSERT settings 并写 settings.update 审计；失败不回滚内存，用户可直接重试。
 *  400 由后端给中文原因（URL 不合法 / 明文 http / 形状不对）原样弹，非 2xx 由拦截器抛错这里 catch。 */
async function save(key) {
  saving.value = key;
  try {
    const payload =
      key === 'ai'
        ? { providers: ai.providers }
        : key === 'push'
          ? { enabled: push.enabled, channels: push.channels, redact: push.redact }
          : { ...sms };
    const data = await http.put(`/settings/${key}`, { value: payload });
    // 短信保存后会回整包掩码配置：回填一次，让刚填的明文密钥立刻变回星号
    if (key === 'sms') {
      Object.assign(sms, data);
      if (data.warning) ElMessage.warning(data.warning);
      else ElMessage.success(sms.enabled ? '已保存，短信认证已开启' : '已保存');
    } else {
      ElMessage.success('已保存');
    }
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    // 失败也要把按钮放开，否则一次校验不过就永久转圈
    saving.value = '';
  }
}

// 账号与口令

// 退出所有会话与改口令都经 store，本页不直接 POST /auth/*：只有它知道令牌怎么清，两处各写迟早不一致。
const session = useSession();
// GET /auth/sessions 的数组原样放着，不做二次加工（排序由后端 created_at DESC）
const sessions = ref([]);
const sessionsLoading = ref(false);
// 退出所有会话的 loading；与 pwdSaving 分开，两个动作各压各的按钮
const revoking = ref(false);
// 改口令三个框只活在内存里，提交成功即清空，不做任何持久化
const pwd = reactive({ current: '', next: '', confirm: '' });
const pwdSaving = ref(false);

/** 拉 GET /auth/sessions（只读，过期会话照实列出）。失败弹中文原因但保留上一次的行：
 *  列表闪成空会被读成会话都被清，那正是本节最不该传达错的结论。 */
async function loadSessions() {
  sessionsLoading.value = true;
  try {
    sessions.value = (await http.get('/auth/sessions')) || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sessionsLoading.value = false;
  }
}

/** 退出所有会话（含自己）：先弹危险确认，再调 store.revokeAll()。后端清空 sessions 并写 session.revoke_all 审计，store 在 finally 清本地并跳登录页；后端不可达时 store 照样清本地，这里再弹错误说明为什么被踢。
 *  确认框放 try 外，点取消时 ElMessageBox reject、本函数直接结束不发请求。 */
async function revokeAllSessions() {
  await ElMessageBox.confirm(
    '这会把 sessions 表整个清空，包括你自己这一条：所有人（含当前这台浏览器）立刻掉线并回到登录页。确认继续？',
    '退出所有会话',
    { type: 'warning', confirmButtonText: '全部退出', cancelButtonText: '取消' }
  );
  revoking.value = true;
  try {
    const data = await session.revokeAll();
    // 条数要报给操作员，但 store 的 finally 已经把 hash 改到 #/login 了：
    // ElMessage 挂在 body 上、不随路由卸载，所以这句会跟着他一路显示到登录页，不会丢
    ElMessage.success(`已注销 ${data?.revoked ?? 0} 个会话，请用口令重新登录`);
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    revoking.value = false;
  }
}

/** 改口令前端预检：与后端同口径（8~64、不等于当前），外加后端没有的两个新口令一致。null 表示可发请求。
 *  刻意不加复杂度校验：后端没判，前端单方面加严会出现界面说不行、curl 说行的两套口径。 */
function passwordProblem() {
  if (!pwd.current) return '请填写当前口令';
  if (pwd.next.length < 8) return '新密码至少 8 位';
  if (pwd.next.length > 64) return '新密码最多 64 位';
  if (pwd.next === pwd.current) return '新密码不能与当前密码相同';
  if (pwd.next !== pwd.confirm) return '两次输入的新口令不一致';
  return null;
}

/** 提交改口令（POST /auth/password 经 store）。成功：新口令写回 config.yaml 即时生效、sessions 全清、panel.password_change 审计（新旧口令不落库），store 随后清本地跳登录；失败保留三个框不清空，401 / 400 的后端中文原样弹。
 *  当前口令填错走 401，会被 api/client.js 拦截器清本地并跳登录页，这是拦截器既有口径。 */
async function submitPassword() {
  const problem = passwordProblem();
  if (problem) {
    ElMessage.warning(problem);
    return;
  }
  pwdSaving.value = true;
  try {
    await session.changePassword(pwd.current, pwd.next);
    // 成功后清空三个框，组件卸载前不留口令副本
    pwd.current = '';
    pwd.next = '';
    pwd.confirm = '';
    ElMessage.success('口令已修改并写回 config.yaml；所有会话已作废，请用新口令重新登录');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    pwdSaving.value = false;
  }
}

/** ISO 串 → 本机时区日期时间到分钟。空值与解析失败由 fmtTime 兜底，本页不自己 slice / replace。 */
function fmt(value) {
  return fmtTime(value);
}

/** 毫秒时间戳（会话 expires_at 是数字不是 ISO 串）格式化，与 fmt 同形状；非有限正数给空。
 *  单独一条路径：expires_at 与 created_at 类型不同，直接丢给 fmtTime 会让脏毫秒原样露出 13 位裸数字，被读成记录 id。 */
function fmtMs(value) {
  const ms = Number(value);
  return fmtTime(Number.isFinite(ms) && ms > 0 ? ms : null);
}

// 配置体检

// level 取自 configCheck.js 的 Finding，只有 error / warn / info 三档；没问题表现为 findings 空数组，不凭空加一档绿色。
const FINDING_LABEL = { error: '错误', warn: '提醒', info: '说明' };
// info 用 .lab-chip 本色（灰）而不是 is-ok 的绿：它是一句陈述不是通过项。
const FINDING_TONE = { error: 'is-danger', warn: 'is-warn', info: '' };

// GET /config-check 的整包响应；null 表示还没查过，给空态而不是一屏假绿
const check = ref(null);
const checkLoading = ref(false);

/** 拉 GET /config-check（纯读、恒 200，报不出问题也算结论）。只有会话失效或后端不可达才失败，弹中文原因并保留上次结论，清成 null 会让刷新失败看着像没查过。 */
async function loadCheck() {
  checkLoading.value = true;
  try {
    check.value = await http.get('/config-check');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    checkLoading.value = false;
  }
}

/** 启动摘要拼成带换行的多行串，交给 pre-wrap 的 .lab-mono 渲染。 */
const summaryText = computed(() => (check.value?.summary || []).join('\n'));

/** login_security 的别名：模板少写一层可选链，没查到时落到空对象而不是 undefined */
const ls = computed(() => check.value?.login_security || {});

/** 白名单注脚：启用时列名单原文（IP 是准入范围不是凭据，列出来才核对得了），未启用直说任何来源都能试，0 条本身说明不了这点。 */
const allowIpsText = computed(() =>
  ls.value.allow_ips_enabled ? (ls.value.allow_ips || []).join('、') : '未启用：任何来源都能尝试登录'
);

/** 锁定阈值注脚：把次数 / 分钟说成一句人话，省得操作员猜 max_fails 的单位与窗口。 */
const lockText = computed(() => `同一来源 ${ls.value.lock_window_minutes ?? 0} 分钟内攒满即锁`);

// 数据保留与清理

// 走保留期的四张表→标签，键名与后端 maintenance.js 的 RETENTION_TARGETS 一致；按常量遍历让顺序固定（审计排最后，保留期也不同）。
const TABLE_LABELS = { records: '上钩记录', events: '命中事件', push_logs: '推送流水', audit_logs: '操作审计' };
// 允许删文件的三个白名单目录（config.paths 键名）→标签；uploads 不在里面，那是仿站素材，后端也从不删。
const DIR_LABEL = { attachments: '邮件附件', screenshots: '上钩截图', outbox: '沙箱发件留底' };

// GET /maintenance/status 的整包；null 表示还没读过
const maint = ref(null);
// 最近一次 POST /maintenance/run 的返回（试算与真删共用一个位置，靠 dry_run 区分措辞）
const sweep = ref(null);
const maintLoading = ref(false);
// 正在跑哪一种（'dry' | 'run' | ''）：两颗按钮各自压 loading，互不影响
const sweeping = ref('');

/** 读保留期状态：GET /maintenance/status 带 withFiles，会 stat 三个目录里的每个文件，文件上万时明显变慢，只在挂载后手动调用绝不轮询。
 *  覆写 maint 但不动 sweep（重读状态不该抹掉上次清理结果），失败弹中文原因并保留上次数字。 */
async function loadMaint() {
  maintLoading.value = true;
  try {
    maint.value = await http.get('/maintenance/status');
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    maintLoading.value = false;
  }
}

/** 待清理行数摊成 LabMetric。非零压 warn 底：这不是成绩，是还有多少明文等着到期，全 0 才干净。
 *  audit_logs 的 extra 点明它走更长的独立保留期，否则四个数字看着像同一个 cutoff 数出来的。 */
const pendingRows = computed(() => {
  const pending = maint.value?.pending || {};
  return Object.keys(TABLE_LABELS).map((key) => ({
    key,
    label: TABLE_LABELS[key],
    count: pending[key] ?? 0,
    extra: key === 'audit_logs' ? '走更长的审计保留期' : '按演练数据保留期',
    tone: (pending[key] || 0) > 0 ? 'warn' : '',
  }));
});

/** 保留期天数白话：正数显 N 天，否则显不清理。0 / 负 / NaN 后端都按未启用（即永不删）处理，直接显示 0 天会被读成今天就删今天。 */
function retentionText(days) {
  const n = Number(days);
  return Number.isFinite(n) && n > 0 ? `${n} 天` : '不清理';
}

/** 字节数人话化（files_bytes 可达几 GB）。全站只这一处要显示字节，单开 utils 不值当，也不塞进只管时间的 utils/time。 */
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // 取刚好 ≥1 的那一档：1023 KB 比 0.99 MB 好读，量级跳变发生在数字变成 1 时
  const level = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** level;
  return `${level === 0 ? value : value.toFixed(1)} ${units[level]}`;
}

/** 落盘文件实际删除数拼一行，只列非零目录；全 0 时说没有到期的落盘文件。 */
const filesText = computed(() => {
  const files = sweep.value?.files || {};
  const parts = Object.keys(DIR_LABEL)
    .filter((key) => (files[key] || 0) > 0)
    .map((key) => `${DIR_LABEL[key]} ${files[key]} 个`);
  return parts.length ? parts.join('、') : '没有到期的落盘文件';
});

/** 清理对照表：计划数与实际数并排。真删时两者不等说明中间有新数据落库或有脏行，是运维信号。
 *  试算时 removed 给 null 而非 0：dry_run 下后端不进删除逻辑，显示 0 会读成本来没可删、与 pending 矛盾。 */
const sweepRows = computed(() => {
  const s = sweep.value;
  if (!s || s.skipped) return [];
  return Object.keys(TABLE_LABELS).map((key) => ({
    key,
    label: TABLE_LABELS[key],
    pending: s.pending?.[key] ?? 0,
    removed: s.dry_run ? null : (s.removed?.[key] ?? 0),
  }));
});

/** 跑一次清理（POST /maintenance/run，body { dry_run }）：dry-run 只算不删、后端连审计都不写；真删写 plan + applied 两条 data.prune 审计（actor 取当前登录名，定时器那条为 null），删完覆写 sweep 并重取 status。
 *  确认框只在真删时弹且放 try 外，取消即不发请求；文案里带上会带走的行数。500 原样弹不吞成成功，未启用回 skipped 按 info 展示。 */
async function runSweep(dryRun) {
  if (!dryRun) {
    const pending = maint.value?.pending || {};
    const plan = Object.keys(TABLE_LABELS)
      .map((key) => `${TABLE_LABELS[key]} ${pending[key] ?? 0} 条`)
      .join('、');
    await ElMessageBox.confirm(
      `将按保留期永久删除以下过期数据：${plan}，以及三个白名单目录里的过期文件。删除后不可恢复，事后只能靠 data.prune 审计自证删过多少。确认继续？`,
      '立即清理',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    );
  }
  sweeping.value = dryRun ? 'dry' : 'run';
  try {
    const data = await http.post('/maintenance/run', { dry_run: dryRun });
    sweep.value = data;
    if (data?.skipped) {
      // skipped 是保留期未启用的正常退路不是失败，用 info，弹红会让人以为清理坏了
      ElMessage.info(data.reason || '本次没有执行');
    } else if (dryRun) {
      ElMessage.success('试算完成，没有删除任何数据');
    } else {
      ElMessage.success(`清理完成，耗时 ${data?.seconds ?? 0} 秒`);
    }
    // 只有真删过才重取 status（pending / next_sweep_at / files_pending 都变了）；试算与 skipped 没改动任何东西，重取只是白跑一次目录 stat。
    if (!dryRun && !data?.skipped) await loadMaint();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    sweeping.value = '';
  }
}

// 只在挂载时拉一次：外层 KeepAlive 缓存本页，切回来是上次数据，要新鲜值用各节按钮。
// 会话清单轻且是账号一节正文，跟着拉；配置体检按设计是手动动作、保留期状态要 stat 每个目录文件，都不自动拉。
onMounted(() => {
  load();
  loadSessions();
});
</script>

<style scoped>
.run-kv { margin-bottom: 10px; }
.sub-hd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 16px 0 10px; padding-top: 12px; border-top: 1px solid var(--lab-line-2); }
.ev-chip { margin: 2px 4px 2px 0; }
.edge { display: flex; flex-direction: column; gap: 14px; }
.edge-row > .lab-chip { margin-bottom: 8px; }
.edge-list { margin: 8px 0 0; padding-left: 18px; color: var(--lab-ink-2); font-size: 12.5px; line-height: 1.9; }
.drawer-foot { display: flex; justify-content: flex-end; gap: 8px; }
/* 账号与口令是 flush 面板，表格以下正文自己补 14px 内边距；上边距给 0，否则最后一行与下面按钮间空出一整格 */
.pane-bd { padding: 12px 14px 14px; }
/* 状态列里两颗 chip 会同时出现（自己这条已过期），不给间距就粘成一条 */
.sess-chip { margin-left: 4px; }
/* 改口令的三个框不拉满整屏：宽面板里一条 1000px 的密码框既难看又让人以为要填很长一串 */
.pwd-form { max-width: 420px; }
/* 体检结论一行可能是三四句中文，chip 要贴顶而不是垂直居中，否则折行后 chip 飘在句子中间 */
.find-item { align-items: flex-start; }
.find-item > .lab-chip { flex: 0 0 auto; }
/* 三条告警之间的间距：el-alert 自己没有外边距，连着摆会贴成一块 */
.gap-b { margin-bottom: 10px; }
/* 清理结果与上面的状态区隔开一条线：这两块数字很容易看串，试算的 pending 尤其像状态里的 pending */
.sweep-box { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--lab-line-2); }
/* 空表只留一行虚线提示：Element 默认空态块高 60px 再加一句「暂无数据」，与下方行动指引叠成两段空白，
   看起来像加载失败；空表时直接不渲染表体，指引由 .config-empty 给 */
.config-empty {
  margin: 10px 0 0;
  padding: 14px 16px;
  border: 1px dashed var(--lab-line);
  border-radius: var(--lab-radius);
  background: var(--lab-fill-2);
  color: var(--lab-ink-3);
  font-size: 12.5px;
}

/* 短信配置：两列栅格，窄屏收成一列；输入宽度跟格子走，不要撑满整块面板 */
.sms-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0 16px;
}
.sms-grid :deep(.el-input-number) { width: 100%; }
.sms-adv { margin-top: 4px; border-top: 1px dashed var(--lab-line-2); border-bottom: none; }
.sms-adv :deep(.el-collapse-item__header) { font-size: 12.5px; color: var(--lab-ink-3); background: transparent; }
.sms-adv :deep(.el-collapse-item__wrap) { background: transparent; }
.sms-link { color: var(--lab-accent); }
</style>

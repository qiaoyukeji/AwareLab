# AwareLab · 安全意识演练平台

<div align="center">
  <img src="brand/awarelab-logo.svg" alt="AwareLab" width="320" />
  <br />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%20%2F%2011%20x64-0078d4.svg" alt="Windows 10 / 11 x64" />
  <img src="https://img.shields.io/badge/%E5%BD%A2%E6%80%81-%E5%8D%95%E6%96%87%E4%BB%B6%E6%A1%8C%E9%9D%A2%E7%A8%8B%E5%BA%8F-0f766e.svg" alt="单文件桌面程序" />
</div>

AwareLab 是一套装在自己电脑上、专门用来做**钓鱼邮件与钓鱼网站演练**的安全意识平台。拿到书面授权之后，安全团队用它做四件事：准备素材、挂起钓鱼网站、发出演练邮件、把"谁打开了、谁填了、填了什么"记录成可交付的上钩证据。

它不是一个装在服务器上的 SaaS，而是一个**双击就打开的桌面程序**：界面在它自己的窗口里，不经过用户的浏览器。点开 `AwareLab.exe`，任务栏出现 AwareLab 的图标；同时会弹一个只有四行字的小控制台（地址、账号、口令、数据目录），**随手关掉它不影响程序运行**。关主窗口就是退出，数据留在 exe 旁边的 `AwareLab-data` 目录里，拷走整个文件夹就换了台机器继续。

> 这个工具的危险性在于"能仿真钓鱼"。所以平台把**演练授权**做成硬约束：没有处于生效窗口内的授权登记，建站监听和邮件发送一律拒绝；钓鱼网站只接受授权名单里的域名；邮件默认走沙箱，不会真的寄出去。

## 一、功能

### 演练前的准备

| 能力 | 说明 |
| --- | --- |
| 演练授权 | 三步登记：授权主体、允许仿冒的域名（支持精确域名、`*.example.com` 泛域名、`#ip`）、有效期（7 / 30 / 90 天或自定义）。勾一次合规承诺才解锁后续功能；可编辑续期，**改短有效期会立刻停掉越出窗口的网站监听** |
| 内置模板库 | 随包 21 套页面、18 套邮件、6 套教学页：企业邮箱、SSO、VPN、共享文件、邮箱扩容、会议邀请、工资条、快递、MFA、OA、财务 ERP、WiFi 准入、短信验证码、扫码确认、报销、考勤、电子发票、停机维护、口令策略、在线考试、身份核验。缩略图是真实渲染，点「使用此模板」复制成自己的副本再改 |
| 复制时换品牌 | 模板复制前可填单位名称、选主色，副本里的品牌名、logo 字、主色与深色变体一起换掉；预览弹窗列出这份模板的「可改点」（标题、表单字段名、提交后提示语在哪一行），不用在源码里找 |
| 假登录页素材 | 纯 HTML，写一个 `<form>` 就被平台接管采集；五项智能诊断（采集绑定 / 提交触发点 / 外部资源 / 自定义脚本 / 可采集字段），保存前就知道能不能收到东西 |
| 邮件文案素材 | 富文本与 HTML 双模编辑；正文写 `{{site_url}}/login`，发送时按任务绑定的网站替换 |
| 一键仿站 | 输入目标地址生成仿站素材，人工审过再存成假登录页 |
| 上钩教学页 | 用户提交后被导向的教育页，按网站绑定 |

### 演练中的投放

| 能力 | 说明 |
| --- | --- |
| 钓鱼网站 | 每个网站独占一个监听端口（默认 8000–9999），保存即开、重启自动恢复。「访问方式」二选一：**域名反代**时外网 `https://域名` → 内网 `127.0.0.1:8080`，邮件链接、跳转、像素、二维码都只带域名、不带端口；**IP:端口直连**时才把端口写进链接。抽屉底部「链接拼接结果」随填随算，把页面地址、专属链接、`{{site_url}}` 与真实监听口摆在一起 |
| 钓鱼邮件 | 发信邮箱 + 发送任务；任务绑定一个开启中的网站，正文 `{{site_url}}`、站内链接与打开像素都落到那个网站。沙箱只渲染成 `.eml` 落盘，显式关掉沙箱才真实发送 |
| 专属链接 | 每个收件人一条 `?tk=` 链接，打开与提交都归到这个人头上；非专属直访也会发访客 Cookie，多次打开仍算同一终端 |

### 演练后的复盘

| 能力 | 说明 |
| --- | --- |
| 上钩记录 | 先按**每个网页 / 每个任务**分组看板（含零上钩的），点进去看这一组的全部记录：打开→提交漏斗、UA 与设备分类、提交历史（同一终端多次提交全留）、附件回传截图 |
| 处置闭环 | 每条记录标 新增 / 已联系 / 已教育 / 已关闭，单条与批量都行；按授权统计教育覆盖率 |
| 凭据掩码 | 列表与详情默认打码，明文逐字段点开，每次查看单独写一条审计；交付件脱敏，取证 CSV 保留明文 |
| 交付报告 | 按授权出汇总、可打印的 HTML 报告与掩码版交付 CSV |
| 观测视图 | 三套深色大屏：总览、单站点、单任务；8 秒刷新、18 秒轮播，适合挂墙 |
| 操作审计 | 授权增删改、沙箱开关、真实发送、证据导出与删除、运行参数变更逐条留痕，界面只读 |

### 账号与运行

| 能力 | 说明 |
| --- | --- |
| 两级账号 | 管理员能改系统设置、看全部记录；普通用户只看到分给自己的部分。口令 scrypt 哈希入库，活动会话可列出并逐个吊销，登录失败计数落库、重启不清零 |
| 短信认证 | 接阿里云号码认证：填 AccessKey 与模板后开启，普通用户登录需短信码；管理员不受影响，避免短信故障把人锁在门外 |
| 配置体检 | 启动时检查让防线失效的写法（对外监听、信任代理头、出厂口令未改），给出改法 |
| 数据保留 | 按保留期自动清理证据与落盘产物，可先试算；一次性清空只留给命令行 |
| 版本与上手 | 侧栏、页脚、标签页标题、登录页都显示版本；「演练总览」页头的「使用说明」用五步讲清从登记授权到复盘收尾，首次登录自动展开一次 |

刻意**不实现**：反溯源与反检测、把凭据实时转发第三方、免杀载荷生成。这些超出安全意识演练所需，属于纯增风险。

## 二、界面预览

左侧导航 + 顶栏的常规后台形态，授权、素材、投放、复盘各自成组：

<table>
  <tr>
    <td width="50%"><img src="docs/images/console.png" alt="演练总览" /><br /><sub>演练总览：授权进度、命中漏斗与教育闭环</sub></td>
    <td width="50%"><img src="docs/images/mandate-dialog.png" alt="登记演练授权" /><br /><sub>登记授权：主体 / 域名 / 有效期，勾选一次合规确认</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/library.png" alt="内置模板库" /><br /><sub>模板库：21 套页面、18 套邮件、6 套教学页，缩略图即真实渲染</sub></td>
    <td width="50%"><img src="docs/images/outbound-editor.png" alt="发送任务编辑" /><br /><sub>发送任务：绑定网站，<code>{{site_url}}</code> 与像素落到站点端口</sub></td>
  </tr>
</table>

观测大屏是另一套深色布局（1920×1080 实机截图），总览、单站点、单任务各一屏（[单站点屏截图](docs/images/screen-site.png)）：

<table>
  <tr>
    <td width="50%"><img src="docs/images/screen-overall.png" alt="总览大屏" /><br /><sub>总览大屏：所有站点与任务叠在一屏</sub></td>
    <td width="50%"><img src="docs/images/screen-task.png" alt="任务大屏" /><br /><sub>任务大屏：送达趋势、打开→点击→提交比率、命中流水</sub></td>
  </tr>
</table>

## 三、三个平面

一个进程里并存三张网络面，职责与暴露面各不相同：

```
管理面  /{32位随机路径}/            登录鉴权，所有增删改查走这里
        /{32位随机路径}/api/*       REST 接口，会话头 x-alab-token

钓鱼网站（采集面）  每网站独立端口 8000–9999     对目标人群开放的仿冒页面
        按授权名单校验域名        注入运行时，同源上报 /alab/v2/engage
                                  同时承接 /alab/v2/pixel、/alab/v2/trace

信标面  公开、无鉴权              GET  /alab/health          部署自检
        只接受已知令牌            GET  /alab/v2/pixel         邮件打开像素（回退）
                                  GET  /alab/v2/trace         链接改写跳转（回退）
                                  POST /alab/v2/callback      附件回传
```

信标面公开可达，所以每条自带闸门：`trace` 只放行授权名单内的跳转目标；`callback` 只认本次演练发出的令牌（陌生令牌 400、授权窗口关闭 410），文件限 png/jpeg/pdf/zip 且文件头与扩展名必须自洽，单文件 5MB、单次 3 个、40 个字段，并按令牌与来源 IP 双维度限流。平台收的是演练证据，不是任何人想塞进来的文件。

`pixel` 与 `trace` 在管理面端口和每个采集端口共用同一份处理器；实际投递时优先写到任务绑定网站的端口，管理面那份是旧邮件与"没有可用网站"时的回退面。

## 四、实现方式

### 选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js（ESM）≥ 22.13，内置 `node:sqlite` | 采集面要按站点逐个开监听端口并管生命周期，进程内 `http`/`https` + 事件循环是成本最低的形态；SQLite 内置意味着零原生编译、零外部服务 |
| 后端 | Express 4 | 三个面都只需要路由与中间件，不需要框架代劳数据层 |
| 数据库 | `node:sqlite`（`DatabaseSync`）+ WAL | 单文件库，演练数据留在本机才谈得上"凭据不出内网" |
| 配置 | js-yaml | 配置文件要能人手读改，首次启动回写一份带随机口令的默认值 |
| 邮件 | nodemailer（SMTP + streamTransport） | 真发与沙箱复用同一份渲染逻辑，沙箱里看着对的邮件，真发也不会变形 |
| 上传 | multer（memoryStorage） | 文件先在内存里认完魔数再决定落不落盘 |
| 前端 | Vue 3 + Vue Router（hash）+ Pinia + Element Plus + ECharts | 后台形态的表格、抽屉现成；hash 路由让页面挂在随机路径下不需要任何服务端重写 |
| 桌面外壳 | C# WinForms + WebView2（.NET Framework 自带编译） | 用系统里已有的 Edge 内核显示界面，不额外塞一个 Chromium，产物只多 1MB 左右的启动器 |
| 打包 | Node SEA + postject + csc | 服务端打成单文件 exe，前端以 gzip+base64 内联，最终由启动器把两者合成一个可双击的程序 |

刻意不引入：TypeScript、ORM、CSS 预处理器、外部数据库与消息队列。表只有 18 张、查询以分页与聚合为主，直写 SQL 更好审。

### 进程装配

```
AwareLab.exe（桌面启动器，C# WinForms + WebView2）
  ├─ 解包内嵌的 AwareLabServer.exe 与 WebView2 运行库到 %LOCALAPPDATA%\AwareLab\app\<版本>
  ├─ 无窗口拉起服务端，把 AWARELAB_HOME 指到 exe 同级的 AwareLab-data
  ├─ 解析服务端打印的「管理后台: http://127.0.0.1:端口/随机路径」
  └─ 用自己的窗口打开该地址（任务栏是 AwareLab 的图标，不经过系统浏览器）

AwareLabServer.exe（Node SEA）
  ├─ boot/main.js              进程装配
  ├─ platform/settings.js      读 config.yaml（缺则生成随机后台路径与账号口令并回写）
  ├─ platform/storage          打开 SQLite → WAL + foreign_keys → 逐级迁移
  ├─ channels/beaconPlane      信标面（公开无鉴权）
  ├─ channels/adminPlane       管理面（随机路径 + 会话）+ 托管前端产物
  └─ server.listen(port, bind) → 恢复 status=open 的站点监听

AwareLabInfo.exe（控制台小程序）
  └─ 打印管理地址、账号口令、数据目录；关掉它不影响主程序
```

服务端进程被挂进一个 Windows 作业对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）：启动器不管是正常关窗、崩溃还是被任务管理器结束，服务端都会跟着结束，不会留下占着端口的僵尸进程。

### 数据层

- **迁移**：`PRAGMA user_version` 记录版本，`MIGRATIONS` 数组逐级递增（v1 基线 14 表 → 现在 18 张表、`user_version = 8`）；建表一律 `IF NOT EXISTS`，升级只加不改。
- **参数归一**：`rows.js` 把 `undefined → null`、布尔 → `0/1`，业务侧不必在每条语句重复处理。
- **证据模型**：`records` 以 `(kind, token)` 为业务主键，同一终端反复命中只有一条记录；`form_json` 存提交历史数组而不是最新快照，超过 50 条截断。原始明细另写 `events` 表（`page_open` / `form_fill` / `mail_open` / `attachment_run`），列表读记录、回溯读事件。
- **审计分职**：`audit_logs` 记操作员动过什么（只增不改），`push_logs` 记往外发了什么，互不替代。

### 采集面

1. **渲染**：只在 `</body>` 前插入一段片段，不改写模板的标签结构——仿真的保真度靠这条。
2. **配置载体**：注入 `<script type="application/alab+json" id="alab-boot">`，浏览器不执行它，页面脚本也拿不到全局命名空间；序列化时把 `<` 转义成 `\u003c`，模板里出现 `</script>` 也不会提前截断。
3. **运行时**：紧随其后的 IIFE 只从配置块读参数，对外挂 `window.AwareLab = { token, collect, report, submit }`。令牌解析顺序 `?tk=` → `sessionStorage` → 配置块；采集按 `name` 归集，`data-al-ignore` 跳过，同名多值合并为数组。
4. **触发**：默认拦截 `submit`；无 form 的页面认 `data-al-collect`；只剩 `type="button"` 时兜底把表单按钮当提交（捕获阶段先于页面自己的内联 `onclick`）。
5. **上报与响应解耦**：上报带 `keepalive`，失败仍执行提交后的动作（提示 / 跳转 / 教学页），现场不能出现"点了没反应"。
6. **门禁**：站点先校验是否开启、模板是否还在，再走 `gate()` 把授权窗口与 Host 名单一起判掉（403 无授权 / 410 已过期 / 404 域名越界）；门禁不过既不渲染也不写记录，上报体 512KB 上限。

### 邮件

- **合成**：`{{name}}` / `{{email}}` 在标题与正文都展开；`{{site_url}}` 换成绑定网站的地址；打开像素插在 `</body>` 前；正文里的绝对链接逐个比对开启中的站点，命中哪个就改写到那个站点的 `/alab/v2/trace?tk=…`，跳转与计数共用一次点击。
- **两条传输同源**：沙箱用 `streamTransport` 写成 `data/outbox/*.eml`，全程不建网络连接；真实发送才建 SMTP。
- **状态机**：收件人 `pending/failed → sandboxed/sent`，任务 `draft/sending → sent`，逐个投递、失败只标该收件人；重发只挑没发成功的，不重复轰炸同一个人。

### 前端

- **外壳**：`createWebHashHistory`，7 个工作区一条路由表生成，全部懒加载；观测视图 `/screen` 独立于工作台外壳，便于全屏挂墙。
- **后台路径不进产物**：`index.html` 里是 `__ALAB_PANEL_VALUE__` 占位符，服务端读 `web/dist/index.html` 时替换成真实随机路径。构建产物里没有任何入口信息。
- **请求层**：一个 axios 实例统一带 `x-alab-token`、摊平 `{code,data,message}` 信封。
- **状态**：Pinia 只放会话，业务数据由面板自持（后台表格要的是"按刷新才动"，不是隐式同步）。

### 安全要点

| 机制 | 做法 |
| --- | --- |
| 会话 | 令牌走 `x-alab-token`，Cookie 只是兜底（`HttpOnly; SameSite=Strict`）；`sessions` 表记来源与最后登录时间，可逐个吊销，改口令后旧会话全部失效 |
| 登录限速 | 按来源 IP，10 分钟窗口 8 次失败即锁，计数落库、重启不清零 |
| 授权门禁 | `findActive()` → `effectiveStatus()` → `gate()` 三态拒绝；写操作侧另有 `assertDeployment()`，建站、发送、仿站在进业务前就被拒 |
| 响应头 | CSP `default-src 'self'`、`frame-ancestors 'none'`、nosniff、no-referrer，关掉 `x-powered-by` |
| 掩码 | 发信口令与 API Key 只写不读（回显 `******`）；URL 里的 `token/key/sign/secret` 入库前掩码；采集字段默认打码，明文逐字段查看且每次写审计 |
| 富文本 | 邮件正文与教学页入库前净化，预览走净化后的 `srcdoc` |
| 真实发送 | 关沙箱与真发都要界面确认，真发要手输收件人数对得上才放行，两个动作各写一条审计 |
| 口令不打印 | 启动横幅只给配置文件指引——stdout 会被 nohup / journald / 容器日志复制走 |

## 五、从源码运行

```bash
cd server && npm install     # 需要 Node ≥ 22.13（内置 node:sqlite）
npm start                    # 首次启动随机生成后台路径、账号与口令，写入 server/config.yaml
cd ../web && npm install
npm run build                # 产出 web/dist，由 server 直接托管
```

启动后控制台打印管理后台地址与账号；**口令不打印**，第一次登录从 `server/config.yaml` 的 `panel.password` 取。管理面默认只听 `127.0.0.1:7778`，改成 `0.0.0.0` 时启动会警告一行。

开发态：`server` 跑 `npm run dev`，`web` 跑 `npm run dev`（Vite 在 `http://localhost:7777/`，读 config.yaml 的随机路径把 `/api` 代理到 7778）。

端口约定：**7777 前端开发服务器**（只在开发态存在）、**7778 管理面与信标面**、钓鱼网站另占 **8000–9999**。

## 六、打包成 exe（双击即用）

### 需要什么

- Node.js ≥ 22.13（打包时要用它的 SEA 机制）
- `server` 目录已 `npm install`，会装上 `esbuild` / `postject` / `rcedit` / `png-to-ico`
- Windows 自带的 .NET Framework（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`），用来编译桌面启动器
- 系统里要有 WebView2 运行时；Windows 10 1803 以后普遍自带，缺了启动器会提示并退回系统浏览器

启动器依赖的 WebView2 托管库放在 `launcher/lib/`（`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll`），来自 NuGet 包 `Microsoft.Web.WebView2`，已随仓库提供，不需要联网。

### 一条命令

```bash
cd server
npm run build:exe
# 产物：dist/AwareLab.exe（约 103MB）
```

这条命令按顺序做七件事：

1. 构建前端 `web/dist`（`--skip-web` 可跳过）；
2. esbuild 把 `server/src/boot/seaEntry.js` 连同依赖打成一份 CJS；
3. 生 SEA blob；
4. 复制一份 `node.exe` 并注入 blob，得到 `server/build/AwareLabServer.exe`；
5. 编译控制台小程序 `AwareLabInfo.exe`（打印启动信息）；
6. 用 csc 编译 `launcher/*.cs` 成 `dist/AwareLab.exe`，把服务端、WebView2 运行库、图标 **全部作为资源内嵌**；
7. 用 rcedit 写图标与版本信息。

只要服务端、不要启动器时加 `--skip-launcher`，产出 `dist/AwareLabServer.exe`（老式的控制台程序，双击会开浏览器）。

### 双击之后发生什么

1. 启动器在 `%LOCALAPPDATA%\AwareLab\app\<版本>` 解出服务端与 WebView2 库（同一版本只解一次）；
2. 在 exe 同级建 `AwareLab-data/`（目录不可写时退到 `%LOCALAPPDATA%\AwareLab`），首次运行生成 `config.yaml`、迁移数据库、写入内置素材；
3. 无窗口拉起服务端，解析它打印的管理面地址；
4. 弹出一个独立窗口显示后台，任务栏里是 AwareLab 图标；同时弹出一个小控制台，只打印**管理地址、账号、口令、数据目录**这几行；
5. 关掉那个小控制台不影响程序；关掉主窗口（或托盘菜单里「退出」）就停服退出。

托盘菜单还有：打开窗口、重新加载、打开数据目录、复制后台地址、退出。窗口里 `Ctrl+R` 刷新。

### 换台机器 / 换个目录

整个 `AwareLab-data` 目录就是全部数据（`config.yaml`、`awarelab.db`、上传与截图、`.eml` 沙箱产物）。**先退出程序**再拷贝——SQLite 用 WAL 模式，运行中复制会拿到不一致的库。

### 几个实话

- exe 没有代码签名，SmartScreen 或个别杀软会提示「未知发布者」。内网分发时给个 SHA256 或加入白名单即可。
- 约 103MB 是因为里面带着 Node 运行时（约 100MB）和前端产物。
- 首次启动解包要一两秒；之后启动基本是即点即开。
- 服务端崩溃时启动器会弹窗并指到 `AwareLab-data/启动日志.txt`；端口被占时服务端会先探测占用者、打印它的 PID 与路径，落在 Windows 保留段（Hyper-V / WSL / Docker）时自动换到相邻可用端口并写回配置。
- `dist/`、`server/build/` 都不进仓库，发布走 Release 附件。

## 七、文档

| 文档 | 用途 |
| --- | --- |
| [docs/使用手册.md](docs/使用手册.md) | 界面字段、按钮原文、完整操作流程、排障速查 |
| [docs/部署与运维手册.md](docs/部署与运维手册.md) | 装到本机或内网服务器、反代与 TLS、备份与保留期、故障速查 |
| [docs/演练值守与缺陷分级.md](docs/演练值守与缺陷分级.md) | 演练期间的值守动作、缺陷分级与处置时限 |
| [docs/培训讲稿.md](docs/培训讲稿.md) | 演练后安全教育可以直接照着讲的讲稿 |
| [docs/术语对照表.md](docs/术语对照表.md) | 界面用词、代码用词与文档用词的对照 |
| [docs/templates/演练授权书.md](docs/templates/演练授权书.md) | 给授权方签字的文书模板，字段与「演练授权」表单逐一对应 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

## 八、许可与使用边界

 Apache-2.0 授予的是版权与专利许可，**不豁免任何司法辖区关于未经授权访问计算机系统、窃取凭据或侵犯个人信息的法律**。用它做没有书面授权的事情，责任在使用者。

- 只对**已获书面授权**的对象演练；授权登记不是走形式，是平台的工作前提。
- 演练前告知被测人群存在演练、明确数据用途；结束后把学习页推送到位。
- 采集到的凭据属于敏感数据，只存本机 SQLite；导出文件按公司数据分级要求保管或销毁。
- 管理面默认只绑 `127.0.0.1`；改成对外监听属于扩大暴露面，启动会警告。
- 不要把本平台部署成公网可达的服务——随机路径不是鉴权，只是降噪。

> 申请软件著作权用的那套材料（申请书、说明书、源程序打印件）只保存在开发者的本地目录，**不纳入版本库**，仓库里也没有它们的任何历史。

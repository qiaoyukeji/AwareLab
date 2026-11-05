# 参与贡献

感谢你愿意改进 AwareLab。这是一个会采集真实凭据的工具，所以贡献的门槛比普通项目
多一层：**先说清楚你要解决的问题，再动手**。

## 开始之前

1. 读 [SECURITY.md](SECURITY.md) 与 [NOTICE](NOTICE) 里的使用边界。反检测、免杀载荷、
   凭据实时转发这类能力不在本项目范围内，这类 PR 不会被合并。
2. 环境要求：Node.js ≥ 22.5（用到内置 `node:sqlite`），npm ≥ 10。
3. 安装：`npm --prefix server install`、`npm --prefix web install`。
4. 跑起来：`npm --prefix server start`（管理面 `http://127.0.0.1:7778/`），
   开发前端用 `npm --prefix web run dev`（`http://localhost:7777/`，已配好 `/api` 代理）。

## 改动规矩（很重要）

- **不要提交** `server/config.yaml` 与 `server/data/`。里面有后台随机路径、管理员口令、
  采集到的凭据与邮件产物，已在 `.gitignore` 内；PR 里出现这些文件会被直接关闭。
- **测试必须隔离**。`node scripts/selftest.mjs` 会在 `server/.selftest/` 里另建配置与
  数据库副本并使用独立端口，绝不触碰 `server/data/`。任何验证脚本要么只读，要么在
  副本上跑，不允许对着操作员真实数据写。
- **协议是冻结的**。`/alab/v2/engage|lesson|pixel|trace|callback`、`x-alab-token`、
  `alab_token`、`alab_tk`、`<script type="application/alab+json" id="alab-boot">`
  由 200 余条端到端断言锁定；协议文档在应用内「系统设置 · 协议文档」，是唯一权威。
- **数据表只加不改**。新增列允许 NULL；禁止重命名或迁移既有列，禁止改动既有演练数据的语义。
- **改完前端必须重新构建并重启后端**。`adminPlane.js` 只在挂载时读一次 `web/dist/index.html`，
  `vite build` 之后不重启，运行中的实例仍在发旧壳。
- 界面文案面向操作员，用大白话（钓鱼网站、上钩记录），不要学术黑话；新增工作区或改顶栏
  结构的提案请先开 Issue 讨论。

## 注释

注释只干一件事：说清代码本身看不出来的约束。门禁为什么中性、端口为什么要分、口令为什么不
进审计——这类判断不写下来，下次改动会被当成冗余删掉。除此之外一律不写：文件职责的复述、
对语法的翻译、"为什么这样设计"的成段论证。

- 文件头最多三行：这个模块负责什么，再加最要紧的一条约束。
- 函数一行说明做什么；只有存在顺序依赖、竞态、旧数据兼容、安全边界或非显然的统计口径时
  才加第二行。不写 `@param` / `@returns`，参数名自己会说话。
- 行内注释只在原因看不见时出现，一行。
- 中文，与界面文案同口径（写「钓鱼网站」，不写「web site 实体」）。
- 缺陷与工单编号留在 `docs/`，不进代码：代码要能脱离某一次整改计划被读懂。
- Vue 单文件组件里 `<template>` 内用 HTML 注释，`<script>` 内用 JSDoc，别把 HTML 注释写进 script。
- 只动注释的提交也要能机械验证：与改动前逐行 diff，新增和删除的行必须全部是注释行或空行。

## 提交前自检

一条命令跑完机器能跑的全部门禁（推荐）：

```bash
node server/scripts/ci.mjs           # syntax → lint → build → selftest → qa → seed → audit
node server/scripts/ci.mjs --only=qa # 只跑某一步（id 见脚本里的 STEPS）
```

要单独跑也可以在 `server/` 下逐条执行：

```bash
npm run lint                     # 后端 ESLint（扁平配置，需先 npm install 装 devDependencies）
npm --prefix web run lint        # 前端 ESLint（含 eslint-plugin-vue 的 essential 档）
node scripts/qa.mjs              # 四维用例：安全 / 功能 / 流程 / 人性化（当前 86 条）
node scripts/selftest.mjs        # 端到端：应全绿（当前 246 项）
node scripts/smoke.mjs           # 只读探针：对着你在跑的实例，24 项
npm --prefix web run build       # 前端构建
```

lint 的取向写在两端的 `eslint.config.mjs` 头部：只抓会咬人的写法（未定义/未使用变量、
无用赋值、吞掉 `cause` 的重抛、恒定条件），**不做格式化**。仓库源文件在本机是 CRLF，
格式化规则一开就是满屏 diff，还会让「按行 diff 证明只改了注释」这道验证门失效。

都过再提 PR。改了用户可见行为，请同步 `README.md`、`docs/使用手册.md` 与
`CHANGELOG.md`——文档不一致按缺陷处理。

### 验证脚本为什么不单独放 `tools/`

整改方案（GOV-04）提过把 `server/scripts/*` 从生产代码里分出去。实测后**没有采纳**，
理由记在这里免得下一个人再提一遍：

- 这些脚本靠相对路径读 `../src/**` 与 `../package.json`（`ci.mjs` 要算 `SERVER_ROOT`、
  `qa.mjs` 要起 `src/boot/main.js` 子进程），搬到仓库根的 `tools/` 只会把所有路径都加一层 `../`；
- 它们本来就不在服务端启动链路上——`src/boot/main.js` 从不 import `scripts/`，
  "生产代码"与"验证脚本"的边界由 import 图决定，不由目录名决定；
- `npm test` 已经指向 `scripts/selftest.mjs`，`ci.mjs` 也把两端路径收在一处，入口没有歧义。

隔离约定照旧生效：`selftest` 写 `server/.selftest/`、`qa` 写 `server/.qa/`、
`seed` 只读打开 `server/data/awarelab.db` 再 `VACUUM INTO` 副本，谁都不许直接写操作员数据。

## PR 描述请写清

1. 解决什么问题（现象 + 复现路径），不要只写"优化"；
2. 改了什么、为什么这样切；
3. 怎么验证的（断言条数、走查路径、是否动过数据）；
4. 有没有影响协议、数据库结构或默认安全设置——这三项任一为"是"，请在描述里显式标注。

## 许可

提交即表示你的贡献按 [Apache-2.0](LICENSE) 授权给本项目，并同意出现在
[NOTICE](NOTICE) 所描述的再分发条件下。

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

## 提交前自检

```bash
node scripts/selftest.mjs          # 端到端：应全绿（当前 208 项）
node scripts/smoke.mjs             # 只读探针：对着你在跑的实例，24 项
npm --prefix web run build         # 前端构建
```

三条都过再提 PR。改了用户可见行为，请同步 `README.md`、`docs/使用手册.md` 与
`CHANGELOG.md`——文档不一致按缺陷处理。

## PR 描述请写清

1. 解决什么问题（现象 + 复现路径），不要只写"优化"；
2. 改了什么、为什么这样切；
3. 怎么验证的（断言条数、走查路径、是否动过数据）；
4. 有没有影响协议、数据库结构或默认安全设置——这三项任一为"是"，请在描述里显式标注。

## 许可

提交即表示你的贡献按 [Apache-2.0](LICENSE) 授权给本项目，并同意出现在
[NOTICE](NOTICE) 所描述的再分发条件下。

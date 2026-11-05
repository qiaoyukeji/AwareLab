/**
 * ESLint 扁平配置（后端）：抓会咬人的写法（未定义变量、恒定条件、空 catch 吞异常），不做风格警察。
 * 不开格式类规则：仓库源文件在本机是 CRLF（见 .gitattributes），一开就是满屏 diff，
 * 也会让「按行 diff 证明只改了注释」这道验证门失效。
 *
 * 跑法：`npm --prefix server run lint`（需要先装 devDependencies，见 server/package.json）。
 */
import js from '@eslint/js';

export default [
  {
    // 隔离副本与产物绝不参与 lint：.selftest/.qa/.walk/.functional 里是配置与演练数据的副本，
    // data/ 里是操作员真实数据，扫它们既慢又可能把口令读进日志
    ignores: [
      'node_modules/**',
      'data/**',
      '.selftest/**',
      '.qa/**',
      '.qa-prune-check/**',
      '.walk/**',
      '.functional/**',
      '../web/dist/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      // 关它的理由是成本而非逃避：ESM 里每个文件都有自己的作用域，Node 全局（process/console/URL/crypto）
      // 由运行时提供；开 no-undef 就得维护一张 globals 表，收益不如把注意力留给下面这些真规则。
      'no-undef': 'off',
      // 未使用变量：报错。args: 'none' 是唯一妥协，原因是路由中间件与 builder 的签名要保留占位参数，
      // 删参数会改调用约定，比留一个 _ 前缀更糟
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'all' }],
      // 本项目的 catch 有两种合法形态：静默降级（推送失败只落日志）、和注释说明为什么吞。
      // 允许空 catch 但要求写注释：靠人评审兜底，比强制 throw 更符合「旁路不影响主链路」的设计
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-async-promise-executor': 'error',
      'no-dupe-keys': 'error',
      'no-self-compare': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // 恒定条件（if (true) / while (1)）：本项目里循环都是显式 break 或事件驱动，出现它通常是手滑
      'no-constant-condition': ['error', { checkLoops: false }],
      // 表达式被写成一条独立语句（foo.bar;）几乎都是漏了赋值或漏了 await，本项目的写库/发信调用点尤其忌讳
      'no-unused-expressions': 'error',
      // 全角空格（U+3000）在本项目里是**排版手段**：中文输出用它给竖线分隔符留呼吸位，比半角更好读
      //（见 configCheck.js 的启动摘要、drillReport.js 的报告抬头）。字符串与模板里放行，
      // 代码与注释里照旧报错：那里出现全角空格基本是输入法手滑，且会真的改变语义（关键字与括号之间）。
      // 注意本条注释里不能把那个字符写出来：skipComments 是 false，写了会被这条规则自己拦下。
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: false, skipRegExps: false }],
    },
  },
];

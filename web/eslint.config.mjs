/**
 * ESLint 扁平配置（前端）：只跑 vue/essential 档（真会报错的那几条）加少量 JS 规则。
 * 不取 flat/recommended 的风格类规则：属性换行、self-closing 这类会逼人为了过 lint 改模板结构，
 * 格式化归编辑器（见 .editorconfig）。
 *
 * 跑法：`npm --prefix web run lint`（需要先装 devDependencies）。
 */
import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';

export default [
  {
    // dist 是 vite 产物（已在 .gitignore），.vite 是缓存：扫它们等于给机器生成的代码挑刺
    ignores: ['node_modules/**', 'dist/**', '.vite/**'],
  },
  js.configs.recommended,
  // flat/base 只带 vue 解析器与 essential 规则；用展开是因为插件导出的是数组
  ...pluginVue.configs['flat/base'],
  {
    // 构建配置跑在 Node 里而不是浏览器里：process/__dirname 是合法全局，
    // 但 src 的 globals 表是按浏览器列的，混在一起会让「模板里写了 process」这种真错误失去信号
    files: ['*.config.js', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', __dirname: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['src/**/*.{js,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // <script setup> 里浏览器全局（window/document/location/FormData）是合法的，
      // 与后端同理：开 no-undef 就得维护 globals 表，这里选择关掉
      globals: { window: 'readonly', document: 'readonly', location: 'readonly', localStorage: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', crypto: 'readonly', URL: 'readonly', Blob: 'readonly', FormData: 'readonly', Image: 'readonly', navigator: 'readonly' },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      // watch/await 里空 catch 是「请求失败已在拦截器统一提示」的常见写法，允许但要求有注释
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 模板里最贵的一类事故：解析器报错的根因规则（essential 已含，这里显式写成 error 便于定位）
      'vue/no-parsing-error': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-use-v-if-with-v-for': 'error',
      'vue/no-mutating-props': 'error',
      // v-html 是我们**自己**在预览路径上净化后要用的出口（见 utils/sanitize.js），
      // 所以是 warn 而不是 error：每一处都要过净化，审查时逐条确认，而不是全局关掉这个信号
      'vue/no-v-html': 'warn',
      'vue/valid-template-root': 'error',
      'vue/no-ref-as-operand': 'error',
      'vue/no-duplicate-attributes': 'error',
      // 全角空格（U+3000）在中文界面文案里是排版手段，不是错误，所以字符串与模板放行；
      // 代码与注释照旧报错：那里出现它基本是输入法手滑，且会真的改变语义。
      // 注意 <template> 里的 HTML 注释不算 comment（解析器按模板节点报），那一类只能改文案本身。
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: false, skipRegExps: false }],
    },
  },
  {
    // 协议正文里那段 boot 配置样例必须原样写出 `<\/script>`：SFC 解析器是按原文扫 `</script`
    // 来结束 <script setup> 块的，那个反斜杠是**载荷**不是多余转义，删了整块脚本会被截断。
    // 规则只能按文件关（行内 disable 注释写不进模板字符串里），范围已经收到这一个文件。
    files: ['src/workspaces/platform/ContractPane.vue'],
    rules: { 'no-useless-escape': 'off' },
  },
];

/**
 * 进程入口（boot 层）：由 server/package.json 的 start 脚本启动，一条端口上并行管理面、信标面，采集面各站独立端口。
 * 中间件挂载顺序就是路由优先级：信标面必须先于管理面挂，adminPlane 的 SPA 外壳通配兜底会吃掉不属于它的路径。
 * 启动横幅只打账号不打密码；退出必须走 shutdown 收掉采集端口，否则下次启动 EADDRINUSE；改前端产物后必须重启（外壳只在挂载时读一次）。
 */
import express from 'express';
import { spawn } from 'node:child_process';
import { config, created, CONFIG_FILE } from '../platform/settings.js';
import { checkConfig, fatalMessage, summarizeConfig } from '../platform/configCheck.js';
import { driver } from '../platform/storage/connection.js';
import { securityHeaders } from '../platform/net/securityHeaders.js';
import { mountBeaconPlane } from '../channels/beaconPlane.js';
import { mountAdminPlane } from '../channels/adminPlane.js';
import { restoreSites, stopAllSites } from '../capture/siteRegistry.js';
import { startMaintenanceTimer } from '../platform/maintenance.js';
import { seedBuiltins } from '../library/seed.js';
import { ensureAdminUser } from '../security/users.js';
import { ensurePortFree, portOwnerLines } from '../platform/portGuard.js';

// 横幅第一行；改名要同步 README、docs/使用手册.md 与前端标题
const BANNER = 'AwareLab 安全意识演练平台';

// 配置体检必须在起任何监听之前跑：error 级问题（会话有效期不可解析、端口区间写反、allow_ips 类型错）
// 会让某道防线静默失效，与其带着没防线的进程上线不如当场拒绝启动。error 命中时进程以非 0 退出。
const FINDINGS = checkConfig();
const FATAL = fatalMessage(FINDINGS);
if (FATAL) {
  console.error(BANNER);
  console.error(FATAL);
  console.error(`配置文件: ${CONFIG_FILE}`);
  process.exit(1);
}

/** 管理面监听地址：缺本机，放开到别的网卡要操作员在配置里写明白 */
// 再兜一次 127.0.0.1：配置写成 null/空串时不能让管理面悄悄变成全网卡监听
const PANEL_BIND = config.panel.bind || '127.0.0.1';

// 导出仅供同进程调试；外部脚本请另起子进程拉起本文件，别 import（会真的起监听）
let app = null;
let server = null;

/**
 * 起监听前先体检端口：被占时把「谁占着」查清楚，交互式场景（双击 exe 的控制台）允许当场结束它。
 * 放在种素材 / 起监听之前，是为了冲突时不再白写一次库、也不再让控制台一闪而过。
 * 探测本身失败（权限、命令不存在）按「可用」放行，交给 listen 错误兜底——不能因为查不到就拒绝启动。
 *
 * 整段启动包在 async 函数里，而不是在模块顶层 await：单文件 exe 用 esbuild 打成 CJS，
 * 而 CJS 不支持顶层 await（打包会直接报错）。顶层只留一个不 await 的调用。
 */
async function boot() {
  const portFree = await ensurePortFree(config.panel.port, PANEL_BIND);
  if (!portFree) {
    console.error(`\n启动中止：端口 ${config.panel.port} 仍被占用。`);
    console.error('处理办法：结束上面那个进程，或改 config.yaml 的 panel.port 换一个端口后重试。');
    // 只有「双击出来的控制台」才留窗口；被计划任务/服务拉起时没有 TTY，应该非 0 退出让上层看见失败
    if (process.env.AWARELAB_SEA === '1' && process.stdin.isTTY) {
      console.error('这个窗口先留着，按 Ctrl+C 或直接关闭即可退出。');
      setInterval(() => {}, 1 << 30);
      return;
    }
    process.exit(1);
  }

  // 内置素材播种：必须在建监听之前跑完，操作员第一次打开素材页就能看到页面/邮件模板。
  // 幂等（按 builtin_key 判存在，已有行不覆盖），重复启动只会多一行"已就绪"；失败不能拦住启动，
  // 素材缺失只是少几个模板，比整个平台起不来轻得多，所以这里只告警不抛。
  try {
    seedBuiltins();
  } catch (error) {
    console.warn(`[library] 内置素材写入失败（不影响启动）：${error.message}`);
  }

  // 管理员种子：users 表为空时用 config.yaml 的 panel 账号建第一个管理员（口令按 scrypt 哈希落库）。
  // 幂等：已有启用管理员就直接返回，不会覆盖操作员后来改的口令；失败同样只告警不拦启动。
  try {
    ensureAdminUser();
  } catch (error) {
    console.warn(`[users] 管理员账号初始化失败（不影响启动）：${error.message}`);
  }

  /**
   * 进程装配：一条端口上并行管理面（随机路径+会话）、信标面（公开无鉴权）、采集面（各授权端口独立监听）。
   * 占用 config.panel.port 起监听、注册 SIGINT/SIGTERM、listen 回调里恢复采集站点。
   */
  app = express();
  // 摘掉 X-Powered-By：后台少给扫描器一个免费指纹
  app.disable('x-powered-by');
  // 必须在所有路由之前：安全头给出本进程的每个响应都加上（采集面不经过它）
  app.use(securityHeaders);
  // 8MB 上限：够素材与证据附件，又挡掉超大 JSON body 打满内存；超限与半截 JSON 由 adminPlane 错误中间件分别回 413/400
  app.use(express.json({ limit: '8mb' }));

  // 挂载顺序不能反：信标面先挂，管理面最后挂。adminPlane 的 SPA 外壳通配兜底抢在前面会把不属于它的路径吃成 200+HTML
  mountBeaconPlane(app);
  // 返回值是随机路径字符串本身，只用于打印后台地址；api 前缀、静态壳与错误兜底都在内部挂好
  const panel = mountAdminPlane(app);

  // 主端口监听。回调里每行都可能被日志采集，只报边界不报凭据。
  // 清理定时器句柄放模块作用域：由 listen 回调注册、shutdown() 注销，两处不在同一函数。
  let maintenanceHandle = { stop: () => {}, started: false, reason: '尚未启动' };
  server = app.listen(config.panel.port, PANEL_BIND, () => {
    console.log(BANNER);
    console.log('本工具仅可用于授权范围内的安全意识演练。');
    // 数据库驱动来源：环境不对时先看这一行
    console.log(`数据库驱动: ${driver}`);
    // 配置摘要：把当前生效的安全档位说清楚，全部不含凭据
    for (const line of summarizeConfig()) console.log(line);
    // 只有本次启动真生成了配置文件才提示路径（口令就在里面），避免每次重启都抄凭据位置进日志
    if (created) console.log(`\n首次启动已生成配置文件: ${CONFIG_FILE}`);
    // 固定用 127.0.0.1 显示，即使 PANEL_BIND 放开成 0.0.0.0：给操作员一个总能用的入口，外部访问由下面的警告提醒
    console.log(`\n管理后台: http://127.0.0.1:${config.panel.port}${panel}/`);
    // 口令只留配置文件：启动输出会被 journald/nohup.out/容器日志采集，等于复制到无人看管处
    console.log(`账号: ${config.panel.username}`);
    console.log('密码: 见 config.yaml 的 panel.password（登录成功后建议立即更换）');
    // 配置体检的 warn 级结论（管理面对外监听、trust_proxy 打开、沙箱默认关闭、授权门禁关闭、出厂口令未改）：
    // 都是操作员有意放宽的结果，不拦启动，但每次都要说一遍。随机路径不是鉴权，入口可达+口令被猜中=全部演练数据归对方。
    for (const finding of FINDINGS) {
      if (finding.level !== 'warn') continue;
      console.log(`\n[提醒] ${finding.message}`);
    }
    // 信标面健康检查，公开无鉴权：给部署者一条进程活着的最短验证路径
    console.log(`\n连通性自检: http://127.0.0.1:${config.panel.port}/alab/health`);
    // 单文件 exe 双击即用：起监听后直接把默认浏览器带到后台地址，省掉"复制控制台里的 URL"这一步。
    // cmd /c start 是 Windows 上唯一不依赖额外 shell 关联协议的方式；失败只告警，绝不拦住服务本身。
    if (process.env.AWARELAB_SEA === '1') {
      const url = `http://127.0.0.1:${config.panel.port}${panel}/`;
      try {
        spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        console.log('已尝试打开浏览器；没弹出来就手动访问上面的地址。');
      } catch (error) {
        console.log(`打开浏览器失败（${error.message}），请手动访问上面的地址。`);
      }
      console.log('关闭这个窗口即停止服务（也可以按 Ctrl+C）。');
    }
    // 重启不该打断演练：库里 status=open 的站点在这里重新起监听。
    // 授权过期/端口被占的站点起不来由 siteRegistry 内部处理并回写状态；返回 0 就一行都不打。
    const restored = restoreSites();
    if (restored) console.log(`已恢复 ${restored} 个演练站点监听`);
    // 保留期清理定时器：30 秒后首跑、之后每 6 小时一次，两个都 unref 不拖住退出。
    // retention_days<=0 时压根不注册，并在下面如实说一声：没配保留期必须让操作员看见，否则数据只增不减没人知道。
    const maintenance = startMaintenanceTimer();
    maintenanceHandle = maintenance;
    if (maintenance.started) {
      console.log(`数据保留期清理已启用（${config.exercise.retention_days} 天，每 6 小时巡检一次）`);
    } else {
      console.log(`数据保留期清理未启用：${maintenance.reason}（演练数据与采集到的口令会一直留存）`);
    }
  });

  // 端口被占是 exe 用户最常见的启动失败：双击第二次、或上次的窗口没关干净。给一句人话并留住窗口，
  // 不然控制台一闪而过，用户只看到"打不开"。源码部署仍按原样退出，保持 systemd/容器里快速失败。
  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    console.error(`\n端口 ${config.panel.port} 已被占用：可能在体检之后又被别的进程抢走了。`);
    // 体检已做过一次；这里是竞态兜底，仍然把占用者查出来，避免只给一句「被占用」
    for (const line of portOwnerLines(config.panel.port)) console.error(line);
    console.error('处理办法：结束上面那个进程，或改 config.yaml 的 panel.port。');
    if (process.env.AWARELAB_SEA === '1' && process.stdin.isTTY) {
      console.error('\n这个窗口先留着，按 Ctrl+C 或直接关闭即可退出。');
      // 不用 process.stdin.resume()：双击启动时有控制台 stdin 能挂住，但被计划任务/服务方式拉起时
      // stdin 可能是 NUL，resume 之后事件循环仍然空转退出，窗口一闪而过。定时器最稳。
      setInterval(() => {}, 1 << 30);
      return;
    }
    process.exit(1);
  });

  // 退出前先收掉采集面监听：残留端口会让下一次启动直接报冲突
  /**
   * 优雅停机，最终一定 process.exit(0)。
   * 顺序刻意：先 stopAllSites() 掀掉所有仿冒端口，再 server.close() 关主端口；反过来会留一堆钓鱼页公网可达没人能收。
   * 没做超时强杀：本进程没有必须等完的长任务，加超时只会把端口一定清干净变成可能没做完。
   */
  function shutdown(signal) {
    console.log(`\n收到 ${signal}，正在停止采集站点监听…`);
    // 先收清理定时器：它已 unref 不拖退出，但停机路径上不该留后台任务
    maintenanceHandle.stop();
    stopAllSites();
    // close 回调里才 exit：还有在途请求时立刻退出会把落库写到一半掐断
    server.close(() => process.exit(0));
  }

  // 两个信号分别对应 Ctrl+C（前台调试）与 systemd/docker stop（生产）；包一层箭头是为了把信号名传给 shutdown 打印
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch((error) => {
  console.error(`\n启动失败：${error.message}`);
  process.exit(1);
});

export { app, server };

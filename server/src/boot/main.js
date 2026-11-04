import express from 'express';
import { config, created, CONFIG_FILE } from '../platform/settings.js';
import { driver } from '../platform/storage/connection.js';
import { securityHeaders } from '../platform/net/securityHeaders.js';
import { mountBeaconPlane } from '../channels/beaconPlane.js';
import { mountAdminPlane } from '../channels/adminPlane.js';
import { restoreSites, stopAllSites } from '../capture/siteRegistry.js';

const BANNER = 'AwareLab 安全意识演练平台';

/** 管理面监听地址：缺本机，放开到别的网卡要操作员在配置里写明白 */
const PANEL_BIND = config.panel.bind || '127.0.0.1';

/**
 * 进程装配：一条端口上并行三个面。
 * 管理面走随机路径 + 会话，信标面公开无鉴权，采集面在每个授权端口上独立监听，
 * 三者的入口在同一个进程里，部署只需要开一个端口。
 */
const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '8mb' }));

mountBeaconPlane(app);
const panel = mountAdminPlane(app);

const server = app.listen(config.panel.port, PANEL_BIND, () => {
  console.log(BANNER);
  console.log('本工具仅可用于授权范围内的安全意识演练。');
  console.log(`数据库驱动: ${driver}`);
  if (created) console.log(`\n首次启动已生成配置文件: ${CONFIG_FILE}`);
  console.log(`\n管理后台: http://127.0.0.1:${config.panel.port}${panel}/`);
  // 口令只留在配置文件里：启动输出会被 journald / nohup.out / 容器日志collect，等于把口令复制一份到无人看管的地方
  console.log(`账号: ${config.panel.username}`);
  console.log('密码: 见 config.yaml 的 panel.password（登录成功后建议立即更换）');
  if (PANEL_BIND !== '127.0.0.1' && PANEL_BIND !== 'localhost') {
    console.log(`\n[警告] 管理面正监听 ${PANEL_BIND}：同一网络内任何终端都能到达后台，请确认确有需要。`);
  }
  console.log(`\n连通性自检: http://127.0.0.1:${config.panel.port}/alab/health`);
  const restored = restoreSites();
  if (restored) console.log(`已恢复 ${restored} 个演练站点监听`);
});

// 退出前先收掉采集面监听：残留端口会让下一次启动直接报冲突
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在停止采集站点监听…`);
  stopAllSites();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };

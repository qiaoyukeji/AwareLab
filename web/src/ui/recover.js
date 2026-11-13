/**
 * 运行期兜底面板：脚本已经跑起来、但渲染或懒加载 chunk 出错时用。
 * 与 index.html 里的静态兜底分工不同——那个管"入口脚本根本没执行"，这个管"执行了但中途炸了"。
 * 样式全部内联，不依赖 tokens.css（炸的那一刻样式表可能也没加载成功）。
 */
const PANEL_ID = 'alab-recover';

/** 把一段文本塞进节点，避免 innerHTML 拼接把异常信息里的尖括号当标签。 */
function text(tag, value, style) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (style) node.setAttribute('style', style);
  return node;
}

/**
 * 展示兜底面板。reason 是给操作员看的一句中文，detail 是原始异常（可空）。
 * 重复调用只更新文案，不会叠出第二块。
 */
export function showRecovery(reason, detail = '') {
  let box = document.getElementById(PANEL_ID);
  if (!box) {
    box = document.createElement('div');
    box.id = PANEL_ID;
    box.setAttribute(
      'style',
      [
        'position:fixed',
        'inset:0',
        'z-index:9999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px',
        'background:#f4f7f8',
        'font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif',
        'color:#24323d',
      ].join(';')
    );

    const card = document.createElement('div');
    card.setAttribute(
      'style',
      'max-width:560px;background:#fff;border:1px solid #dbe4ea;border-radius:10px;padding:26px 28px;box-shadow:0 12px 30px rgba(16,42,56,.08)'
    );
    card.appendChild(text('h1', '页面出了点问题', 'margin:0 0 10px;font-size:18px'));
    const body = text('p', '', 'margin:0 0 12px;font-size:13px;line-height:1.7;color:#4d5f6d');
    body.id = 'alab-recover-reason';
    card.appendChild(body);
    const pre = document.createElement('pre');
    pre.id = 'alab-recover-detail';
    pre.setAttribute(
      'style',
      'display:none;margin:0 0 12px;padding:10px 12px;background:#f6f8fa;border-radius:6px;font-size:12px;line-height:1.5;color:#5c6b7a;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto'
    );
    card.appendChild(pre);

    const actions = document.createElement('div');
    actions.setAttribute('style', 'display:flex;gap:10px;flex-wrap:wrap');
    const back = text('button', '回到首页', 'padding:7px 16px;border:1px solid #0f766e;border-radius:6px;background:#0f766e;color:#fff;font-size:13px;cursor:pointer');
    back.addEventListener('click', () => {
      // 先换 hash 再 reload：路由如果已经坏了，reload 会把坏状态原样带回来
      location.hash = '#/console';
      location.reload();
    });
    const logout = text('button', '重新登录', 'padding:7px 16px;border:1px solid #cfdae1;border-radius:6px;background:#fff;color:#24323d;font-size:13px;cursor:pointer');
    logout.addEventListener('click', () => {
      localStorage.removeItem('alab_token');
      localStorage.removeItem('alab_user');
      location.hash = '#/login';
      location.reload();
    });
    const reload = text('button', '刷新页面', 'padding:7px 16px;border:1px solid #cfdae1;border-radius:6px;background:#fff;color:#24323d;font-size:13px;cursor:pointer');
    reload.addEventListener('click', () => location.reload());
    actions.append(back, logout, reload);
    card.appendChild(actions);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  const reasonNode = document.getElementById('alab-recover-reason');
  if (reasonNode) reasonNode.textContent = reason || '页面渲染中断了。';
  const detailNode = document.getElementById('alab-recover-detail');
  if (detailNode) {
    if (detail) {
      detailNode.textContent = String(detail);
      detailNode.style.display = 'block';
    } else {
      detailNode.style.display = 'none';
    }
  }
}

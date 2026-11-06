/**
 * 站点地址的两种口径。
 *
 * 监听地址（listen_ip:listen_port）是平台真在 bind 的那个口，只有内网直连时才等于访客看到的地址。
 * 反代场景下外网是 https://phish.example.com → nginx → 127.0.0.1:8080，访客看到的是域名、没有端口，
 * 所以站点上单独存一个 public_url：邮件链接、跳转、像素、二维码、专属链接都按它拼，监听口只管收流量。
 */

/**
 * 把用户填的对外地址归一成 origin；容忍结尾斜杠，路径/参数一律拒绝。
 *
 * 协议必须写全 http:// 或 https://——这里刻意不"没写就补 https"：反代只有 80 明文的场景很常见，
 * 替用户猜协议会把 http 站点悄悄改成 https，链接到了浏览器里就是打不开的。
 */
export function normalizePublicUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    throw new Error('对外地址要写全协议：http://域名 或 https://域名（平台不替你猜协议）');
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('对外地址写法不对：只填 http://域名 或 https://域名（需要时带端口）');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('对外地址只能用 http:// 或 https://');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('对外地址只填到域名（含端口），不要带路径或参数');
  }
  // origin 会把 :443 / :80 这类默认端口吃掉，正好是反代场景想要的
  return url.origin;
}

/** 写库前的校验，返回中文错误串或 null；空值合法（表示按监听地址直连）。 */
export function publicUrlProblem(value) {
  if (value === undefined) return null;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    normalizePublicUrl(text);
    return null;
  } catch (error) {
    return error.message || '对外地址格式不正确';
  }
}

/**
 * 站点对外可访问的地址。配了 public_url 就用它（反代/域名），否则退回监听地址。
 * 返回值不带结尾斜杠；https 配 443、http 配 80 时不显示端口。
 */
export function siteUrl(site) {
  if (site?.public_url) {
    try {
      return normalizePublicUrl(site.public_url);
    } catch {
      // 库里的脏值不该让整个列表 500，退回监听地址并在界面上看得出来
    }
  }
  const proto = site.tls_cert && site.tls_key ? 'https' : 'http';
  const host = site.domain || (site.listen_ip === '0.0.0.0' ? '127.0.0.1' : site.listen_ip);
  const defaultPort = proto === 'https' ? 443 : 80;
  return `${proto}://${host}:${site.listen_port === defaultPort ? '' : site.listen_port}`.replace(/:$/, '');
}

/** 站点是否走反代（配了 public_url 且与监听地址不同源），界面用来提示口径。 */
export function behindProxy(site) {
  if (!site?.public_url) return false;
  try {
    return normalizePublicUrl(site.public_url) !== siteUrl({ ...site, public_url: null });
  } catch {
    return false;
  }
}

/** 监听口的人读形式，列表副行与提示用。 */
export function listenLabel(site) {
  const ip = site.listen_ip === '0.0.0.0' ? '0.0.0.0（全部网卡）' : site.listen_ip;
  return `${ip}:${site.listen_port}`;
}

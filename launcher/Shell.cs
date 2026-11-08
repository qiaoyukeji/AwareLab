// 主窗口：一个 WebView2 面板，把本地管理面当成本程序的界面来显示。
//
// 之所以不用系统浏览器：双击 exe 就弹出自己的窗口、任务栏里是自己的图标、关掉窗口就是退出程序，
// 这才像桌面软件。WebView2 用的是系统里已有的 Edge 内核，不需要额外装浏览器。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AwareLab
{
    internal sealed class Shell : Form
    {
        private readonly string url;
        private WebView2 view;
        private NotifyIcon tray;
        private Label hint;

        public Shell(string panelUrl)
        {
            url = panelUrl;

            Text = "AwareLab 安全意识演练平台";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1000, 680);
            Size = new Size(1360, 860);
            BackColor = Color.FromArgb(19, 27, 36);
            try
            {
                var ico = Path.Combine(Program.WorkDir, "app.ico");
                if (File.Exists(ico)) Icon = new Icon(ico);
            }
            catch { }

            hint = new Label
            {
                Text = "正在打开界面…",
                ForeColor = Color.FromArgb(200, 214, 224),
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 11f),
            };
            Controls.Add(hint);

            Shown += (sender, e) => { BeginInit(); };
            FormClosing += (sender, e) => { Program.StopServer(); };
            KeyPreview = true;
            KeyDown += (sender, e) =>
            {
                if (e.Control && e.KeyCode == Keys.R) Reload();
            };
        }

        private async void BeginInit()
        {
            try
            {
                var userData = Path.Combine(Program.HomeDir, "webview2");
                Directory.CreateDirectory(userData);
                var environment = await CoreWebView2Environment.CreateAsync(null, userData).ConfigureAwait(true);

                view = new WebView2 { Dock = DockStyle.Fill };
                Controls.Add(view);
                view.BringToFront();
                hint.Visible = false;

                await view.EnsureCoreWebView2Async(environment).ConfigureAwait(true);
                view.CoreWebView2.Settings.AreDevToolsEnabled =
                    Environment.GetEnvironmentVariable("AWARELAB_DEVTOOLS") == "1";
                view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                // 外链一律留在窗口里：这是内网工具，不该把用户甩到系统浏览器再回不来
                view.CoreWebView2.NewWindowRequested += (sender, e) =>
                {
                    e.Handled = true;
                    view.CoreWebView2.Navigate(e.Uri);
                };
                view.CoreWebView2.Navigate(url + "/");

                BuildTray();
            }
            catch (Exception error)
            {
                // 没有 WebView2 运行时（Win10 老版本可能没装）就退回系统浏览器，别让用户卡在黑屏
                MessageBox.Show(
                    "内置窗口打不开（缺少 WebView2 运行时）：" + error.Message +
                    "\n\n改为用系统浏览器打开，功能不受影响。",
                    "AwareLab", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                try { Process.Start(url + "/"); } catch { }
                Close();
            }
        }

        private void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("打开窗口", null, (sender, e) => Restore());
            menu.Items.Add("重新加载", null, (sender, e) => Reload());
            menu.Items.Add("打开数据目录", null, (sender, e) =>
            {
                try { Process.Start("explorer.exe", "\"" + Program.HomeDir + "\""); } catch { }
            });
            menu.Items.Add("复制后台地址", null, (sender, e) =>
            {
                try { Clipboard.SetText(url + "/"); } catch { }
            });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (sender, e) => Close());

            tray = new NotifyIcon
            {
                Icon = Icon ?? SystemIcons.Application,
                Text = "AwareLab 安全意识演练平台",
                Visible = true,
                ContextMenuStrip = menu,
            };
            tray.DoubleClick += (sender, e) => Restore();
        }

        private void Restore()
        {
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void Reload()
        {
            if (view != null && view.CoreWebView2 != null) view.CoreWebView2.Reload();
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (tray != null)
            {
                tray.Visible = false;
                tray.Dispose();
            }
            base.OnFormClosed(e);
        }
    }
}

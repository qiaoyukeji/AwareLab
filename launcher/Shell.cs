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
        // 点 X 先问一句：最小化还是真退出。quitting 用来区分"对话框选了退出"与"托盘里直接退出"
        private bool quitting;
        private bool balloonShown;

        public Shell(string panelUrl)
        {
            url = panelUrl;

            Text = "AwareLab 安全意识演练平台 " + BuildInfo.Version;
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
            FormClosing += OnClosing;
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
            menu.Items.Add("退出", null, (sender, e) => QuitNow());

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
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        /// <summary>点右上角 X 时先问一句，别让演练中途误关把监听一起收掉。</summary>
        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (quitting)
            {
                Program.StopServer();
                return;
            }
            // 关机、注销、程序自己退出时不弹框（也弹不出来）。
            // 注意：任务管理器「结束任务」和外部脚本发来的 WM_CLOSE 走的是 TaskManagerClosing，
            // 那也算用户主动关，照样要问一句。
            if (e.CloseReason == CloseReason.WindowsShutDown ||
                e.CloseReason == CloseReason.ApplicationExitCall ||
                e.CloseReason == CloseReason.MdiFormClosing)
            {
                quitting = true;
                Program.StopServer();
                return;
            }

            // 关键：不能在 FormClosing 里直接弹模态框——此时线程上已经排着一条 WM_QUIT，
            // 模态循环会立刻被打断，对话框一闪而过、窗口跟着关掉。
            // 先取消这次关闭，再回到消息循环里问，问完按选择决定。
            e.Cancel = true;
            BeginInvoke(new Action(AskThenAct));
        }

        private void AskThenAct()
        {
            CloseAction choice;
            try
            {
                choice = CloseAsk.Ask(this);
            }
            catch (Exception error)
            {
                Program.LogCrash("关窗确认", error);
                choice = CloseAction.Quit;
            }

            if (choice == CloseAction.Cancel) return;
            if (choice == CloseAction.Minimize)
            {
                HideToTray();
                return;
            }

            quitting = true;
            Program.StopServer();
            Close();
        }

        private void HideToTray()
        {
            Hide();
            if (!balloonShown && tray != null)
            {
                balloonShown = true;
                try
                {
                    tray.BalloonTipTitle = "AwareLab 还在运行";
                    tray.BalloonTipText = "已最小化到托盘。双击图标恢复窗口，右键菜单里可以退出。";
                    tray.ShowBalloonTip(3000);
                }
                catch { }
            }
        }

        private void QuitNow()
        {
            quitting = true;
            Close();
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

    internal enum CloseAction { Minimize, Quit, Cancel }

    /// <summary>
    /// 关窗前的三选一。用自绘对话框而不是 MessageBox：是要"最小化到托盘"和"直接退出"两个动作
    /// 都写得清楚，MessageBox 的"是/否"在这里太含糊。
    /// </summary>
    internal sealed class CloseAsk : Form
    {
        private CloseAction result = CloseAction.Cancel;

        private CloseAsk()
        {
            Text = "关闭 AwareLab";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(490, 212);
            BackColor = Color.White;
            Font = new Font("Microsoft YaHei UI", 9.5f);

            var title = new Label
            {
                Text = "要最小化到托盘，还是直接退出？",
                Font = new Font("Microsoft YaHei UI", 11.5f, FontStyle.Bold),
                Location = new Point(20, 18),
                AutoSize = true,
            };
            Controls.Add(title);

            var body = new Label
            {
                Text = "最小化：窗口收进托盘，程序继续运行，演练期间的站点仍然对目标开放。\n" +
                       "直接退出：停掉所有监听、结束服务端进程，这次演练就用到这里。",
                Location = new Point(22, 50),
                Size = new Size(446, 70),
                ForeColor = Color.FromArgb(64, 74, 84),
            };
            Controls.Add(body);

            var minimize = new Button
            {
                Text = "最小化到托盘",
                Location = new Point(148, 148),
                Size = new Size(134, 34),
                DialogResult = DialogResult.OK,
            };
            minimize.Click += (sender, e) => { result = CloseAction.Minimize; Close(); };
            Controls.Add(minimize);

            var quit = new Button
            {
                Text = "直接退出",
                Location = new Point(292, 148),
                Size = new Size(96, 34),
            };
            quit.Click += (sender, e) => { result = CloseAction.Quit; Close(); };
            Controls.Add(quit);

            var cancel = new Button
            {
                Text = "取消",
                Location = new Point(398, 148),
                Size = new Size(70, 34),
                DialogResult = DialogResult.Cancel,
            };
            Controls.Add(cancel);

            AcceptButton = minimize;
            CancelButton = cancel;
        }

        public static CloseAction Ask(IWin32Window owner)
        {
            using (var dialog = new CloseAsk())
            {
                dialog.ShowDialog(owner);
                return dialog.result;
            }
        }
    }
}

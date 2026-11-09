// AwareLab 桌面启动器（Windows / .NET Framework / WinForms + WebView2）
//
// 职责只有四件事：把内嵌的服务端解到用户目录、把它拉起来、等它报出管理面地址、用自带的窗口打开。
// 服务端仍是原来那份 Node SEA 程序（AwareLabServer.exe），这里不做任何业务逻辑。
//
// 为什么不用系统浏览器：双击 exe 就弹出自己的窗口、任务栏里有自己的图标，才像个桌面程序；
// 用 start 打开浏览器会在用户的浏览器里留一堆标签页，关掉还要自己去关。
//
// 命令行参数：
//   无参数          正常启动
//   --info <文件>   打印启动信息到控制台（由启动器以独立窗口拉起，用户关掉它不影响主程序）

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AwareLab
{
    internal static class Program
    {
        internal const string MutexName = @"Global\AwareLab.Desktop.v1";

        internal static string AppDir;
        internal static string WorkDir;   // 内嵌程序解包到这里（%LOCALAPPDATA%\AwareLab\app\<版本>）
        internal static string HomeDir;   // 数据目录：exe 同级的 AwareLab-data，不可写时退回 LOCALAPPDATA
        internal static Process Server;
        internal static IntPtr JobHandle = IntPtr.Zero;
        internal static string LogFile;

        [STAThread]
        private static void Main(string[] args)
        {
            AppDir = Path.GetDirectoryName(Application.ExecutablePath);
            HomeDir = ResolveHome();
            WorkDir = Path.Combine(LocalAppData(), "AwareLab", "app", BuildInfo.Version);
            LogFile = Path.Combine(HomeDir, "启动日志.txt");

            bool createdNew;
            using (var mutex = new Mutex(true, MutexName, out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "AwareLab 已经在运行了。\n\n到任务栏或右下角托盘里找它的窗口。",
                        "AwareLab", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                // 界面线程上的异常不该让进程一声不响地消失：写进启动日志，用户来问时能查到
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (sender, e) => LogCrash("界面线程", e.Exception);
                AppDomain.CurrentDomain.UnhandledException += (sender, e) => LogCrash("后台线程", e.ExceptionObject as Exception);

                try
                {
                    PrepareFiles();
                }
                catch (Exception error)
                {
                    MessageBox.Show("解包程序文件失败：" + error.Message + "\n\n可以试着删掉这个目录再打开：" + WorkDir,
                        "AwareLab", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                var splash = new SplashForm();
                splash.Show();
                Application.DoEvents();

                string url;
                try
                {
                    url = StartServer();
                }
                catch (Exception error)
                {
                    splash.Close();
                    MessageBox.Show(error.Message + "\n\n日志：" + LogFile,
                        "AwareLab 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                splash.Close();
                ShowInfoWindow(url);
                Application.Run(new Shell(url));
            }
        }

        // ---------- 目录与文件 ----------

        private static string LocalAppData()
        {
            var dir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(dir)) dir = Path.Combine(Path.GetTempPath(), "AwareLab");
            return dir;
        }

        /// <summary>
        /// 数据目录：显式设了 AWARELAB_HOME 就听它的（部署到共享盘、多份演练数据并存时用），
        /// 否则优先用 exe 同级的 AwareLab-data——拷走整个文件夹就能搬走演练数据。
        /// </summary>
        private static string ResolveHome()
        {
            var explicitHome = Environment.GetEnvironmentVariable("AWARELAB_HOME");
            if (!string.IsNullOrEmpty(explicitHome))
            {
                var full = Path.GetFullPath(explicitHome);
                Directory.CreateDirectory(full);
                return full;
            }

            var beside = Path.Combine(AppDir, "AwareLab-data");
            try
            {
                Directory.CreateDirectory(beside);
                var probe = Path.Combine(beside, ".write-test");
                File.WriteAllText(probe, "ok");
                File.Delete(probe);
                return beside;
            }
            catch
            {
                var fallback = Path.Combine(LocalAppData(), "AwareLab");
                Directory.CreateDirectory(fallback);
                return fallback;
            }
        }

        private static string AssemblyVersion()
        {
            try
            {
                var v = Assembly.GetExecutingAssembly().GetName().Version;
                return string.Format("{0}.{1}.{2}", v.Major, v.Minor, v.Build);
            }
            catch { return "dev"; }
        }

        /// <summary>把内嵌的服务端、WebView2 运行库和解包标记解到 WorkDir；版本没变就跳过。</summary>
        private static void PrepareFiles()
        {
            Directory.CreateDirectory(WorkDir);
            var marker = Path.Combine(WorkDir, ".unpacked");
            // 标记里必须带"这个 exe 是哪一次构建"的信息：只比版本号和长度的话，
            // 两次同版本、长度又碰巧相同的构建会互相顶替，界面还在跑上一份服务端。
            var self = new FileInfo(Application.ExecutablePath);
            var expected = BuildInfo.Version + "|" + self.Length + "|" + self.LastWriteTimeUtc.Ticks;

            if (File.Exists(marker) && File.ReadAllText(marker).Trim() == expected &&
                File.Exists(Path.Combine(WorkDir, "AwareLabServer.exe")))
            {
                SetDllDirectory(WorkDir);
                HookAssemblyResolve();
                return;
            }

            var assembly = Assembly.GetExecutingAssembly();
            foreach (var name in assembly.GetManifestResourceNames())
            {
                var target = Path.Combine(WorkDir, name);
                using (var input = assembly.GetManifestResourceStream(name))
                using (var output = File.Create(target))
                {
                    input.CopyTo(output);
                }
            }
            File.WriteAllText(marker, expected);

            SetDllDirectory(WorkDir);
            HookAssemblyResolve();
        }

        /// <summary>WebView2 的托管程序集不在 exe 旁边，运行时按需从 WorkDir 装回来。</summary>
        private static void HookAssemblyResolve()
        {
            AppDomain.CurrentDomain.AssemblyResolve += (sender, e) =>
            {
                var simple = new AssemblyName(e.Name).Name;
                var candidate = Path.Combine(WorkDir, simple + ".dll");
                return File.Exists(candidate) ? Assembly.LoadFrom(candidate) : null;
            };
        }

        // ---------- 服务端 ----------

        private static string StartServer()
        {
            var serverExe = Path.Combine(WorkDir, "AwareLabServer.exe");
            if (!File.Exists(serverExe))
                throw new InvalidOperationException("内嵌的服务端没有解出来：" + serverExe);

            var info = new ProcessStartInfo(serverExe)
            {
                WorkingDirectory = HomeDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            // 服务端自己会把数据写在 HOME 下；这里明确指过去，避免它按 exe 位置猜
            info.EnvironmentVariables["AWARELAB_HOME"] = HomeDir;
            info.EnvironmentVariables["AWARELAB_DATA"] = Path.Combine(HomeDir, "data");
            info.EnvironmentVariables["AWARELAB_CONFIG"] = Path.Combine(HomeDir, "config.yaml");
            // 由本进程负责开窗口，别让服务端再拉一次系统浏览器
            info.EnvironmentVariables["AWARELAB_NO_BROWSER"] = "1";

            var urlReady = new ManualResetEventSlim(false);
            string url = null;

            Server = new Process { StartInfo = info, EnableRaisingEvents = true };
            var logLock = new object();
            Action<string> appendLog = line =>
            {
                lock (logLock)
                {
                    try { File.AppendAllText(LogFile, line + Environment.NewLine, Encoding.UTF8); } catch { }
                }
            };
            File.WriteAllText(LogFile, "===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 =====\r\n", Encoding.UTF8);

            Server.OutputDataReceived += (sender, e) =>
            {
                if (e.Data == null) return;
                appendLog(e.Data);
                var m = Regex.Match(e.Data, @"管理后台:\s*(http://\S+)");
                if (m.Success)
                {
                    url = m.Groups[1].Value.TrimEnd('/');
                    urlReady.Set();
                }
            };
            Server.ErrorDataReceived += (sender, e) => { if (e.Data != null) appendLog("! " + e.Data); };

            Server.Start();
            KeepAliveWithLauncher(Server);
            Server.BeginOutputReadLine();
            Server.BeginErrorReadLine();

            var deadline = DateTime.UtcNow.AddSeconds(90);
            while (!urlReady.Wait(250))
            {
                if (Server.HasExited)
                {
                    var tail = TailLog(12);
                    throw new InvalidOperationException(
                        "服务端进程退出了（退出码 " + Server.ExitCode + "）。\n\n" + tail);
                }
                if (DateTime.UtcNow > deadline)
                    throw new InvalidOperationException("等了 90 秒还没报出管理面地址，可能端口被占或数据库打不开。\n\n" + TailLog(12));
            }
            return url;
        }

        private static string TailLog(int lines)
        {
            try
            {
                var all = File.ReadAllLines(LogFile, Encoding.UTF8);
                var start = Math.Max(0, all.Length - lines);
                var sb = new StringBuilder("日志末尾：\n");
                for (var i = start; i < all.Length; i++) sb.AppendLine(all[i]);
                return sb.ToString();
            }
            catch { return "（读不到日志）"; }
        }

        internal static void StopServer()
        {
            try
            {
                if (Server != null && !Server.HasExited)
                {
                    Server.Kill();
                    Server.WaitForExit(5000);
                }
            }
            catch { }
        }

        // 界面线程/后台线程没接住的异常写进启动日志，别让窗口一声不响地消失
        internal static void LogCrash(string where, Exception error)
        {
            if (error == null) return;
            try
            {
                var target = string.IsNullOrEmpty(LogFile)
                    ? Path.Combine(Path.GetTempPath(), "awarelab-crash.txt")
                    : LogFile;
                File.AppendAllText(target,
                    "===== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + where + "异常 =====\r\n" +
                    error + "\r\n", Encoding.UTF8);
            }
            catch { }
        }

        internal static void LogNote(string where, string text)
        {
            try
            {
                var target = string.IsNullOrEmpty(LogFile)
                    ? Path.Combine(Path.GetTempPath(), "awarelab-crash.txt")
                    : LogFile;
                File.AppendAllText(target,
                    "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + where + " " + text + "\r\n", Encoding.UTF8);
            }
            catch { }
        }

        // ---------- 启动信息窗口 ----------

        private static void ShowInfoWindow(string url)
        {
            try
            {
                var text = new StringBuilder();
                text.AppendLine("AwareLab 安全意识演练平台 " + BuildInfo.Version);
                text.AppendLine();
                text.AppendLine("管理后台: " + url + "/");
                text.AppendLine("账号: " + ReadPanelValue("username"));
                text.AppendLine("密码: " + ReadPanelValue("password") + "   （登录后建议立即修改）");
                text.AppendLine();
                text.AppendLine("数据目录: " + HomeDir);
                text.AppendLine("启动日志: " + LogFile);
                text.AppendLine();
                text.AppendLine("这个窗口只是把启动信息打出来，关掉它不影响程序运行。");
                text.AppendLine("退出程序请关闭主窗口，或用右下角托盘图标里的「退出」。");
                var infoFile = Path.Combine(HomeDir, "启动信息.txt");
                File.WriteAllText(infoFile, text.ToString(), Encoding.UTF8);

                var helper = Path.Combine(WorkDir, "AwareLabInfo.exe");
                if (!File.Exists(helper)) return;
                Process.Start(new ProcessStartInfo(helper, "\"" + infoFile + "\"") { UseShellExecute = true });
            }
            catch
            {
                // 信息窗口只是辅助，起不来不能拦住主程序
            }
        }

        /// <summary>从 config.yaml 的 panel 段里取一个字段；取不到就给一句人能看懂的话。</summary>
        internal static string ReadPanelValue(string key)
        {
            try
            {
                var configFile = Path.Combine(HomeDir, "config.yaml");
                if (!File.Exists(configFile)) return "（见 " + configFile + "）";
                var lines = File.ReadAllLines(configFile, Encoding.UTF8);
                var inPanel = false;
                foreach (var raw in lines)
                {
                    if (raw.TrimStart().StartsWith("panel:")) { inPanel = true; continue; }
                    if (!inPanel) continue;
                    if (raw.Length > 0 && !char.IsWhiteSpace(raw[0])) break;
                    var trimmed = raw.Trim();
                    if (!trimmed.StartsWith(key + ":")) continue;
                    var value = trimmed.Substring(key.Length + 1).Trim().Trim('"', '\'');
                    return string.IsNullOrEmpty(value) ? "（空）" : value;
                }
            }
            catch { }
            return "（读不到）";
        }

        // ---------- Win32 ----------

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern bool SetDllDirectory(string path);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x2000;

        /// <summary>
        /// 把服务端挂进作业对象：启动器不管是正常退出、崩溃还是被任务管理器杀掉，
        /// 服务端都会跟着结束，不会留下一个占着端口的僵尸进程。
        /// </summary>
        private static void KeepAliveWithLauncher(Process process)
        {
            try
            {
                JobHandle = CreateJobObject(IntPtr.Zero, null);
                var info = new JobObjectExtendedLimitInformation();
                info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                var length = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
                var buffer = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(info, buffer, false);
                    SetInformationJobObject(JobHandle, JobObjectExtendedLimitInformationClass, buffer, (uint)length);
                }
                finally { Marshal.FreeHGlobal(buffer); }
                AssignProcessToJobObject(JobHandle, process.Handle);
            }
            catch
            {
                // 挂不上作业对象只影响「启动器崩了会不会留下服务端」，不值得拦住启动
            }
        }
    }

    internal sealed class SplashForm : Form
    {
        public SplashForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(420, 120);
            BackColor = Color.FromArgb(19, 27, 36);
            ShowInTaskbar = true;
            var label = new Label
            {
                Text = "AwareLab 正在启动…",
                ForeColor = Color.FromArgb(226, 236, 242),
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 12f),
            };
            Controls.Add(label);
        }
    }
}

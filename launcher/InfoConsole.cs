// 启动信息小窗口：控制台程序，把启动器写好的那份说明打印出来，按任意键关闭。
//
// 单独做成一个 exe 是为了让"关掉它"和"关掉主程序"彻底无关：
// 它只是一个前台打印的进程，关了不会带走任何东西，也不会被主程序回收。

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace AwareLab
{
    internal static class InfoConsole
    {
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter,
            int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        private static extern bool MoveWindow(IntPtr hWnd, int x, int y, int cx, int cy, bool repaint);

        [DllImport("user32.dll")]
        private static extern int GetSystemMetrics(int index);

        private const uint SwpNoZOrder = 0x0004;
        private const uint SwpShowWindow = 0x0040;

        private static void Main(string[] args)
        {
            Run(args.Length > 0 ? args[0] : "");
        }

        public static void Run(string file)
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
            }
            catch { }

            Console.Title = "AwareLab 启动信息";
            try
            {
                Console.WriteLine(File.ReadAllText(file, Encoding.UTF8));
            }
            catch (Exception error)
            {
                Console.WriteLine("读不到启动信息：" + error.Message);
            }
            Console.WriteLine();
            Console.WriteLine("按任意键关闭这个窗口（不影响程序运行）。");
            // 打印完再摆位置：窗口尺寸在输出过程中会被控制台自己改回去
            PlaceWindow();
            try { Console.ReadKey(true); } catch { }
        }

        // 默认的控制台窗口又大又居中，正好压在程序窗口上。缩到屏幕左下角一块，
        // 只占 760x400，用户扫一眼就能关掉。
        private static void PlaceWindow()
        {
            var handle = GetConsoleWindow();
            if (handle == IntPtr.Zero) return;

            var screenWidth = GetSystemMetrics(0);   // SM_CXSCREEN
            var screenHeight = GetSystemMetrics(1);  // SM_CYSCREEN
            if (screenWidth <= 0 || screenHeight <= 0) return;

            var width = Math.Min(760, screenWidth - 120);
            var height = Math.Min(400, screenHeight - 160);
            var x = 40;
            var y = screenHeight - height - 90;      // 让开任务栏

            // 先挪窗口：控制台 API 在缩放 150% 的屏幕上容易抛异常，不能挡在前面
            MoveWindow(handle, x, y, width, height, true);
            SetWindowPos(handle, IntPtr.Zero, x, y, width, height, SwpNoZOrder | SwpShowWindow);

            try
            {
                if (Console.BufferWidth < 100) Console.SetBufferSize(100, Math.Max(Console.BufferHeight, 300));
            }
            catch { }
        }
    }
}

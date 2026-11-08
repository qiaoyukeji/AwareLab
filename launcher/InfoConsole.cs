// 启动信息小窗口：控制台程序，把启动器写好的那份说明打印出来，按任意键关闭。
//
// 单独做成一个 exe 是为了让"关掉它"和"关掉主程序"彻底无关：
// 它只是一个前台打印的进程，关了不会带走任何东西，也不会被主程序回收。

using System;
using System.IO;
using System.Text;

namespace AwareLab
{
    internal static class InfoConsole
    {
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
            try { Console.ReadKey(true); } catch { }
        }
    }
}

using System;
using System.IO;
using System.Windows;

namespace Orbit.Host;
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        DispatcherUnhandledException += (_, args) => {
            MessageBox.Show(args.Exception.Message, "Orbit", MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        base.OnStartup(e);
    }
}

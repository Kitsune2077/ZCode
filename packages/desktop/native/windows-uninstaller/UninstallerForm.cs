using System;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace ZCode.Uninstaller
{
    internal sealed class UninstallerForm : Form
    {
        private readonly InstallContext context;
        private readonly CommandLineOptions options;
        private readonly UninstallerLog log;
        private readonly CheckBox deleteDataCheck;
        private readonly ProgressBar progressBar;
        private readonly Label statusLabel;
        private readonly Button uninstallButton;
        private readonly Button cancelButton;
        private bool running;

        public UninstallerForm(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log)
        {
            this.context = context;
            this.options = options;
            this.log = log;
            ExitCode = 1;

            Text = Strings.AppTitle;
            ClientSize = new Size(580, 335);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            MaximizeBox = false;
            MinimizeBox = false;
            AutoScaleMode = AutoScaleMode.Dpi;

            var title = new Label
            {
                Text = context.ProductName + (Strings.ZhText(" 卸载程序", " uninstaller")),
                Location = new Point(20, 18),
                AutoSize = true,
                Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
            };
            Controls.Add(title);

            var description = new Label
            {
                Text = Strings.FormDescription(context.ProductName),
                Location = new Point(20, 55),
                Size = new Size(540, 40),
            };
            Controls.Add(description);

            deleteDataCheck = new CheckBox
            {
                Text = Strings.DeleteDataLabel,
                Location = new Point(20, 108),
                Size = new Size(540, 24),
                Checked = options.DeleteUserData,
            };
            Controls.Add(deleteDataCheck);

            var warning = new Label
            {
                Text = Strings.DeleteDataWarning,
                Location = new Point(20, 137),
                Size = new Size(540, 48),
                ForeColor = Color.DarkRed,
            };
            Controls.Add(warning);

            progressBar = new ProgressBar
            {
                Location = new Point(20, 200),
                Size = new Size(540, 18),
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 0,
            };
            Controls.Add(progressBar);

            statusLabel = new Label
            {
                Text = Strings.StatusReady,
                Location = new Point(20, 225),
                Size = new Size(540, 40),
            };
            Controls.Add(statusLabel);

            uninstallButton = new Button
            {
                Text = Strings.UninstallButton,
                Location = new Point(360, 285),
                Size = new Size(95, 30),
            };
            uninstallButton.Click += (_, __) => StartCleanup(false);
            Controls.Add(uninstallButton);

            cancelButton = new Button
            {
                Text = Strings.CancelButton,
                Location = new Point(465, 285),
                Size = new Size(95, 30),
            };
            cancelButton.Click += (_, __) =>
            {
                if (!running)
                {
                    Close();
                }
            };
            Controls.Add(cancelButton);

            AcceptButton = uninstallButton;
            CancelButton = cancelButton;
            FormClosing += OnFormClosing;
        }

        public int ExitCode { get; private set; }

        private void StartCleanup(bool skipConfirmation)
        {
            if (running)
            {
                return;
            }

            if (!skipConfirmation)
            {
                DialogResult confirmation = MessageBox.Show(
                    Strings.ConfirmText(context.ProductName),
                    Strings.AppTitle,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (confirmation != DialogResult.Yes)
                {
                    return;
                }
            }

            options.DeleteUserData = deleteDataCheck.Checked;
            running = true;
            uninstallButton.Enabled = false;
            cancelButton.Enabled = false;
            deleteDataCheck.Enabled = false;
            progressBar.MarqueeAnimationSpeed = 30;
            statusLabel.Text = Strings.StatusRunning;

            var progress = new Progress<string>(text =>
            {
                if (!IsDisposed)
                {
                    statusLabel.Text = text;
                }
            });

            Task.Run(() => UninstallRunner.Run(context, options, log, progress, false))
                .ContinueWith(
                    task => OnCleanupCompleted(task),
                    TaskScheduler.FromCurrentSynchronizationContext());
        }

        private void OnCleanupCompleted(Task<UninstallResult> task)
        {
            running = false;
            progressBar.MarqueeAnimationSpeed = 0;

            if (task.IsFaulted)
            {
                Exception exception = task.Exception == null
                    ? new InvalidOperationException("unknown uninstall failure")
                    : task.Exception.GetBaseException();

                if (exception is EmbeddedDataException embedded)
                {
                    string paths = string.Join(Environment.NewLine, embedded.Paths);
                    DialogResult answer = MessageBox.Show(
                        Strings.EmbeddedDataPrompt(paths),
                        Strings.EmbeddedDataTitle,
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Warning);
                    if (answer == DialogResult.Yes)
                    {
                        options.Force = true;
                        StartCleanup(true);
                        return;
                    }

                    ExitCode = 2;
                    FinishUi(Strings.DoneWithErrors);
                    return;
                }

                if (exception is UninstallBlockedException blocked)
                {
                    string paths = string.Join(Environment.NewLine, blocked.Paths);
                    log.Write("cleanup-failed reason=process-still-running");
                    MessageBox.Show(
                        blocked.Message + Environment.NewLine + Environment.NewLine + paths +
                        Environment.NewLine + Environment.NewLine + Strings.LogPathLabel + log.LogPath,
                        Strings.AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                    ExitCode = 2;
                    FinishUi(Strings.DoneWithErrors);
                    return;
                }

                log.Write("custom-uninstaller-failed reason=unexpected-error message=" + exception.Message);
                MessageBox.Show(
                    Strings.UnexpectedError(exception.Message) + Environment.NewLine +
                    Environment.NewLine + Strings.LogPathLabel + log.LogPath,
                    Strings.AppTitle,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                ExitCode = 2;
                FinishUi(Strings.DoneWithErrors);
                return;
            }

            UninstallResult result = task.Result;
            ExitCode = result.ExitCode;
            MessageBox.Show(
                result.Message,
                Strings.AppTitle,
                MessageBoxButtons.OK,
                result.Success ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            FinishUi(result.Success ? Strings.Done : Strings.DoneWithErrors);
        }

        private void FinishUi(string status)
        {
            statusLabel.Text = status;
            uninstallButton.Enabled = false;
            deleteDataCheck.Enabled = false;
            cancelButton.Text = Strings.CloseButton;
            cancelButton.Enabled = true;
            AcceptButton = cancelButton;
        }

        private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
        {
            if (running)
            {
                eventArgs.Cancel = true;
            }
        }
    }
}

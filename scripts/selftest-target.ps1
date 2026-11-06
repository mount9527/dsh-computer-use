# dsh-computer-use - self-test target
#
# A throwaway WinForms window that NEVER touches your files or accounts. It exists so the
# input pipeline (activate / click / type) can be verified after any change to desk.ps1:
#
#   1) computer_app action=launch exe=powershell.exe
#        args=["-NoProfile","-ExecutionPolicy","Bypass","-File",<this file>,"-Out",<temp>\cu-selftest]
#   2) computer_input actions=[{type:"activate",h:"0x..."},{type:"click",x,y,expectH:"0x..."}]
#   3) read <temp>\cu-selftest.tbclick   -> proves the click reached the TextBox
#      read <temp>\cu-selftest.txt       -> proves injected keystrokes arrived
#
# It self-closes after 90 seconds. ASCII-only on purpose (PS 5.1 reads BOM-less files as ANSI).
param([string]$Out = (Join-Path $env:TEMP 'cu-selftest'))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

if (-not ('CuSelfTest' -as [type])) {
  Add-Type -Namespace CuSelfTest -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
'@
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsh-computer-use self-test target'
$form.Size = New-Object System.Drawing.Size 580, 320
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.Font = New-Object System.Drawing.Font('Consolas', 11)
$tb.Location = New-Object System.Drawing.Point 18, 18
$tb.Size = New-Object System.Drawing.Size 525, 150
$tb.Add_Click({ [System.IO.File]::WriteAllText($Out + '.tbclick', 'textbox-clicked', $utf8) })
$tb.Add_GotFocus({ [System.IO.File]::WriteAllText($Out + '.tbfocus', 'textbox-focused', $utf8) })
$form.Controls.Add($tb)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'close target'
$btn.Location = New-Object System.Drawing.Point 18, 185
$btn.Size = New-Object System.Drawing.Size 150, 38
$btn.Add_Click({
  [System.IO.File]::WriteAllText($Out + '.clicked', 'button-clicked', $utf8)
  $form.Close()
})
$form.Controls.Add($btn)

# A child started from a hidden helper inherits SW_HIDE; force our own window visible.
$form.Add_Shown({
  $h = $form.Handle
  [void][CuSelfTest.Win]::ShowWindow($h, 9)
  [void][CuSelfTest.Win]::BringWindowToTop($h)
  [void][CuSelfTest.Win]::SetForegroundWindow($h)
  [System.IO.File]::WriteAllText($Out + '.hwnd', ('0x{0:x}' -f $h.ToInt64()), $utf8)
})

$mirror = New-Object System.Windows.Forms.Timer
$mirror.Interval = 250
$mirror.Add_Tick({ [System.IO.File]::WriteAllText($Out + '.txt', $tb.Text, $utf8) })
$mirror.Start()

$deadline = New-Object System.Windows.Forms.Timer
$deadline.Interval = 90000
$deadline.Add_Tick({ $form.Close() })
$deadline.Start()

[void][System.Windows.Forms.Application]::Run($form)

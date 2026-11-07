# 发布到 npm（维护者用，不进发布包）
#
# 为什么需要这个脚本：本机没装 npm，只有 DSH 自带的 pnpm（通过 node 调用）；
# 而且发布要在**宿主侧**跑（沙箱没有外网）。这个脚本把两件事包掉：
# 找到 node/pnpm、在 release/pkg 里执行 publish，并把结果写到 contrib/publish.log。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File contrib\publish-npm.ps1 -Check
#   powershell -NoProfile -ExecutionPolicy Bypass -File contrib\publish-npm.ps1
param(
  [switch]$Check,          # 只检查登录状态与包内容，不发布
  [string]$Node = '',
  [string]$Pnpm = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$pkgDir = Join-Path $repoRoot 'release\pkg'
$log = Join-Path $PSScriptRoot 'publish.log'

function Resolve-Node {
  if ($Node) { return $Node }
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $candidate = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $candidate) { return $candidate }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '找不到 node.exe：用 -Node 指定路径'
}

function Resolve-Pnpm([string]$nodeExe) {
  if ($Pnpm) { return $Pnpm }
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  $candidate = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  if (Test-Path $candidate) { return $candidate }
  throw '找不到 pnpm.mjs：用 -Pnpm 指定路径'
}

$nodeExe = Resolve-Node
$pnpmMjs = Resolve-Pnpm $nodeExe

if (-not (Test-Path $pkgDir)) {
  throw "发布包不存在：$pkgDir　先运行 node scripts/stage-release.mjs"
}

$lines = New-Object System.Collections.Generic.List[string]
function Log([string]$s) { Write-Host $s; $lines.Add($s) }

Log "node  = $nodeExe"
Log "pnpm  = $pnpmMjs"
Log "包目录 = $pkgDir"

# 包身份
$manifest = [System.IO.File]::ReadAllText((Join-Path $pkgDir 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Log "包名   = $($manifest.name)"
Log "版本   = $($manifest.version)"
if (-not $manifest.dsh -or -not $manifest.dsh.bundle) { throw '缺少 dsh.bundle，市场装不上' }

# 登录状态
$who = (& $nodeExe $pnpmMjs whoami 2>&1) | Out-String
Log "登录检查: $($who.Trim())"
if ($who -match 'UNAUTHORIZED|not logged in') {
  Log ''
  Log '还没登录。先在**你自己的终端**里执行（浏览器授权 + 2FA 必须你本人完成）：'
  Log "  & '$nodeExe' '$pnpmMjs' login --scope @mount9527"
  Log '登录成功后 .npmrc 里会有 token，再回来跑本脚本即可。'
  [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
  exit 2
}

if ($Check) {
  Log ''
  Log '包内容预演：'
  $packOut = (& $nodeExe $pnpmMjs pack --dry-run 2>&1) | Out-String
  $lines.Add($packOut)
  Write-Host $packOut
  Log '（-Check 模式，未发布）'
  [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
  exit 0
}

Log ''
Log '开始发布…'
Push-Location $pkgDir
try {
  $out = (& $nodeExe $pnpmMjs publish --access public --no-git-checks 2>&1) | Out-String
  Log $out
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
[System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false)))
Log "退出码: $code　日志: $log"
exit $code

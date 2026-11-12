# OpenScreen — launch the development build, rebuilding first if the source moved.
#
# The desktop shortcut points at `node_modules\electron\dist\electron.exe`, which runs
# `dist-electron\main.js` + `dist\index.html` — static files from the last vite build. Editing a
# .ts/.tsx and launching that shortcut shows the OLD code, silently, and that has cost real time
# ("I fixed it, why is it unchanged?").
#
# So: compare the newest source file against the build outputs, rebuild only when the source is
# newer, then launch. Roughly 40 s when it rebuilds, instant when it does not.
#
#   .\OpenScreen-Dev.ps1              # rebuild if stale, then launch
#   .\OpenScreen-Dev.ps1 -Force       # always rebuild
#   .\OpenScreen-Dev.ps1 -Check       # report staleness only, launch nothing
#   .\OpenScreen-Dev.ps1 -BuildOnly   # rebuild if needed, do not launch

param(
    [switch]$Force,
    [switch]$Check,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$appEntry = Join-Path $root 'dist-electron\main.js'
$pageEntry = Join-Path $root 'dist\index.html'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath $electron)) {
    Write-Host "electron.exe missing — run npm install first." -ForegroundColor Red
    exit 1
}

# The newest source timestamp. Only .ts/.tsx under src\ and electron\ affect the build; docs,
# workflows and tests do not, and including them would trigger a needless rebuild on every
# markdown edit.
$srcRoots = @((Join-Path $root 'src'), (Join-Path $root 'electron'))
$newestSource = Get-ChildItem -Path $srcRoots -Recurse -File -Include *.ts, *.tsx -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

# The renderer and the main bundle are built by two separate vite runs, and either can fail
# while the other succeeds. "newest of the two" would then call a half-built tree current, so
# take the OLDEST: the build is only as fresh as its stalest half.
$builtStamps = @()
foreach ($p in @($pageEntry, $appEntry)) {
    if (Test-Path -LiteralPath $p) { $builtStamps += (Get-Item -LiteralPath $p).LastWriteTime }
}
$built = $null
if ($builtStamps.Count -gt 0) {
    $built = ($builtStamps | Sort-Object)[0]
}

if ($builtStamps.Count -lt 2) {
    $stale = $true
    $reason = 'missing build output (renderer or main)'
} elseif (-not $newestSource) {
    $stale = $false
    $reason = 'no source files found'
} elseif ($newestSource.LastWriteTime -gt $built) {
    $stale = $true
    $reason = "newest source is $($newestSource.LastWriteTime.ToString('HH:mm:ss')) ($($newestSource.Name)), oldest output is $($built.ToString('HH:mm:ss'))"
} else {
    $stale = $false
    $reason = "both outputs newer than source (oldest $($built.ToString('HH:mm:ss')))"
}

$srcStamp = 'none'
if ($newestSource) { $srcStamp = $newestSource.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') }
$builtStamp = 'never'
if ($built) { $builtStamp = $built.ToString('yyyy-MM-dd HH:mm:ss') }
$stateText = 'current'
if ($stale) { $stateText = 'STALE - will rebuild' }

Write-Host "Sources : $srcStamp"
Write-Host "Built   : $builtStamp"
Write-Host "State   : $stateText"
Write-Host "Reason  : $reason"

if ($Check) {
    if ($stale) { exit 2 } else { exit 0 }
}

if ($stale -or $Force) {
    Write-Host ''
    Write-Host 'Rebuilding (tsc + vite)...' -ForegroundColor Cyan
    Push-Location $root
    # Native commands write progress to stderr (browserslist notices, vite warnings), and 'Stop'
    # turns the first of those into a terminating error that aborts a perfectly good build.
    # Judge them by exit code instead.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # Two steps, not `npm run build`: that one ends in electron-builder and spends minutes
        # producing an installer nobody asked for at launch time.
        & npx tsc
        $tscExit = $LASTEXITCODE
        if ($tscExit -ne 0) { Write-Host "tsc failed (exit $tscExit) - not launching." -ForegroundColor Red; exit 1 }

        # --emptyOutDir false: emptying dist/assets (200+ files) trips the bulk-delete guard and
        # fails the build halfway, leaving dist-electron current while dist stays stale.
        & npx vite build --emptyOutDir false
        $viteExit = $LASTEXITCODE
        if ($viteExit -ne 0) { Write-Host "vite build failed (exit $viteExit) - not launching." -ForegroundColor Red; exit 1 }
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }
    Write-Host 'Rebuilt.' -ForegroundColor Green
}

if ($BuildOnly) {
    Write-Host ''
    Write-Host 'BuildOnly: not launching.' -ForegroundColor Yellow
    exit 0
}

Write-Host ''
Write-Host 'Launching...' -ForegroundColor Cyan
# Same working directory and flags as the desktop shortcut: `electron .` resolves main from
# package.json, and the GPU flags keep the software path the pixel measurements were taken on.
$electronArgs = @('.', '--disable-gpu-sandbox', '--disable-gpu-compositing')
Start-Process -FilePath $electron -ArgumentList $electronArgs -WorkingDirectory $root

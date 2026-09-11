#Requires -Version 5.1
<#
.SYNOPSIS
    安装 dsh-md-reader 到本机 DSH（DeepSeek Harness）的 web profile。

.DESCRIPTION
    - 把插件文件复制到 %DSH_HOME%\profiles\web\plugins\dsh-md-reader；
    - 幂等地向 profiles\web\cordis.patch.yml 追加 insert 片段（已装过则跳过）；
    - 不修改 DSH 安装目录，不重启任何进程。

.PARAMETER DshHome
    DSH 主目录，默认 %USERPROFILE%\.dsh。

.EXAMPLE
    ./install.ps1
    ./install.ps1 -DshHome "D:\dsh-home"
#>
param(
    [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $DshHome 'profiles\web'
$pluginsDir = Join-Path $profileDir 'plugins'
$dest = Join-Path $pluginsDir 'dsh-md-reader'
$patch = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path $profileDir)) {
    throw "未找到 DSH web profile：$profileDir（请确认 DSH 已安装并至少启动过一次）"
}

# 1) 复制插件文件
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'lib\index.js') (Join-Path $dest 'lib\index.js') -Force
Copy-Item (Join-Path $PSScriptRoot 'lib\client.js') (Join-Path $dest 'lib\client.js') -Force
Copy-Item (Join-Path $PSScriptRoot 'package.json') (Join-Path $dest 'package.json') -Force
Write-Host "[1/2] 插件文件已复制到 $dest"

# 2) 追加 cordis.patch.yml 的 insert 片段（幂等）
$block = "- insert:`r`n    - id: md-reader`r`n      name: ./plugins/dsh-md-reader/lib/index.js"
if (Test-Path $patch) {
    $content = [System.IO.File]::ReadAllText($patch)
    if ($content -match 'md-reader') {
        Write-Host "[2/2] cordis.patch.yml 已包含 md-reader，跳过"
    } else {
        if ($content -notmatch '\r?\n$') { $content += "`r`n" }
        $content += $block + "`r`n"
        [System.IO.File]::WriteAllText($patch, $content, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[2/2] 已追加 cordis.patch.yml 片段"
    }
} else {
    [System.IO.File]::WriteAllText($patch, $block + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[2/2] 已创建 cordis.patch.yml"
}

Write-Host ''
Write-Host '安装完成。生效方式（二选一）：'
Write-Host '  - DSH 正在运行且 web profile patchReload 为 live：刷新浏览器页面即可；'
Write-Host '  - 否则：重启 DSH 后刷新浏览器页面。'
Write-Host '在会话中点击任意 .md 文件链接即可在右侧三栏布局中阅读。'

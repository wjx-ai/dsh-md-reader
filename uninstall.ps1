#Requires -Version 5.1
<#
.SYNOPSIS
    从本机 DSH web profile 卸载 dsh-md-reader。
#>
param(
    [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $DshHome 'profiles\web'
$dest = Join-Path $profileDir 'plugins\dsh-md-reader'
$patch = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path $dest) {
    Remove-Item $dest -Recurse -Force
    Write-Host "[1/2] 已删除 $dest"
} else {
    Write-Host "[1/2] 插件目录不存在，跳过"
}

if (Test-Path $patch) {
    $content = [System.IO.File]::ReadAllText($patch)
    # 逐行剔除 md-reader 的 insert 块（连同其引导行 "- insert:"）
    $lines = [System.IO.File]::ReadAllLines($patch)
    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match '^\s*- id:\s*md-reader\s*$') {
            # 回溯去掉紧邻的 "- insert:" 引导行
            while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*- insert:\s*$') { $out.RemoveAt($out.Count - 1) }
            $i++ # 跳过 name 行
            continue
        }
        $out.Add($lines[$i])
    }
    [System.IO.File]::WriteAllText($patch, ($out -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "[2/2] 已从 cordis.patch.yml 移除 md-reader 片段"
} else {
    Write-Host "[2/2] cordis.patch.yml 不存在，跳过"
}

Write-Host ''
Write-Host '卸载完成。刷新浏览器页面即可；若 patchReload 非 live，请重启 DSH。'

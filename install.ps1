<#
.SYNOPSIS
  把 dsh-hermes-cron 挂进 DSH profile（默认 desktop）。
.DESCRIPTION
  只改 profile 的 package.json 两处：
    1. dependencies 加 "dsh-hermes-cron": "link:<本目录绝对路径>"
    2. dsh.profile.bundles 追加 "dsh-hermes-cron"
  默认演练（只打印），-Apply 才写盘，写前自动备份。
  写完必须在 profile 目录跑 pnpm install，再重启 DSH。
.EXAMPLE
  .\install.ps1
  .\install.ps1 -Apply
  .\install.ps1 -Apply -Remove
#>
param(
  [switch]$Apply,
  [switch]$Remove,
  [string]$Profile = "desktop",
  [string]$PluginPath = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$name = "dsh-hermes-cron"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$manifest = Join-Path $profileDir "package.json"
$pluginManifest = Join-Path $PluginPath "package.json"

if (-not (Test-Path $pluginManifest)) { throw "插件清单不存在：$pluginManifest" }
if (-not (Test-Path $manifest)) { throw "profile 清单不存在：$manifest" }
foreach ($f in @("client.js", "lib\index.js", "cordis.patch.yml")) {
  if (-not (Test-Path (Join-Path $PluginPath $f))) { throw "插件缺文件：$f" }
}

$abs = (Resolve-Path $PluginPath).Path.Replace("\", "/")
$linkSpec = "link:$abs"
$pkg = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json

$hasDep = $null -ne $pkg.dependencies.$name
$bundles = @()
if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
$hasBundle = $bundles -contains $name

Write-Host "profile : $profileDir"
Write-Host "plugin  : $abs"
Write-Host "当前     : dependency=$hasDep bundle=$hasBundle"

if ($Remove) {
  if (-not ($hasDep -or $hasBundle)) { Write-Host "本来就沒装，无需移除。"; return }
  if (-not $Apply) { Write-Host "[演练] 将移除依赖与 bundles 条目；加 -Apply 执行。"; return }
  Copy-Item -LiteralPath $manifest -Destination "$manifest.bak-hermescron-$(Get-Date -Format yyyyMMddHHmmss)" -Force
  if ($hasDep) { $pkg.dependencies.PSObject.Properties.Remove($name) }
  $pkg.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $name })
  ($pkg | ConvertTo-Json -Depth 32) | Set-Content -LiteralPath $manifest -Encoding utf8
Write-Host ('  1) cd "{0}"; pnpm install' -f $profileDir)
  return
}

if ($hasDep -and $hasBundle) { Write-Host "已经装过，无需改动。插件代码改过只需重启 DSH。"; return }
if (-not $Apply) {
  Write-Host "[演练] 将改动："
  Write-Host ('  dependencies += "{0}": "{1}"' -f $name, $linkSpec)
  Write-Host ('  dsh.profile.bundles += "{0}"' -f $name)
  Write-Host "加 -Apply 执行。"
  return
}

Copy-Item -LiteralPath $manifest -Destination "$manifest.bak-hermescron-$(Get-Date -Format yyyyMMddHHmmss)" -Force
if (-not $hasDep) { $pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $linkSpec -Force }
if (-not $hasBundle) { $pkg.dsh.profile.bundles = @($bundles + $name) }
($pkg | ConvertTo-Json -Depth 32) | Set-Content -LiteralPath $manifest -Encoding utf8
Write-Host "已写入 $manifest"
Write-Host ""
Write-Host "下一步（缺一不可）："
Write-Host ('  1) cd "{0}"; pnpm install' -f $profileDir)
Write-Host "  2) 重启 DSH（桌面端退出重开）"
Write-Host "  3) 侧栏应出现「定时任务」"

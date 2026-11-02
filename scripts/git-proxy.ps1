# 根据本机代理端口是否在监听，自动设置/清除 git 的 HTTP 代理。
#
# 用法：
#   pwsh -File scripts/git-proxy.ps1
#
# 逻辑：
#   · 检测常见代理端口（7897 Clash / 7890 Clash 旧版 / 10809 v2ray / 1080 socks）
#     有任何一个在监听 → 给 git 配上
#   · 一个都没有 → 清掉 git 代理（避免连不上还把请求全卡在死端口上）
#
# 为什么需要这个：git 默认**不读** Windows 系统代理，而国内直连 github.com:443
# 会超时。所以要么手动配、要么每次开关代理都忘一次 —— 这个脚本负责记住。

$ErrorActionPreference = 'Stop'

# 常见代理端口，按优先级排
$candidates = @(
  @{ port = 7897;  name = 'Clash Verge / Mihomo' },
  @{ port = 7890;  name = 'Clash' },
  @{ port = 10809; name = 'v2rayN' },
  @{ port = 1080;  name = '通用 SOCKS' }
)

function Test-Port {
  param([int]$port)
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return $null -ne $c
  } catch {
    return $false
  }
}

$found = $null
foreach ($c in $candidates) {
  if (Test-Port $c.port) { $found = $c; break }
}

if ($found) {
  $url = "http://127.0.0.1:$($found.port)"
  git config --global http.proxy $url
  git config --global https.proxy $url
  Write-Host "✓ 检测到代理：$($found.name)（$url）"
  Write-Host "  已设置 git 全局代理。"
} else {
  git config --global --unset http.proxy 2>$null
  git config --global --unset https.proxy 2>$null
  Write-Host "· 没检测到代理端口（试过 7897/7890/10809/1080）"
  Write-Host "  已清除 git 代理配置。"
  Write-Host ""
  Write-Host "  注意：国内直连 github.com:443 通常是不通的 ——"
  Write-Host "  要推 GitHub 还是得先开代理。"
}

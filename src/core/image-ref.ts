/**
 * 图片引用判断：这条引用是不是本机文件路径（而不是 URL / base64）。
 *
 * 以前这段逻辑有两份，判断还不一致：
 *   - channel/onebot.ts 里的完整版（认 file://、盘符、UNC、POSIX、相对路径）
 *   - llm/vision.ts 里的简化版（只认盘符、file://、以 / 开头）
 * 后果是同一张图在两个地方被判成不同性质：UNC 路径（\\server\share\x.png）
 * 在 vision 里被当成 URL 去下载，当然下载不到；相对路径也一样。
 *
 * OneBot 的 image 段里 `file` 大多数时候只是个文件名（`a1b2c3.jpg`），
 * 那拼不出能读的路径，只能靠 `url`；但 NapCat 在本地缓存/下载过之后
 * 会给绝对路径（`C:\...\nt_temp\x.jpg`、`/root/.../x.png`、`file:///...`），
 * 这种能直接读，而且不像 QQ 的临时链接那样两小时就过期。
 */
export function isLocalImageRef(ref: string): boolean {
  const v = String(ref ?? '').trim()
  if (!v) return false
  if (/^file:\/\//i.test(v)) return true
  // Windows 盘符要先判，不然会被当成 `c:` 这种 scheme
  if (/^[a-zA-Z]:[\\/]/.test(v)) return true
  // 其它带 scheme 的（http/ftp/base64/data…）不归本地读管
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false
  if (v.startsWith('\\\\')) return true // UNC 路径
  if (v.startsWith('/')) return true // POSIX 绝对路径
  return /[\\/]/.test(v) // ./a.png、cache/a.png
}

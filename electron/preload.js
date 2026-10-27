/**
 * Electron 预加载脚本。
 *
 * 只暴露最少的东西：前端只需要知道"我在桌面壳里"，用来隐藏"用浏览器打开"
 * 之类的提示。不暴露 node API（contextIsolation: true）。
 */
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktopShell', {
  /** 是不是跑在 Electron 里 */
  isDesktop: true,
  /** 壳版本（排错时有用） */
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})

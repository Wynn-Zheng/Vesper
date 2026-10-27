# Electron 封装

> 2026-10-27。**代码完整、依赖已装、能启动**；**打包我这环境做不了**（原因见第四节）。

---

## 一、现在有什么

```
electron/
├── main.js             主进程（探测后端 / 拉起 / 窗口 / 托盘 / 断网降级）
├── preload.js          预加载（只暴露 isDesktop）
├── package.json        依赖 + electron-builder 配置（已排除用户数据）
└── node_modules/       已装 405 包，含 electron.exe 33.4.11
```

**验证过**：`node_modules/electron/dist/electron.exe` 存在。

## 二、怎么跑

```bash
cd electron
npm start
```

**它会做三件事**：

1. **探测 `http://127.0.0.1:7788/api/status`**
   - 通了 → **直接连**（复用它）
   - 不通 → **自己 spawn 一个后端**
2. **开窗口**加载 `http://127.0.0.1:7788/?token=<.env 里的>`
3. **退出时**：只杀**自己拉的**后端，不动你手动开的

## 三、怎么打包

```bash
cd electron
npm run dist
```

---

## 四、我这环境两个拦路虎（你在自己终端里应该都不会遇到）

### 1. `ELECTRON_RUN_AS_NODE=1`

**症状**：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
    at main.js:28
```

**原因**：DSH 自己跑在 Electron 里，设了这个变量。继承过来后，`electron.exe` **把自己当 Node 跑**，于是 `require('electron')` 返回的是**路径字符串**而不是 API，`app` / `BrowserWindow` 全是 `undefined`。

**验证**：

```powershell
$env:ELECTRON_RUN_AS_NODE      # 我这边输出 "1"
```

**解法**：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
npm start
```

> **这个坑值得单独记住**：任何"Electron 应用 `app` 是 undefined"的情况，**第一反应查这个变量**。

### 2. `electron-builder` 下载二进制失败

**症状**：

```
app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
  at electronDownloader.go:203
```

**原因**：`electron-builder` 打包时要**重新下载一份 Electron 二进制**（不复用 `node_modules/electron/dist`），我这边网络下不动。

**解法**（挑一个）：

```powershell
# 1. 官方镜像
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm run dist

# 2. 或者直接指定本地已下载的
$env:electron_config_cache = "C:\Users\你\.cache\electron"
npm run dist
```

**如果还不行**，说明这个网络环境确实拉不到，换台机器打包。

---

## 五、三个必须知道的坑

### 1. 数据放哪（最大的坑）

**打包后程序在 `C:\Program Files\`，只读**。而源码里**全是相对路径**（`persona/`、`data/`，**36 处**）。

**解法**：`main.js` 里 spawn 时 `cwd: DATA_ROOT`：

```js
backend = spawn('node', [entry], {
  cwd: DATA_ROOT,   // 打包后 = %APPDATA%/QQBot/data-root
  ...
})
```

**源码一行不用改**。

### 2. 端口冲突

**已经处理**：先 `probe()`，通了就不拉；**只杀自己拉的**。

### 3. `extraResources` 已排除用户数据

**上一版是错的**（`persona/` 和 `.env` 会打进安装包）。**现在已改掉**：

```json
"extraResources": [
  { "from": "../src", "to": "app/src" },
  { "from": "../console", "to": "app/console" },
  { "from": "../package.json", "to": "app/package.json" },
  { "from": "../node_modules", "to": "app/node_modules",
    "filter": ["**/*", "!**/*.md", "!**/test/**", "!**/__tests__/**"] }
]
```

**但没有首次启动的数据初始化** —— 装了之后 `persona/` 是空的，机器人没有记忆。

**需要补**：首次启动时从 `persona-template/` 复制一份。

---

## 六、断网也能启动（已做到）

| 依赖 | 断网时 |
|---|---|
| **前端** | ✅ 零 CDN，照常渲染 |
| **后端** | ✅ 能起来 |
| **DeepSeek** | ⚠️ 体检报红 |
| **NapCat** | ⚠️ 体检报红 |
| **界面** | ✅ **正常打开** |

加载失败有降级页（不是 `ERR_CONNECTION_REFUSED`）。

---

## 七、还没做的

| 项 | 说明 |
|---|---|
| **`icon.png`** | 放一张 256x256 的图 |
| **首次启动数据初始化** | 从模板复制 `persona/` |
| **实际打包出 exe** | 网络限制，要换环境试 |
| **自动更新** | 占位 |

---

## 八、一句话总结

**代码这层是完整的**（探测复用 / spawn / 托盘 / 断网降级 / 数据目录）。

**卡在两件和代码无关的事上**：
1. 环境变量 `ELECTRON_RUN_AS_NODE`（DSH 特有）
2. 网络拉不到打包用的 Electron 二进制

**你在自己终端里 `cd electron && npm start` 应该能直接开窗口。**

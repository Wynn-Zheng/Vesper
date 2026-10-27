# Electron 封装

> 2026-10-27。**代码完整，依赖已装，但在我这个环境里跑不起来**（原因见第四节）。
> 你在自己的终端里跑应该没问题。

---

## 一、现在有什么

```
electron/
├── main.js             主进程（探测后端 / 拉起 / 窗口 / 托盘 / 断网降级）
├── preload.js          预加载（只暴露 isDesktop）
├── package.json        依赖 + electron-builder 配置
└── node_modules/       已装（405 包，含 electron.exe 33.4.11）
```

**`node_modules/electron/dist/electron.exe` 存在**（二进制下载成功了）。

## 二、怎么跑

```bash
cd electron
npm start
```

**等价于**：

```bash
./node_modules/electron/dist/electron.exe .
```

**它会做三件事**：

1. **探测 `http://127.0.0.1:7788/api/status`**
   - 通了 → **直接连**（复用它，不重复拉）
   - 不通 → **自己 spawn 一个后端**
2. **开窗口**加载 `http://127.0.0.1:7788/?token=<.env 里的>`
3. **退出时**：
   - **我拉的后端** → 杀掉
   - **你手动开的** → **不杀**

## 三、打包

```bash
cd electron
npm run dist
```

**先改 `package.json`**（见第五节）。

---

## 四、我这边为什么跑不起来

**报错**：

```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
    at Object.<anonymous> (main.js:28:22)
```

**原因**：**环境变量 `ELECTRON_RUN_AS_NODE=1`**

DSH 自己跑在 Electron 里，它设了这个变量。继承到这个变量后，`electron.exe` 会**把自己当成 Node**，于是：

- `require('electron')` 返回的不再是 API，而是**可执行文件的路径字符串**
- 所以 `app`、`BrowserWindow` 全是 `undefined`

**验证**：

```powershell
$env:ELECTRON_RUN_AS_NODE      # 我这边输出 "1"
```

**你在自己的终端里**（不是从 DSH 里起的）**不会有这个变量**，所以 `npm start` 能正常开窗口。

**如果确实遇到了**：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
npm start
```

**这个坑值得记下来**：任何"Electron 应用被当成 Node 跑、`app` undefined"的情况，**第一反应就查这个变量**。

---

## 五、三个必须知道的坑

### 1. 数据放哪（最大的坑）

**打包后程序在 `C:\Program Files\`，那是只读的**。

而项目源码里**全是相对路径**（`persona/`、`data/`，共 **36 处**）。

**解法**：`main.js` 里 spawn 后端时把 `cwd` 设成**用户数据目录**：

```js
backend = spawn('node', [entry], {
  cwd: DATA_ROOT,   // ← 关键，源码一行不用改
  ...
})
```

`DATA_ROOT` 在打包后是 `%APPDATA%/QQBot/data-root`，开发时是项目目录。

### 2. 端口冲突

**如果你已经 `npm start` 了，Electron 又拉一个** → `EADDRINUSE`，后端直接崩。

**已经处理**：先 `probe()`，通了就不拉；**并且只杀"我拉的"那个**。

### 3. `extraResources` 里别放 `persona/` 和 `.env`

**现在的 `package.json` 还带着这两行，打包前要删**：

```json
{ "from": "../persona", "to": "app/persona", "filter": ["**/*"] },
{ "from": "../.env", "to": "app/.env" }
```

**理由**：
- `persona/` 是**用户的聊天记忆**，打进安装包会带给别人
- `.env` 里有 **API key**
- 升级时会被覆盖

**正确做法**：首次启动时从 `persona-template/` 复制一份空的过去（还没做）。

---

## 六、断网也能启动（已经做到）

| 依赖 | 断网时 |
|---|---|
| **前端** | ✅ 零 CDN（系统字体 + emoji/SVG），照常渲染 |
| **后端** | ✅ 能起来（只连 DeepSeek，不连就不连） |
| **DeepSeek** | ⚠️ 体检报红："API 连不上" |
| **NapCat** | ⚠️ 体检报红 + NapCat tab 显示"没跑" |
| **界面** | ✅ **正常打开** |

**加载失败时有降级页面**（不是 Chromium 的 `ERR_CONNECTION_REFUSED`）：

```js
win.webContents.on('did-fail-load', (_e, code, desc) => {
  win.loadURL('data:text/html,...连不上后端...')
})
```

---

## 七、还没做的

| 项 | 说明 |
|---|---|
| **`icon.png`** | 要放一张 256x256 的图 |
| **首次启动的数据初始化** | 从模板复制 `persona/` |
| **打安装包验证** | `npm run dist`（要改 `extraResources` 先） |
| **自动更新** | 占位，没做 |

---

## 八、和"设置页 → 关于 → 重启"的关系

现在那个按钮返回：

> 服务不能自己重启（会掐断正在返回的响应）。

**打包后可以真做**：主进程能杀子进程再拉一个。

**做法**：preload 暴露 `desktopShell.restartBackend()`，设置页调它。

---

## 九、一句话总结

**Electron 这层的代码量不大（一个 `main.js` 就够）**，真正麻烦的是：

1. **数据目录** —— 已解决（`cwd` 指到 userData）
2. **打包时排除用户数据** —— 没做（动手前改 `package.json`）
3. **首次启动初始化** —— 没做
4. **环境变量 `ELECTRON_RUN_AS_NODE`** —— 我这边撞上了，你那边应该不会

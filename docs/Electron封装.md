# Electron 封装

> 2026-10-27。**代码写好了，但没装依赖、没打包**（Electron 要下几百 MB）。
> 这份文档说明怎么打、以及几个必须知道的坑。

---

## 一、现在有什么

```
electron/
├── main.js        主进程（探测后端 / 拉起 / 窗口 / 托盘）
├── preload.js     预加载（只暴露 isDesktop）
├── package.json   依赖 + electron-builder 配置
└── icon.png       还缺（放一张 256x256 的图进来就有图标了）
```

## 二、怎么跑起来

```bash
cd electron
npm install            # 下 Electron（约 300 MB，慢）
npm start              # 开发模式：直接开窗口
```

**它会做三件事**：

1. **探测 `http://127.0.0.1:7788/api/status`**
   - 通了 → **直接连**（复用它，不重复拉）
   - 不通 → **自己 spawn 一个后端**
2. **开窗口**加载 `http://127.0.0.1:7788/?token=<.env 里的>`
3. **退出时**：
   - **我拉的后端** → 杀掉
   - **你手动开的** → **不杀**（不然把你自己的服务关了）

## 三、打包

```bash
cd electron
npm run dist           # 出 dist/QQBot Setup 0.1.0.exe
```

## 四、三个必须知道的坑

### 1. 数据放哪（最大的坑）

**打包后程序在 `C:\Program Files\`，那是只读的**。

而项目源码里**全是相对路径**（`persona/`、`data/`，共 36 处）。

**解法**：`main.js` 里 spawn 后端时把 `cwd` 设成**用户数据目录**：

```js
backend = spawn('node', [entry], {
  cwd: DATA_ROOT,   // ← 关键
  ...
})
```

`DATA_ROOT` 在打包后是 `%APPDATA%/QQBot/data-root`，开发时是项目目录。

**所以后端所有相对路径自动落到用户目录**，源码一行不用改。

### 2. 端口冲突

**如果你已经 `npm start` 了，Electron 又拉一个** → `EADDRINUSE`，后端直接崩。

**已经处理**：先 `probe()`，通了就不拉。

**并且记住了"这个后端是不是我拉的"** —— 只有我拉的才在退出时杀。

### 3. `extraResources` 里别放 `persona/` 和 `data/`

那是**用户的运行时数据**，打包进去会导致：

- 装到别人机器上带着你的聊天记录
- 升级时被覆盖

**现在的 `package.json` 里 `extraResources` 还带着 `persona/`** —— **打包前要删掉**：

```json
// 删这两行
{ "from": "../persona", "to": "app/persona", "filter": ["**/*"] },
{ "from": "../.env", "to": "app/.env" }    // .env 里有 key，也不能打进去
```

**正确的做法**：首次启动时从 `persona-template/` 复制一份空的过去。

---

## 五、断网也能启动（已经做到）

| 依赖 | 断网时 |
|---|---|
| **前端** | ✅ 零 CDN（系统字体 + emoji/SVG 图标），照常渲染 |
| **后端** | ✅ 能起来（只连 DeepSeek，不连就不连） |
| **DeepSeek** | ⚠️ 体检会报红："API 连不上" |
| **NapCat** | ⚠️ 体检会报红 + NapCat tab 显示"没跑" |
| **界面** | ✅ **正常打开**，只是有些功能不可用 |

**关键**：**加载失败时有降级页面**（不是 Chromium 的 `ERR_CONNECTION_REFUSED`）：

```js
win.webContents.on('did-fail-load', (_e, code, desc) => {
  win.loadURL('data:text/html,...连不上后端...')
})
```

---

## 六、还没做的

| 项 | 说明 |
|---|---|
| **`icon.png`** | 要放一张 256x256 的图 |
| **首次启动的数据初始化** | 从模板复制 `persona/` |
| **真装 electron 试跑** | 要下 300 MB |
| **打安装包验证** | `npm run dist` |
| **自动更新** | 你说先占位，没做 |

---

## 七、和"设置页 → 关于 → 重启"的关系

现在设置页那个"重启"按钮返回的是：

> 服务不能自己重启（会掐断正在返回的响应）。请手动 Ctrl+C 后重新 `npm start`。

**打包成 Electron 之后**，这里可以真的做：主进程能杀子进程再拉一个。

**做法**：preload 暴露一个 `desktopShell.restartBackend()`，设置页调它。

---

## 八、我的判断

**Electron 这层代码量不大（一个 main.js 就够）**，真正麻烦的是：

1. **数据目录**（已解决：`cwd` 指到 userData）
2. **打包时排除用户数据**（还没做，要动手前改 `package.json`）
3. **首次启动初始化**（还没做）

**如果你现在就想打成 exe**，我可以先做 2 和 3，再 `npm install` + `npm run dist` 验证一遍（要等下载）。

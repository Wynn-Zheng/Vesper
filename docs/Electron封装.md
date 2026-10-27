# Electron 封装

> 2026-10-27 更新。**已经能打出绿色版**（`release/QQBot/QQBot.exe`，269.8 MB）。
> 本机（DSH 沙箱）**跑不起来 GUI**，原因见第五节 —— 那三条都是环境限制，不是代码问题。

---

## 一、怎么打包

```powershell
node scripts/package-electron.ts
```

**不需要网络**，不碰 `electron-builder`。

产物：

```
release/QQBot/
├── QQBot.exe                   ← 双击运行
├── *.dll / *.pak / locales/    ← Electron 运行时（直接复制 electron/dist）
└── resources/
    ├── app/                    ← main.js + build/ + console/ + node_modules
    └── persona-template/       ← 首次启动复制到用户数据目录
```

## 二、为什么不用 electron-builder

它打包时要**重新下载一份 Electron 二进制**（不复用 `node_modules/electron/dist`），
这台机器网络拉不动（`app-builder.exe ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`）。

而 `electron/dist` **本身就是一个可运行的 Electron 运行时** —— 复制过来、
把 `resources/default_app.asar` 换成我们的 `app` 就行，全程离线。

**代价**：不是 NSIS 安装包，是绿色免安装目录。

## 三、打包时必须处理的 6 件事

| # | 问题 | 处理 |
|---|---|---|
| 1 | Electron 33 内置 **Node 20.18**，不支持直接跑 `.ts` | `tsc -p tsconfig.build.json` 编译到 `build/`，主进程入口指到 `build/index.js` |
| 2 | `.ts` 的 import 后缀 | `tsconfig.build.json` 开 `rewriteRelativeImportExtensions`，`./x.ts` 自动改写 `./x.js` |
| 3 | 后端不能依赖系统 Node | `spawn(process.execPath)` + `ELECTRON_RUN_AS_NODE=1`（等于一个 node） |
| 4 | Node 20 没有 `--env-file-if-exists` | `main.js` 里自己读 `.env`，塞进子进程 `env` |
| 5 | 打包后 `cwd` 变成用户数据目录，`console/` 找不到 | `main.js` 传 `QQBOT_ROOT`，`server.ts` 用 `staticRoot()` 优先读它 |
| 6 | 首次启动没有 `.env` / `persona/` | `ensureDataRoot()`：生成随机 token 的 `.env` + 从 `persona-template` 复制 |

### 关于 `package.json` 的类型布局（踩过坑）

```
resources/app/package.json      ← 无 type（默认 CJS），main: "main.js"
resources/app/main.js           ← CJS（require）
resources/app/preload.js        ← CJS（require）
resources/app/build/package.json ← {"type":"module"}  ← 只给 build/ 用
```

**为什么**：`main.js` 和 `preload.js` 是 CJS，`build/` 里的后端是 ESM，
同一个 `package.json` 不能同时满足 —— 用**子目录 `package.json` 覆盖**（Node 的标准机制）。

**另外**：`package.json` 的 `main` 字段**只认 `.js`**。
写成 `main.cjs` 会让 Electron 静默不加载（不报错、不弹窗、直接退出）。

## 四、数据放哪

```
%APPDATA%/QQBot/data-root/       ← 打包后的数据目录（cwd）
├── .env                         ← 首次启动生成（随机 CONSOLE_TOKEN，API Key 留空）
├── persona/                     ← 从 persona-template 复制
├── data/                        ← 日志/记忆（运行时生成）
└── plugins/                     ← 装的插件
```

**源码一行没改** —— 所有相对路径（`persona/`、`data/`）都相对 `cwd`，
主进程 `spawn` 时把 `cwd` 设成 `DATA_ROOT` 就位了。

## 五、本机为什么跑不起来 GUI（三条环境限制）

**代码是好的，包也是好的，但这台机器跑不起来。**

### 1. Electron 的 sandbox 初始化失败

```
exit = -2147483645  (0x80000003 STATUS_BREAKPOINT)
```

`electron.exe` **无参数（连默认欢迎页）都崩**。

`--no-sandbox` 能活：

| 参数 | 结果 |
|---|---|
| （无） | ✗ 崩 |
| `--no-sandbox` | ✅ 活 |
| `--disable-gpu` | ✗ 崩 |
| `--no-sandbox --disable-gpu` | ✅ 活 |

### 2. Electron 进程写不了任何用户目录

```
Error: EPERM: operation not permitted,
  open 'C:\Users\Lenovo\AppData\Local\Temp\xxx.log'
Error: EPERM: operation not permitted,
  open 'C:\Users\Lenovo\AppData\Roaming\xxx.log'
```

`%TEMP%` 和 `%APPDATA%` **都被拒**。

后果：`ensureDataRoot()` 一上来 `mkdirSync` 就失败，`trace()` 也写不了
（所以早期调试时"日志文件不存在"误导了很久 —— 以为是 `main.js` 没执行，
其实是**执行了但写不进去**）。

### 3. 没有交互式桌面会话

`0xC0000005`（访问冲突）出现在创建窗口/托盘阶段，典型表现是无桌面会话。

### 所以：**需要你在真实桌面上双击验证**

```powershell
release\QQBot\QQBot.exe
```

如果打不开，先试：

```powershell
release\QQBot\QQBot.exe --no-sandbox
```

## 六、已在本机验证的部分

| 项 | 怎么验的 | 结果 |
|---|---|---|
| **编译产物能在 Node 20 跑** | 用 `electron.exe` 的 Node 模式直接跑 `build/index.js` | ✅ 规则加载、模型就绪、NapCat 连上、控制台起在 7788 |
| **import 后缀改写正确** | 检查 `build/index.js` 的 import | ✅ 全是 `./x.js`，零残留 `.ts` |
| **打包结构正确** | 对比产物和 `electron/dist` | ✅ 19 项，只改了 exe 名 |
| **app 能被 Electron 加载** | 极简 app（`package.json` + `main.js`） | ✅ `main.js` 执行到了 |
| **GUI 能开** | — | ❌ 环境限制（见第五节） |

**最重要的一条**：那份 `electron.exe -p` 跑 `build/index.js` 的成功日志 ——
说明**后端在 Electron 的 Node 20 上完全正常**，这是最容易翻车的地方，已经过了。

## 七、还没做的

| 项 | 说明 |
|---|---|
| **`icon.png`** | 现在用 Electron 默认图标。放一张 256x256 的图到 `electron/icon.png` 即可 |
| **NSIS 安装包** | 需要网络下载 NSIS，或者换台机器跑 `electron-builder` |
| **自动更新** | 占位 |
| **GUI 实测** | 需要真实桌面 |

## 八、一句话总结

**打包链路通了**：`node scripts/package-electron.ts` 离线产出 `release/QQBot/QQBot.exe`。

**后端已经完全验证**（Node 20 + 编译产物 + NapCat + 控制台）。

**GUI 在本机跑不了**，因为 DSH 沙箱禁写用户目录 + 无桌面会话。
**双击验证这一步得你来。**

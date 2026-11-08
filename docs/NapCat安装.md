# NapCat 安装与配置

> 这个项目**不自带** NapCat，需要你自己装一个。控制台能启动/停止它、看二维码、读日志，
> 但 NapCat 本身（以及它注入的那个 QQ）是独立软件。

---

## 一、装哪个版本（推荐 OneKey）

NapCat 有两种发行形态：

| | 装法 | 我们支持 | 说明 |
|---|---|---|---|
| **OneKey 安装包** | 双击装，带 QQ 本体 | ✅ **推荐** | 目录结构 `NapCat\<版本>.Shell\` |
| **官方 zip（Shell 版）** | 解压即用，要自己装 QQ | ✅ 支持 | 顶层有 `napcat.mjs` |

**推荐 OneKey 版**，因为它：

- **自带 QQ**，不用另外装
- **有现成的启动器**（`NapCatWinBootMain.exe`）
- **装完就能用**（我们的控制台会自动找到它）

**下载地址**：

```
https://github.com/NapNeko/NapCatQQ/releases
```

**找文件名带 `OneKey` 的**（比如 `NapCat.OneKey.xxxxx.exe`），双击装。

**如果 GitHub 打不开**，可以找 NapCat 的镜像站或者问别人要安装包（它是开源免费的）。

---

## 二、装完是什么样

**OneKey 装完的目录结构**：

```
你选的安装位置\
└── NapCat\
    ├── OneKey\bootmain\          ← 壳模板（只有 exe，没有 QQ 本体）
    │   ├── NapCatWinBootMain.exe
    │   └── napcat.quick.bat
    │
    └── NapCat.52230.Shell\       ← 真正的安装目录（我们要的是这一层）
        ├── QQ.exe
        ├── versions\
        │   └── 9.9.33-52230\
        │       └── resources\app\napcat\
        │           ├── NapCatWinBootMain.exe
        │           ├── NapCatWinBootHook.dll
        │           ├── napcat.mjs
        │           ├── config\        ← webui.json 在这里
        │           ├── cache\         ← qrcode.png 在这里
        │           └── logs\
        └── ...
```

**⚠️ 两个坑**：

1. **`OneKey\bootmain` 不是真目录** —— 它只有启动器，没有 QQ 本体，拉不起来
2. **版本号会变** —— 今天是 `NapCat.52230.Shell`，下次更新可能变成 `NapCat.53000.Shell`

**所以不要在任何地方写死版本号**（这个项目的代码就是这么做的）。

---

## 三、装完怎么让控制台找到它

> 入口在控制台「**插件 → 接入平台 → QQ**」（不是「日志」页 —— NapCat 详情页早就不在左侧导航里了）。

### 默认：自动探测

控制台会按顺序试这些位置：

```
C:/NapCat、D:/NapCat、E:/NapCat、F:/NapCat
C:/napcat、D:/napcat、...
%USERPROFILE%/NapCat
%USERPROFILE%/Desktop/NapCat
%USERPROFILE%/Downloads/NapCat
%USERPROFILE%/Documents/NapCat
```

**在每个位置下找名字带 `shell` 或 `napcat` 的目录**，然后判断它是不是"真 Shell"。下面三条**满足任意一条就算**，不是三条都要：
- 有 `QQ.exe`（注入型）
- 有 `versions/`（目录）
- 有 `napcat.mjs`（Shell 型，官方 zip）

判据就是这一行（`src/napcat/locate.ts:95`）：

```ts
existsSync(d + '/QQ.exe') || existsSync(d + '/versions') || existsSync(d + '/napcat.mjs')
```
**要填的是**：

```
E:/NapCat/NapCat.52230.Shell        ← 对，这一层
E:/NapCat                            ← 错（这是外面那层）
E:/NapCat/OneKey/bootmain           ← 错（这是壳模板）
```

**填完会立刻验证**，目录不对会直接告诉你原因（比如「里没有 QQ.exe —— 这可能是 OneKey 的壳模板目录」）。

**想恢复自动探测**：把输入框清空，保存。

---

## 四、第一次用要做什么

### 1. 启动 NapCat

控制台 → **日志 → NapCat** → 点 **「启动」**。

**会做什么**：

- 默认**完全无窗口**（直接 spawn `NapCatWinBootMain.exe`）
- 几秒后右边滑出**二维码**

### 2. 扫码登录

**用**小号**扫**（**别用主号**，NapCat 官方也这么建议）。

**扫完 3 秒内自动检测**，登录成功后右侧面板会自己收起。

### 3. 看 WebUI（可选）

登录后页面下半部分就是 **NapCat 的 WebUI**（iframe 内嵌），里面能改：

- **网络配置**（OneBot 的 ws/http 端口）
- **账号设置**
- **插件管理**

**如果 iframe 里显示的是登录页**，说明 token 没自动带上 —— 手动输一次就好（token 在 NapCat 的 `config/webui.json` 里）。

---

## 五、日志怎么看

**默认不记录日志**（为了零窗口）。

**要看日志**：

1. 勾选 **「记录 NapCat 日志」**
2. **重启 NapCat**（点「重启」）
3. 下方会出现 `[WebUI] [日志]` 切换，点「日志」

**日志写在**：`<安装目录>/napcat-console.log`

**注意**：**打开日志后启动会有个 cmd 窗口**（因为要走 `.cmd` 脚本）。这是 Windows 的限制，没办法同时做到“有完整日志”和“完全无窗口”。

---

## 六、这个项目的通用性设计

**为什么要讲这个**：早期版本把路径写死成 `E:/NapCat/...`，换台机器就全废。

**现在的做法**（参考 [dsh-napcat-keeper](https://github.com/waning-sun/dsh-napcat-keeper)）：

### 1. 配置里存 `Shell目录`，留空就自动探测

`persona/rules.yaml`：

```yaml
NapCat:
  记录日志: false
  Shell目录: ''      # 留空 = 自动探测
```

### 2. 所有路径从它推导，不写死版本号

```ts
// src/napcat/locate.ts
resolvePaths('E:/NapCat/NapCat.52230.Shell')
→ {
    qqExe:    '.../QQ.exe',
    launcher: '.../versions/9.9.33-52230/resources/app/napcat/NapCatWinBootMain.exe',
    //                        ↑ 这个版本号是读目录读出来的，不是写死的
  }
```

### 3. 不依赖任何 `.cmd` 启动脚本

**别人装 NapCat 不一定有我们改过的那个脚本**，所以直接 `spawn NapCatWinBootMain.exe`。

### 4. 两种装法都支持

| 形态 | 判据 | 启动方式 |
|---|---|---|
| **注入型**（OneKey） | 有 `QQ.exe` + `versions/` | `spawn NapCatWinBootMain.exe QQ.exe Hook.dll` |
| **Shell 型**（官方 zip） | 顶层有 `napcat.mjs` | `node napcat.mjs` |

**自动判断**，不用你选。

---

## 七、三条红线（NapCat 出过永久封号事故）

1. **只监听 `127.0.0.1`**，绝不 `0.0.0.0`
2. **改掉默认 token `napcat`**，用随机长串
3. **不把 WebUI / OneBot 端口暴露到公网**

2025 年 9 月那批账号永久封禁，起因就是这三条没做。

> 本项目的 `.env` 里 `ONEBOT_HOST=127.0.0.1` 就是第 1 条；`ONEBOT_TOKEN` 必须和 NapCat 里设的一致，且不要用 `napcat`。

## 八、常见问题

### Q：控制台说「找不到 NapCat」

**先确认装没装**，再点「改」手动填路径。

**路径要填到 `<版本>.Shell` 那一层**，不是外面的 `NapCat`。

### Q：点「启动」没反应

**看 `/api/napcat` 返回什么**，或者点「刷新」看状态。

**常见原因**：

- **QQ 已经有进程在跑** → 先把 QQ 全关掉再启动
- **端口 6099 被占** → 那是上一个 NapCat 没退干净，点「停止」再启动
- **NapCat 版本太老** → 更新到最新版

### Q：二维码刷新不出来

**NapCat 没登录时才会生成二维码**。如果已经登录了（`isLogin: true`），`GetQQLoginQrcode` 会返回 `QQ Is Logined`，**没有新码**。

**要重新扫码**：先在 NapCat WebUI 里退出登录，再刷新控制台。

### Q：日志是乱码

**日志是 `.cmd` 的 PowerShell `Tee` 写的 UTF-16LE**，我们读的时候用 `Get-Content -Encoding UTF8` 转过了。

**如果还是乱**，说明文件里混了别的编码（比如你手动用记事本改过），**删掉 `napcat-console.log` 重新启动**即可。

### Q：能不能完全不用 QQ 客户端

**不能**。NapCat 是**注入到 QQ 进程**里工作的，QQ 本体必须在。
（Shell 型的官方 zip 也一样要 QQ。）

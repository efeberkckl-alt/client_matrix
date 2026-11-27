# NoobClawMatrix 3.4.93

本仓库是 3.4.93 的源码快照。这份说明覆盖 Windows x64 上的界面预览、桌面开发和安装包构建。不包含预编译的后台程序、FFmpeg 或安装包。

## 1. 准备环境

- 安装 [Git](https://git-scm.com/install/windows) 和 [Node.js 24.x](https://nodejs.org/en/download)。项目要求 Node.js `>=24 <25`。
- 只预览网页时，到这里即可。启动或打包桌面版还需要 Visual Studio 2022 Build Tools 的 **使用 C++ 的桌面开发**工作负载（含 Windows SDK）、Rust MSVC 工具链和 Microsoft Edge WebView2 Runtime。按 [Tauri 的 Windows 前置要求](https://v2.tauri.app/zh-cn/start/prerequisites/#windows)安装。
- 视频处理需要 [FFmpeg](https://ffmpeg.org/download.html)。把 Windows x64 版的 `ffmpeg.exe` 所在目录加入 `PATH`，然后重开 PowerShell，用 `ffmpeg -version` 检查。也可以在启动应用的同一个 PowerShell 中运行 `$env:NOOBCLAW_FFMPEG_PATH = 'C:/tools/ffmpeg/bin/ffmpeg.exe'`，并替换成你的实际路径。

在 PowerShell 中下载源码并按锁文件安装依赖。

```powershell
git clone https://github.com/efeberkckl-alt/client_matrix.git
cd client_matrix
node --version
npm ci
```

如果要启动桌面版，再检查 Rust 的默认目标。

```powershell
rustc --print host-tuple
cargo --version
```

Windows x64 的预期目标是 `x86_64-pc-windows-msvc`。如果 Rust 尚未安装该工具链，运行 `rustup toolchain install stable-x86_64-pc-windows-msvc`，再运行 `rustup override set stable-x86_64-pc-windows-msvc` 为当前源码目录选用它。

## 2. 只预览网页界面

```powershell
npm run dev -- --host 127.0.0.1
```

用浏览器打开 [http://127.0.0.1:5175](http://127.0.0.1:5175)。这个模式用于预览前端，不能代替 Tauri 桌面应用。依赖桌面后台的功能不能单靠网页跑通。停止预览时按 `Ctrl+C`。

## 3. 启动 Windows 桌面应用

先退出正在运行的 NoobClawMatrix 和上一节的网页预览。如果机器上已有正式版，建议用独立 Windows 测试账号启动源码，避免复用正式账号的数据目录。不要在首次确认应用版本前导入正式账号或启用任务。

在项目根目录运行以下命令。首次运行需要下载构建依赖并编译 Rust，耗时会比再次启动长。

```powershell
npm run tauri:dev
```

此命令先生成 `src-tauri/binaries/noobclaw-server-x86_64-pc-windows-msvc.exe`，再启动 Vite 和 Tauri 窗口。不要另外手动启动 Vite。桌面窗口打开后，在另一个 PowerShell 中检查后台。

```powershell
Invoke-RestMethod http://127.0.0.1:18801/api/version
```

预期返回 `version = 3.4.93` 和 `mode = tauri-sidecar`。检查完成后，关闭桌面窗口并在运行开发命令的终端按 `Ctrl+C`。

## 4. 构建和检查输出

只构建前端或后台时，可以分别运行以下命令，不需要启动桌面应用。

```powershell
npm run build
npm run build:sidecar
```

前端输出在 `dist/`。后台程序和 `sql-wasm.wasm` 输出在 `src-tauri/binaries/`。

构建 Windows NSIS 安装包时，运行以下命令。默认输出在 `src-tauri/target/release/bundle/nsis/`。如果另设了 `CARGO_TARGET_DIR`，从该目录下查找 `release/bundle/nsis/`。

```powershell
npm run tauri:build -- --bundles nsis
```

如果要在没有安装 FFmpeg 的机器上使用视频处理，在构建安装包前，把 Windows x64 的 `ffmpeg.exe` 放到 `src-tauri/resources/ffmpeg-win/bin/`。不内置 FFmpeg 时，目标机也要安装 FFmpeg 或配置 `NOOBCLAW_FFMPEG_PATH`。

## 5. 启动失败时先查这些地方

| 现象 | 排查方式 |
| --- | --- |
| `npm ci` 报 Node 版本不符 | 运行 `node --version`，切到 24.x 后重试。 |
| 找不到 `link.exe` 或 Rust 目标错误 | 检查 C++ 桌面开发工作负载、Windows SDK 和 MSVC Rust 工具链。 |
| `5175` 或 `18801` 被占用 | 运行 `Get-NetTCPConnection -LocalPort 5175,18801 -State Listen`。先确认进程归属，再关闭旧预览或旧桌面应用。 |
| 找不到后台程序或版本接口不通 | 查看 `npm run tauri:dev` 的终端输出。单独运行 `npm run build:sidecar`，确认后台程序和 WASM 文件已生成。 |
| 视频功能提示 FFmpeg 不可用 | 在启动应用的终端运行 `ffmpeg -version`，或设置 `NOOBCLAW_FFMPEG_PATH` 后重启。 |
| Electron 打包脚本找不到配置或文件 | 此快照的桌面入口是 Tauri。按上面的 `tauri:dev` 或 `tauri:build` 路径运行。 |

这份源码快照已在 Windows x64 的临时副本中验证依赖安装、Vite 预览地址、前端构建、后台构建和隔离后台的版本接口。本次没有重新启动完整桌面窗口、构建或安装 NSIS 安装包，也没有连接真实平台账号。

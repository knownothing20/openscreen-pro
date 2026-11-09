# OpenScreen Windows 内部试用 — V2.6.1 最终交付收口

**本轮不开发功能，不开启 V2.6.2/V2.7。** 只做三件事：定性并处理 `frame_geometry` 的布局断言、核对并冻结正式 Windows 交付产物、核对 Git 与写使用说明。

| 问题 | 答案 |
|---|---|
| 交付哪份源码 | 本地 `main`，产品代码最后提交 `6673df2`；本轮只多一个测试/注释提交 `0ed62bc`（其余是本报告） |
| 交付哪个安装包 | `release/v261-build/Openscreen.Setup.2.0.0.exe`，160,566,254 B，sha256 `03719c22…`（完整值见 §5） |
| 208 vs 176 是什么 | **仅测试过期**：`LayerCB` 在 Focus Effect（`397f2c8`）时按设计从 176 长到 208，三个 shader 同步改了，测试没改。运行代码一直是对的 |
| 本轮改了什么 | 2 个 Rust 文件里的**测试断言与注释**，14 增 5 删；没有运行代码改动 |
| 是否阻塞内部试用 | **不阻塞**。需要提前告知的限制见 §9 |
| 能否推送 origin | **可以，但未推送**，等授权（§6） |

---

## 1. 交付的源码与安装包

### 1.1 源码

```
仓库            D:\GitHub\OpenScreen
分支            main
HEAD            本报告提交（父提交 0ed62bcffcdc7390c22033d156ba444be28d7bd1）
产品代码末尾     6673df2bccb874f135d22c5d6d9e8f84bfb3415f   fix(export): rebuild the device once …
TS 代码末尾      2ec0e531cc5d60e5aac39a490a6d147e59a6b2c1   fix(export): honour a cancel that arrived …
本轮源码改动     0ed62bcffcdc7390c22033d156ba444be28d7bd1   test(compositor): assert the 208-byte LayerCB …
origin/main     1b296da84aeefe13b0386f276d2da5108bdd4ec8   （0 behind）
```

`git diff 2ec0e53..HEAD -- src electron` 为空：V2.6.1 之后没有任何 TypeScript/主进程源码变化。
`git diff 6673df2..HEAD` 在本轮之前只有一份报告；本轮加入的 `0ed62bc` 只碰 `#[test]` 与文档注释。

### 1.2 安装包与"它基于哪个提交"

```
路径      D:\GitHub\OpenScreen\release\v261-build\Openscreen.Setup.2.0.0.exe
大小      160,566,254 B
sha256    03719c222ae93811e033ff0f64ea635a49247b54429353cf527321e5751c4ab7
构建时间   2026-11-09 16:21:53 (+08:00)（latest.yml releaseDate 2026-11-09T08:21:53Z）
```

对应关系不是猜的，是三条可复核的事实钉住的：

1. **addon**：`crates/target/release/compositor_view.dll` 与 `electron/native/bin/win32-x64/compositor_view.node`
   同哈希 `56534cfa…`，mtime 16:06:37 / 16:06:38；最后一次 Rust 源码改动是
   `pipeline_windows.rs` 的 16:06:04，**构建晚于最后一次源码改动**。这两个二进制就是 `6673df2`
   那三个 Rust 文件的构建产物（提交时间 16:23，是"把已在磁盘上的内容记进历史"）。
2. **asar**：包内 `dist-electron/main-CTAWBrJk.js` 与本地 `dist-electron/main-CTAWBrJk.js`
   逐字节相同（sha256 `a4bf48a3…`，3,953,443 B）。本地这份 bundle 构建于 12:04。
3. **bundle 之后没有源码变化**：`git diff 2ec0e53..HEAD -- src electron` 为空，所以 12:04 的
   bundle 就是当前 TS 源码的产物。

**不能说的话**：这不等于"源码可复现构建"。本轮没有重跑 `vite build` + `electron-builder`，
也没有验证二进制构建的确定性；上面证明的是**包内内容 = 当前源码的构建产物**，不是"任何人重跑都得到同一字节"。

### 1.3 安装验证

**未执行安装验证。** `%LOCALAPPDATA%\Programs` 下没有 Openscreen 安装目录，本机是开发版/解包版在跑；
本轮没有运行 NSIS，也没有覆盖任何已安装版本（没有隔离环境，不假报安装成功）。
打包后的真实运行证据来自 V2.6.1 在 `win-unpacked` 上的直跑（§4 标为复用）。

---

## 2. 208 vs 176 到底是什么问题

### 2.1 结论：**A. 仅测试过期**（运行代码正确，未重建 addon）

### 2.2 逐项核对

**(1) 测试比较什么。** `crates/compositor/src/frame_geometry.rs:7533`
`layer_cb_matches_the_shader_constant_buffer` 断言 `size_of::<LayerCB>()`、`align_of`，以及 13 个字段的
`offset_of`。它检查的是**正确对象**（`LayerCB` 本体），不是旧布局或错误结构体；错的是期望值。

**(2) CPU 端结构体。** `frame_geometry.rs:45` `#[repr(C, align(16))] pub struct LayerCB`：
`dst/src`（2×16）+ `quad_px/radius_px/mode`（16）+ `color/fx/src_prev/dst_prev/mb/trail_a/trail_b/trail_mb/focus_a/focus_b`（10×16）
= **208 字节**，13 个 16 字节槽。

**(3) shader 端常量缓冲区。** 三处声明字段顺序与类型完全一致，且都以 `focus_b` 结尾：

| 后端 | 位置 | 末尾字段 |
|---|---|---|
| HLSL | `shaders.hlsl:11` `cbuffer Layer : register(b0)` (11–28 行) | `float4 focus_a; float4 focus_b;` |
| Metal | `shaders.metal:54` `struct Layer` (54–76 行) | `float4 focus_a; float4 focus_b;` |
| WGSL | `vk_shaders/layer.wgsl:29` `struct Layer` (29–49 行) | `focus_a: vec4<f32>, focus_b: vec4<f32>` |

Metal / WGSL 里这两字段的注释写明：**它们现在不画 mode 19，但必须存在，否则以后一启用就整体错位**。

**(4) 偏移/对齐/padding。** 实测（本轮跑测试得到）：`size = 208`、`align = 16`，偏移
`0,16,32,40,44,48,64,80,96,112,128,144,160,176,192`；`focus_a = 176`、`focus_b = 192`，无隐式 padding。
208 是 16 的倍数，D3D11 常量缓冲区对 ByteWidth 的要求也满足。

**(5) 缓冲区创建与上传长度。** `compositor_windows.rs:649` `ByteWidth: std::mem::size_of::<LayerCB>() as u32`；
`:1134` `upload_cb` 用 `std::mem::size_of::<LayerCB>()` 做 `copy_nonoverlapping`。
两处都跟结构体走，**没有任何硬编码 176**。Linux 的 `LAYER_BYTES` 同样是 `size_of::<LayerCB>()`
（`compositor_linux.rs:72`），功能上也没问题，只有注释写着 176（本轮已改注释）。

**(6) Windows 运行路径是否真用这套。** 是。`shaders.hlsl` 由 `crates/compositor/build.rs` 的
`compile_hlsl` 在构建期编译成字节码打进 addon；导出与预览都走 `compositor_windows.rs` 的
CreateBuffer + `upload_cb`。因此 208 字节的写入与 208 字节的 cbuffer 是同一个契约。

**(7) 为什么一直是红的。** `git log -S "focus_a"` → 只有 `397f2c8`（`feat(screenMotion): draw the focus effect on Windows (A2-2)`），
其提交说明原文写着 **"LayerCB grows by two float4 (focus_a, focus_b), 176 -> 208 bytes"**。
而 `git log -S "size_of::<LayerCB>(), 176"` 只命中 `a7eca84`（上游导入）。
即：测试从 `397f2c8` 起就没跟上，且 `size_of` 与平台无关 —— **这条失败与 Windows、与 AMD/NVIDIA 都无关**。

**(8) 测试为什么没抓到错位。** 旧断言只列到 `trail_mb`（160），完全没有 `focus_a/focus_b`。
即使有人把这两个字段写反，旧测试也会通过。修订后补上了这两个 offset。

### 2.3 本轮处理

`0ed62bc`：`size_of` 期望 176 → 208；新增 `focus_a@176`、`focus_b@192` 两条断言；同步
`frame_geometry.rs` 与 `compositor_linux.rs` 里"176 字节 / 十个 vec4"的过期注释。
**运行代码零改动，addon 未重建**：改动前后 `compositor_view.node` 的 sha256 都是
`56534cfac50de4982ca775ed47ba92280960e9f3010a3691503268b86d5a930d`，mtime 仍是 16:06:38。

### 2.4 另外 11 条失败：环境前置条件，与布局无关

命令 `cargo test -p openscreen-compositor --lib`，本轮实测 **495 passed / 11 failed / 0 ignored**（506 条）。
11 条全部是 `pipeline_windows::tests::*`，共同原因是测试辅助函数
（`pipeline_windows.rs:2608-2627`）只认两个位置：

```
$FFMPEG_DIR/bin/ffmpeg.exe
crates/thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/bin/ffmpeg.exe
```

本仓库 `crates/thirdparty/ffmpeg-n8.1.2-win64-lgpl-shared/` 只有 `include/` 与 `lib/`，**没有 `bin/`**；
随包二进制叫 `electron/native/bin/win32-x64/ffmpeg-shared.exe`（文件名不同），且仓库里没有 `ffprobe.exe`
（有 3 条测试需要 ffprobe）。

做过一次**不下载、不改产品代码**的可指向性实验：把 `FFMPEG_DIR` 只对测试进程指向本机已有的
`D:\Program Files\ffmpeg`（该目录有 `bin/ffmpeg.exe` + `bin/ffprobe.exe`），20 条 `pipeline_windows` 测试
从 11 通过变成 **11 passed / 9 failed**，失败样例是 `Unknown encoder 'libopenh264'`
—— 即失败**跟着 FFmpeg 二进制走**，跟着合成器代码不走。随包那份 ffmpeg 里 `libopenh264`/`libaom-av1`
都在，但要把它喂给测试就得在 `thirdparty/.../bin` 下摆一对 `ffmpeg.exe`+`ffprobe.exe`，
这属于改测试环境而不是修产品，本轮不做。

> 注意：`FFMPEG_DIR` 同时被 `build.rs` 读取（`-I` 与链接），直接 `FFMPEG_DIR=… cargo test` 会让构建脚本
> 用错误的 include 重编并失败。上面的实验是"先正常构建、再对测试二进制单独设环境变量"跑的。
> 本轮第二次构建已恢复正确缓存，未影响任何产物。

---

## 3. 本轮改了什么，没有改什么

**改了（1 个提交，2 个文件，+14/−5）：**

| 文件 | 改动 |
|---|---|
| `crates/compositor/src/frame_geometry.rs` | 测试期望 176→208、补 `focus_a/focus_b` offset、三处注释（`176 octets` → `208 octets`） |
| `crates/compositor/src/compositor_linux.rs` | 两行注释里的 176 → 208（`LAYER_BYTES` 本来就是 `size_of`） |

**没改：** 任何运行代码、shader、addon 二进制、安装包、打包配置、依赖、i18n、TS/主进程。

**没做：** 重编 Rust 正式 addon、重新打包、重跑 61 次编码矩阵、重跑 30 分钟混音、重跑全量 GUI 场景。

---

## 4. 哪些验证是本轮执行，哪些是复用

### 4.1 本轮实际执行

| 验证 | 命令 / 方法 | 结果 |
|---|---|---|
| 布局断言（修订前） | `cargo test -p openscreen-compositor --lib layer_cb_matches` | FAILED，`left: 208, right: 176` |
| 布局断言（修订后） | 同上 | **ok** |
| 几何模块全量 | 测试二进制 `frame_geometry::` | **110 passed / 0 failed** |
| 合成器单测全量 | `cargo test -p openscreen-compositor --lib` | **495 passed / 11 failed**（11 条均为 §2.4 的 ffmpeg 路径前置） |
| 结构体 vs 三份 shader | 读源码逐字段核对 | 一致，13×16 = 208 |
| 创建/上传长度 | 读 `compositor_windows.rs` | `ByteWidth` 与 `memcpy` 均为 `size_of::<LayerCB>()` |
| 过期测试的引入点 | `git log -S` / `git show 397f2c8` | 只有 `397f2c8` 引入焦点字段，测试自 `a7eca84` 未变 |
| 产物哈希 | `sha256sum` 逐个文件 | §5 表 |
| 包内 asar == 本地 bundle | `asar extract` + `sha256sum` | 两边 `a4bf48a3…` 相同 |
| 出货包是否含测试钩子 | 构建脚本 + Cargo feature + 二进制字符串 | 三方一致：无（§5.2） |
| 签名状态 | `Get-AuthenticodeSignature` | NSIS 与 `Openscreen.exe` 均 **NotSigned** |
| 系统 ffmpeg 可指向性 | 测试二进制 + 运行时 `FFMPEG_DIR` | 11→9 条失败，失败随 ffmpeg 构建变化（§2.4） |

### 4.2 复用既有证据（**不是本轮新实测**）

| 项 | 来源 |
|---|---|
| 61 次编码矩阵（30 AMD H.264 / 10 AMD HEVC / 5+5 NVIDIA / 10 Auto / 1 CPU） | V2.6.1 §7–§9 |
| 2 次真实设备复位被重试救回 | V2.6.1（**第一版 addon**，不是最终出货 addon） |
| GUI 取消、失败清理、旧文件保护、配音混音字节一致 | V2.6.1 §12 |
| 30 分钟 HEVC 端到端 328.7 s、renderer 峰值 109.6 MB | V2.6 § 低内存混音 |
| 打包版直跑（PATH 去掉系统 ffmpeg，导出 sha 与开发版相同） | V2.6.1 §15 |
| 编辑/撤销/重做/保存重开 14 项、打包版转写 | V2.6 稳定性观察 |
| `%APPDATA%\Openscreen` 副产物目录说明 | V2.6.1 §15 脚注 |

---

## 5. 产物清单与完整哈希

### 5.1 交付对应表

| 项 | 路径 | 大小 | SHA256 |
|---|---|---|---|
| 安装包 (NSIS) | `release/v261-build/Openscreen.Setup.2.0.0.exe` | 160,566,254 B | `03719c222ae93811e033ff0f64ea635a49247b54429353cf527321e5751c4ab7` |
| 解包主程序 | `release/v261-build/win-unpacked/Openscreen.exe` | 223,298,048 B | `470e3e5846eaffdadebb5055344a959ecc7b9c9381b3408130714e80bf9008dc` |
| app.asar | `release/v261-build/win-unpacked/resources/app.asar` | 11,025,084 B | `f9a0fcc925cf6abd71f9596bc130d82659b27a75967952a99217fc3686eb57cd` |
| 主进程 bundle（包内） | `app.asar:dist-electron/main-CTAWBrJk.js` | 3,953,443 B | `a4bf48a3478c6609e23a31db90dc6ca2f810c33c07b3817221e58e7f158be7ee` |
| 主进程 bundle（本地） | `dist-electron/main-CTAWBrJk.js` | 3,953,443 B | 同上（逐字节相同） |
| **正式 addon** | `electron/native/bin/win32-x64/compositor_view.node` | 2,936,320 B | `56534cfac50de4982ca775ed47ba92280960e9f3010a3691503268b86d5a930d` |
| addon（包内） | `win-unpacked/resources/electron/native/bin/win32-x64/compositor_view.node` | 2,936,320 B | 同上 |
| addon（构建产物） | `crates/target/release/compositor_view.dll` | 2,936,320 B | 同上 |
| 随包 FFmpeg | `electron/native/bin/win32-x64/ffmpeg-shared.exe` | 542,208 B | `cfa7457eab838db74cb8888ccaf46549a931a2913312e8dede423a26ddac33d5` |
| FFmpeg（包内） | `win-unpacked/resources/electron/native/bin/win32-x64/ffmpeg-shared.exe` | 542,208 B | 同上 |

其它：`win-unpacked` 文件字节和 **521,077,063 B**；`app.asar` 内 **41** 个条目；
NSIS `latest.yml` 的 `sha512` base64 为 `7Zfmql2jakdKgq+z3n6zJPRc6eguQ99OhvCS1Ayo7y88vWyTBqnkdl/9mqLCgF31/fFoFVanY9xRXDGEGIS2lQ==`（与上面的 sha256 是两个摘要，不要混用）。

**签名：未签名。** NSIS 与 `Openscreen.exe` 的 `Get-AuthenticodeSignature` 都是 `NotSigned`，无证书主体。
内部试用可以，对外分发前必须签名，否则 SmartScreen 会拦。

**addon 与源码目录一致 ≠ 可复现构建。** 三个路径同哈希只说明"同一个文件被复制到三处"，
不证明"从源码重新构建会得到同一字节"。

### 5.2 正式包没有启用 `encoder-test-hooks`（三方核对）

| 证据 | 内容 |
|---|---|
| 构建配置 | `scripts/build-windows-compositor-addon.mjs` 的构建命令是 `cargo build -p compositor-view-napi --release`，**没有 `--features`** |
| feature 默认值 | `crates/compositor-view-napi/Cargo.toml` 的 `encoder-test-hooks` 只是"转发"特性；`crates/compositor/Cargo.toml` 的 `default = ["segmentation"]`，**不含 hooks** |
| 行为证据（既有） | 出货 addon 的 61 次验收 0 次重试、0 次注入生效；hooks 只用于另建的注入矩阵 addon（`v23-hooks`/`v231-hooks` 目录），与出货件不是同一份 |
| 字符串（辅助） | 出货 addon 内 `OPENSCREEN_TEST_FAIL_EXPORT_FIRST_FRAME`、`OPENSCREEN_TEST_DEVICE_REMOVED`、`injected_export_first_frame_failure`、`OPENSCREEN_TEST_FAIL_FIRST_FRAME` 命中均为 **0**；修复标记 `appareil D3D11 recréé` 命中 1、`first_frame:` 命中 2 |

结论：正式包**不含**注入代码路径，环境变量无法改变其编码行为。

---

## 6. Git 状态与待推送提交

```
branch            main
HEAD              本报告相关文档提交的最后一条（`git rev-parse HEAD`）
                  其链上：0ed62bc（测试修订）→ d9f7141（报告正文）→ 若干措辞/计数修订
origin/main       1b296da84aeefe13b0386f276d2da5108bdd4ec8
ahead / behind    以 `git rev-list --count origin/main..HEAD` 为准
                  开工时 30；本轮 = 1 个源码文件提交 + 若干纯文档提交（全部未推送）
upstream          fetch: https://github.com/getopenscreen/openscreen.git
                  push : DISABLED-DO-NOT-PUSH-TO-UPSTREAM   ← 仍是禁用状态
受保护未跟踪文件   docs/local-windows-baseline.md
                  playwright.stage3.config.ts
                  tests/e2e/stage3-acceptance.spec.ts
其它未跟踪         2 个快捷方式（OpenScreen 需新版.lnk / OpenScreen-Latest.ps1）
工作区            **无已跟踪修改**；保留上述未跟踪文件
```

**逐项核对 `origin/main..HEAD` 的每一个提交（不是只看最后一条）：**

- 内容全部属于已实施的 OpenScreen 开发范围：导出事务/取消（V2.1.x）、时间轴多选（V2.1）、GPU 设备选择（V2.2/2.2.1）、
  HEVC（V2.3/2.3.1）、长视频与内存（V2.4/2.5）、磁盘混音与临时文件清理（V2.6）、首帧重试（V2.6.1），以及对应报告。
- 改动路径只落在 `src/`、`electron/`、`crates/`、`docs/`、`scripts/`。用
  `git log --name-only origin/main..HEAD` 的 98 条路径过滤 `mp4|png|jpg|exe|dll|node|zip|bin|onnx|gguf|svg…`：**0 命中**。
- 三个受保护文件与两个快捷方式：`git log origin/main..HEAD -- <这些路径>` 为空，**从未被提交**。
- 没有发现未知的并发改动；本轮 diff 只有 2 个 Rust 文件，`git diff --check` 干净，无 CRLF 翻转。
- 历史未被改写：无 squash / rebase / amend / force push；`git add -A` 与 `git clean` 全程未使用。

**判断：可推送 `origin`（全部提交都是本地独立提交、范围一致）。但本轮不执行推送，等明确授权。**
`upstream` 的推送地址仍是 `DISABLED-DO-NOT-PUSH-TO-UPSTREAM`，不要改它。

---

## 7. 是否存在阻止内部试用的问题

**没有阻塞项。** 产品代码没变，安装包与当前源码对应，208/176 已定性为测试过期并修好，
11 条 ffmpeg 失败是环境前置、不影响出货二进制。

唯一需要提前告知试用者的是**未签名**（SmartScreen 提示）和**AMD 设备复位只重试一次**（§9）。

---

## 8. 用户如何启动并使用这一版

### 8.1 启动

- 本机当前**没有安装版**（`%LOCALAPPDATA%\Programs` 无 Openscreen 目录）。
- 想装：双击 `release/v261-build/Openscreen.Setup.2.0.0.exe`（未签名，Windows 会提示"未知发布者"，
  选"更多信息 → 仍要运行"）。
- 不想装：直接跑 `release/v261-build/win-unpacked/Openscreen.exe`（等价的解包版，V2.6.1 的打包验证就是用它做的）。
- 从源码跑：`npm run dev`；若主进程被当成 Node 跑，先 `env -u ELECTRON_RUN_AS_NODE`。

### 8.2 推荐的默认编码设置

| 设置 | 推荐 | 理由（来自界面文案本身） |
|---|---|---|
| 编码设备 | **自动** | "自动选择本机可用的最佳编码器，若都打不开则回退到 CPU"；本机 Auto 解析到 AMD AMF |
| 视频格式 | **H.264**（默认） | "兼容性最好，文件较大"；分发对象都能播 |
| 视频格式（要小文件） | H.265 / HEVC | "文件体积约为一半，需要支持 HEVC 的播放器"；**HEVC 不会回退成 H.264**，选的设备没有 HEVC 编码器时导出会失败 |

**入口**：编辑器右上角应用菜单 → **视频编码设备**（对话框内分两块：「视频编码设备」选 Auto/具体 GPU/CPU，
「视频格式」选 H.264 / H.265）。对话框里的 **测试编码设备** 会真编 1 秒并写临时文件，按钮是唯一能证明"这块卡真能编"的手段；
"未验证"不是故障状态。

### 8.3 CPU HEVC 的尺寸限制

软件 HEVC（`libkvazaar`）要求**宽和高都是 8 的倍数**。`good` 质量档输出 1598×1080，宽度不是 8 的倍数，
因此该工程下 CPU + HEVC 会被设置界面**直接禁用**并说明原因（"软件编码要求宽高都是 8 的倍数 —— 本次导出为 …"）。
这是既有设计，不是本轮的缺陷。

### 8.4 工程保存的实际行为

编辑器把工程写到**应用管理目录**：`<userData>\projects\<id>.openscreen`
（打包版即 `%APPDATA%\openscreen\projects\`，大小写不敏感，也可能显示为 `Openscreen`）。**外部打开的 `.openscreen` 不会被原地覆盖**
（V2.6 观察里源工程 sha256 前后相同）。分享/备份工程时，请从该目录取副本。

### 8.5 配音混音的实际入口

**目前只有 CLI**，编辑器导出对话框里没有配音入口（既有设计，不是本轮移除）：

```
openscreen export <project.openscreen> -o <out.mp4> --codec hevc \
  --audio <voiceover.wav> [--audio-mode mix|replace] [--audio-offset <秒>]
```

- `--audio` 接受 mp3 / wav / m4a；默认 `mix`（叠在录音原声上，底轨 0.4、配音 1.0），`replace` 则替换原声。
- 开发仓库里用 `npx electron . export …`；打包版用 `Openscreen.exe export …`。
- 混音失败会让整次导出失败，且**目标位置的旧文件不变**（事务语义）。

### 8.6 遇到问题要保留什么

1. 托盘图标右键 → **Save Diagnostics**（导出含主进程日志与当前工程状态的诊断文件）。
2. 该工程的副本：`%APPDATA%\openscreen\projects\<id>.openscreen`。
3. 出问题的那个导出目标文件（若还在）与它旁边的 `*.partial-*`（若有残留，说明清理没走到）。
4. 若是编码失败：说明选的是 Auto / 哪块卡 / H.264 还是 HEVC，以及是否手动点过"测试编码设备"。

---

## 9. 仍然保留的限制

### 9.1 已确认的缺陷 / 设计边界

- **AMD（含 Auto 落到 AMD）的 D3D11 设备 removed/reset 只重试一次。** 这是已确认的直接失败机制
  （`0x887A0005` / `0x887A0007`）；**触发设备复位的深层原因没有完全确定**（驱动/电源/负载皆未排除）。
  同一导出连续两次复位仍会明确失败 —— 这是"不无限重试"的设计，不是漏修。
- **手动 NVIDIA / Intel / CPU 不重试**：首帧被拒就是失败，行为与 V2.6 相同。
- **HEVC 不回退 H.264**：选的设备没有 HEVC 编码器时，导出直接失败，不会偷偷改格式。
- **CPU HEVC 受 8 倍数尺寸约束**（§8.3）。
- **CLI 的 `captions` 子命令只吃旧格式工程**（v8 文档会报 not a valid project），属既有行为，本轮未动。
- **开发模式找不到 `whisper-stt-server.exe`**（打包版正常）；开发时想用转写请用打包版或把 STT 二进制放到位。

### 9.2 特定配置限制

- 本机 Auto 解析到 AMF（AMD），所以"Auto + H.264"的输出与"手动 AMD"逐字节相同；换机器会变。
- 设备身份用 PnP 设备树 id 识别（`stableId`），不是句柄；换了卡或驱动重装后可能需要"重新检测"。

### 9.3 未复现事件

- **1 次 `Renderer crashed`**（V2.6.1 第一版 addon 的 AMD H.264 第 3 组，180 s 超时；随后 6 次连跑与最终 61 次均未再出现，
  Windows 事件日志无记录，且无重试日志、无 DXGI 码 —— 不是设备路径）。**仍然只是待观察，不是已修复。**
- 最终出货 addon 的 61 次里**一次设备复位都没出现**，所以"重试路径在最终版上真实救回一次"这件事**没有本轮证据**；
  真实的两次救回来自第一版 addon（重试逻辑相同，只差取消分支的重复释放）。

### 9.4 没有环境、未做的测试

| 项 | 状态 |
|---|---|
| 干净机安装（NSIS 全流程、快捷方式、卸载） | **NOT_RUN** |
| 低内存机器上的导出 | **NOT_RUN** |
| macOS / Linux 编译与运行 | **NOT_RUN**（本轮只改了测试与注释；`*_windows.rs` 之外未编译） |
| Intel QSV | **NOT_RUN**（本机无 Intel GPU） |
| 30 分钟长视频本轮重跑 | **NOT_RUN**（复用 V2.6 的 328.7 s 证据） |
| 重建瞬间的进程内存采样 | **NOT_RUN** |
| 数字签名 / 时间戳 | **未签名**，对外分发前必须补 |

> 表述纪律：61/61 是"这一轮 61 次没有失败"，**不等于永远不会失败**；设备复位仍可能发生。

---

## 10. 复现本报告的核对命令

```bash
# Git
git rev-parse HEAD; git rev-list --left-right --count origin/main...HEAD
git log --name-only --pretty=format: origin/main..HEAD | sort -u

# 布局断言（修订前后各跑一次）
cargo test -p openscreen-compositor --lib layer_cb_matches
cargo test -p openscreen-compositor --lib          # 495 passed / 11 failed（ffmpeg 路径前置）

# 产物
sha256sum release/v261-build/Openscreen.Setup.2.0.0.exe \
          release/v261-build/win-unpacked/resources/app.asar \
          electron/native/bin/win32-x64/compositor_view.node \
          electron/native/bin/win32-x64/ffmpeg-shared.exe

# 包内 bundle 与本地一致
node node_modules/@electron/asar/bin/asar.js extract \
  release/v261-build/win-unpacked/resources/app.asar /tmp/asar-check
sha256sum /tmp/asar-check/dist-electron/main-CTAWBrJk.js dist-electron/main-CTAWBrJk.js
```

> Windows 上跑 Rust 测试需要 MSVC + SDK + LLVM 环境（本机用 `%TEMP%\os-cargo.cmd`：vcvars64 14.29、
> 显式 INCLUDE/LIB 指向 `D:\Windows Kits\10\10.0.22621.0`、`LIBCLANG_PATH=D:\Program Files\LLVM\bin`、
> PATH 含 `electron/native/bin/win32-x64`）。注意 `FFMPEG_DIR` 会被 `build.rs` 读取，别在 `cargo test` 前设它。

---

OPENSCREEN WINDOWS INTERNAL TRIAL = READY

FEATURE DEVELOPMENT = FROZEN

ORIGIN PUSH = AWAITING AUTHORIZATION

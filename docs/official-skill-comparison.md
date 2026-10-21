# 与 Lexmount 官方 skill 的对比

> AI 辅助生成（Claude Code，2026-10-20）。官方部分来自阅读仓库源码和文档，**没有安装或运行**官方 CLI；本项目部分为实测结果。

## 官方有两套同名 `browser-cli`

| | Rust 版 [`browser-cli-rs`](https://github.com/lexmount/browser-cli-rs) | Python 版 [`browser-cli`](https://github.com/lexmount/browser-cli) |
|---|---|---|
| 版本 | 正式发布 v1.2.4（2026-09-21）；main 分支已到 1.3.0，未发布 | v0.3.25，只有 main 分支，没有正式发布 |
| 安装 | `scripts/bootstrap.sh` 下载程序到 skill 目录的 `bin/`，并校验 SHA-256 | `uv tool install` |
| 平台 | **skill 脚本只支持 macOS arm64 和 Windows x64**（见下方说明） | Python ≥ 3.11；文档未限制平台，未验证 Intel Mac |
| 面向 | Claude Code、Codex、CodeBuddy | 主要是 Codex |

**Linux 说明：** Release 里有 `x86_64-unknown-linux-musl` 二进制，但 skill 的 `bootstrap.sh` 和 `doctor.sh` 只放行 `Darwin-arm64`，在 Linux 上会报 `unsupported_platform`。2026-10-20 读源码确认。

官方文档 [browser-cli 指南](https://browser.lexmount.cn/en/docs/guides/browser-cli.mdx) 指向的是 Python 版，其中示例用到 `action page-info`、`open-url --wait-until`，这两个在 Rust v1.2.4 里不存在。

## 官方 Web Fetch CLI

2026-10-21 补充（Claude Code 检索 GitHub 源码，未安装运行）：官方另有独立的 `webfetch-cli`，同样分 Rust 版 [`webfetch-cli-rs`](https://github.com/lexmount/webfetch-cli-rs)（附 `skills/lexmount-webfetch/`）和 Python 版 [`webfetch-cli`](https://github.com/lexmount/webfetch-cli)。

- 命令：`extract (--url|--dom-id) [--format md|text|json|json-full] [--timeout-ms]`、`dump-dom --url [--engine] [--filter-scripts-styles]`、`doctor`、`capabilities`、`auth login --open`。
- 平台：Rust 版发布 macOS arm64、Linux x64（musl）、Windows x64，**没有 Intel Mac**。
- 只调 Web Fetch API，不会失败后升级到云浏览器。

## 功能对比

| 功能 | 官方 Rust v1.2.4 | 官方 Python v0.3.25 | 本项目（`lexmount-fetch`、`lexmount-browser`） |
|---|---|---|---|
| Web Fetch API（不占 Browser hours） | ❌（另有独立的 `webfetch-cli`，见下） | ❌（同左） | ✅ 已实测 |
| 云浏览器抓正文 | ✅（open-url + snapshot/eval） | ✅（extract 等） | ✅ 已实测 |
| Web Fetch 失败自动升级到云浏览器 | — | — | ✅ 已实测 |
| 识别反爬验证页并如实失败 | 未找到 | 未找到 | ✅ 已实测（百度安全验证） |
| 点击、填表、等待、截图、PDF、执行 JS | ✅ | ✅（约 80 个操作命令，含语义定位、弹窗、iframe、上传） | `lexmount-browser`：click / fill / press / select / wait / screenshot / pdf / eval；click、fill、screenshot、pdf、eval 已实测 |
| 多标签页 | ✅（`--target-id`） | ✅ | `lexmount-browser`：`action tabs`、`--tab <index>`，单标签页已实测 |
| 会话管理（续期、列出、关闭、下载文件） | ✅ | ✅ | fetch：每次调用自动建会话、finally 关闭。browser：`session create/info/list/close`，已实测；不做续期、下载文件 |
| 持久化登录态（context） | ✅ 创建、复制、删除、强制解锁，读写或只读 | ✅ | ✅ 用户运行 `login` 保存；agent 用 `--profile` 抓取 |
| 只读 context | ✅ 有参数，但**服务端未实现**（2026-10-21 实测 HTTP 400） | 同左 | ✅ 改为复制 context、读写打开、用完删除，已实测 |
| 人工接管（验证码、扫码） | 规定不关会话；有 inspect_url 字段，用法未写明 | 扫码时打开实时画面让用户操作 | ⚠️ `login --interactive` 在用户本机打开实时画面，**未跑通**；browser 的 `session view` 同样打开实时画面并保留会话，**未实测** |
| 自动过验证码 | ❌（只有 SDK、控制台的会话选项） | ❌ | ❌，不做 |
| 本地隧道 | ❌（1.3.0 才有） | ❌ | ❌ |
| 录制 | 只有开关 | 有开关 | 未开启 |
| 凭据 | `auth login` 浏览器授权，存 `~/.config/lexmount/browser-cli/credentials.json`；或 `LEXMOUNT_*` 环境变量 | 同上，另有 device code、token 刷新 | YAML 配置文件，见 README |
| 域名白名单、禁止路径、只允许 GET | ❌ | ❌ | ✅ fetch 和 browser 都已实测，含服务端重定向；browser 另外拦截非 GET 请求 |
| 敏感操作前确认 | 写在 skill 文档里（付款、发布、删除、改账号前先问） | 同左 | fetch 不提供写操作；browser 写在 SKILL.md 里（付款、发布、删除、改账号前先问），并只在用户明确授权时才解除带登录会话的限制 |
| 凭据和连接地址打码 | ✅（凭据） | ✅ | ✅（账号、密码、api-key、ws 连接地址） |
| 登录失败防锁号 | 未找到 | 未找到 | ✅ 失败后需 `--retry` 才能重试 |
| 平台 | macOS arm64、Windows x64 | 需 Python ≥ 3.11 | 任何能跑 Node ≥ 20 的平台 |

## 定位

- 官方 skill 是「让 agent 操作浏览器」；本项目的 `lexmount-fetch` 是「安全地抓取页面内容」，`lexmount-browser` 用 Node 在官方 CLI 不支持的平台上提供较小的一组交互操作（不含弹窗、上传、下载、语义定位等）。两者不冲突，在官方支持的平台上可以同时安装。
- 安全边界只防误操作和网页中的提示词注入：有完整 shell 权限的 agent 拿到 api-key 和 context ID，仍能绕过脚本使用登录态。

## 已知问题

- **带登录抓取尚未跑通。** 用北交大 MIS 测试时，登录页已换成 `sso.bjtu.edu.cn`，表单在 iframe 里，还接入了腾讯验证码；加了 iframe 定位后仍在填写阶段超时，根因未确定。
- 远程 MCP（`browser.lexmount.cn/chatgpt-app/mcp`、`/chatgpt-app-webfetch/mcp`）的工具清单，文档里没找到；未认证访问返回 401。

## 来源

- Rust skill：https://github.com/lexmount/browser-cli-rs/tree/main/skills/lexmount-browser（`SKILL.md`、`scripts/bootstrap.sh`、`scripts/doctor.sh`、`references/authentication.md`）
- Rust v1.2.4 命令：https://github.com/lexmount/browser-cli-rs/blob/v1.2.4/src/main.rs
- Python 版：https://github.com/lexmount/browser-cli（`README.md`、`SKILL.md`）
- 文档：https://browser.lexmount.cn/en/docs/guides/browser-cli.mdx 、https://browser.lexmount.cn/en/docs/guides/session-lifecycle.mdx 、https://browser.lexmount.cn/en/docs/guides/contexts.mdx 、https://browser.lexmount.cn/en/docs/capability-faq.mdx
- Web Fetch API：https://browser.lexmount.cn/docs/webfetch/quickstart 、https://browser.lexmount.cn/docs/webfetch/reference/all-in-one-extract 、https://browser.lexmount.cn/docs/webfetch/reference/dump-dom 、https://browser.lexmount.cn/docs/webfetch/reference/common-errors
- Web Fetch CLI：https://github.com/lexmount/webfetch-cli-rs 、https://github.com/lexmount/webfetch-cli

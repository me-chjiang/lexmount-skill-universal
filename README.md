# lexmount-skill-universal
一个skill，在不支持的平台 (如macOS amd64) 上使用 lexmount 的 api 实现web fetch 和 cloud browser 操作

纯 Node 实现，Claude Code、Codex、opencode 都能用。

> AI 辅助生成（Claude Code）。

## 包含的 skill

| skill | 作用 |
|---|---|
| [`lexmount-fetch`](skills/lexmount-fetch/SKILL.md) | 抓取网页正文，输出 markdown，可替代内置 WebFetch。先走 Web Fetch API，失败、正文过短或遇到反爬验证页时再升级到云浏览器；也支持在用户预先登录好的 profile 下只读抓取。 |
| [`lexmount-browser`](skills/lexmount-browser/SKILL.md) | 用云浏览器做交互操作：打开页面、无障碍快照、点击、填写、等待、截图、PDF、多标签页、会话管理。带登录的会话使用登录态副本（操作不写回），默认受 allow-hosts / deny-paths 限制且只放行 GET，用户明确授权后可解除；验证码、扫码可用 `session view` 让用户接管。 |

各功能是否已实测、和官方 skill 有什么区别，见 [docs/official-skill-comparison.md](docs/official-skill-comparison.md)。

## 安装

```bash
git clone https://github.com/me-chjiang/lexmount-skill-universal.git ~/lexmount-skill-universal
cd ~/lexmount-skill-universal && npm ci     # Node ≥ 20；只通过 CDP 连云浏览器，不需要下载本地浏览器

# 按需链接到各 agent 的 skill 目录
ln -s ~/lexmount-skill-universal/skills/lexmount-fetch ~/.claude/skills/lexmount-fetch   # Claude Code，opencode 也会读取
ln -s ~/lexmount-skill-universal/skills/lexmount-browser ~/.claude/skills/lexmount-browser
ln -s ~/lexmount-skill-universal/skills/lexmount-fetch ~/.codex/skills/lexmount-fetch    # Codex
ln -s ~/lexmount-skill-universal/skills/lexmount-browser ~/.codex/skills/lexmount-browser
```

Node 解析依赖时会先跟随符号链接找到真实路径，所以依赖只需在仓库根目录安装一次。两个 skill 共用仓库根目录的 `lib/`，同样靠这一点找到，所以**必须用符号链接安装**；把单个 skill 目录复制出去会找不到 `lib/` 和依赖。

## 配置

```bash
mkdir -p ~/.config/lexmount
cp lexmount-config.example.yaml ~/.config/lexmount/config.yaml && chmod 600 ~/.config/lexmount/config.yaml
```

脚本按以下顺序查找配置，找到第一个即停：

1. 环境变量 `LEXMOUNT_CONFIG` 指向的文件
2. 从当前目录向上查找 `lexmount-config.yaml`
3. `~/.config/lexmount/config.yaml`

也可以不写配置文件，改用环境变量 `LEXMOUNT_API_KEY`、`LEXMOUNT_PROJECT_ID`、`LEXMOUNT_BASE_URL`（名称与官方 SDK 一致）。配置文件里已填的值优先；需要登录的 profile 只能写在配置文件里。

配置文件包含 API key 和站点账号，不要提交、不要粘贴到对话中。

## 冒烟测试

```bash
node skills/lexmount-fetch/fetch.mjs https://example.com --max-chars 200
```

这条命令会消耗 1 次 Web Fetch 额度。输出中「方式」一行显示 `Lexmount Web Fetch` 即为接通。

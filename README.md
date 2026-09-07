# pi-footer-styler

自定义 [pi](https://github.com/earendil-works/pi-coding-agent) 底部状态栏的扩展插件。

## 效果

替换 pi 默认底栏，三行布局：

```
zhipu/glm-5.3-flash • high                          [其他扩展状态]
~/projects/pi-footer-styler (master ↑1 ↓2 *3)
↑1.2k ↓3.4k │ ¥0.123 │ ctx 85k/200k (42%) │ cache 84k (99%)
```

- **第一行**：模型名（dim 色）；模型支持推理时追加 `• 思考等级`（关闭时显示 `thinking off`）；有其他扩展状态时右对齐展示
- **第二行**：当前路径（home 目录缩写为 `~`，超宽时保留尾部左侧截断）；在仓库内时括号内显示 git 分支（accent 色，detached 显示短 hash），不在仓库内则无括号；分支后可跟状态计数（dim 色）：`↑1` 领先 upstream、`↓2` 落后 upstream、`*3` 未提交变更数（含未跟踪），**为 0 的段自动隐藏**，全为 0 时仅显示分支名
- **第三行**：token 用量（↑ 输入 ↓ 输出）· 累计花费（货币符号可配）· 上下文用量 · 缓存命中率
  - **ctx**：`已用 token/窗口上限 (百分比)`，如 `ctx 85k/200k (42%)`；**>90% 红**、**>70% 黄**；压缩后下次响应前未知时显示 `ctx ?/200k`
  - **cache**：`命中量 (命中率)`，如 `cache 84k (99%)`——最近一次请求从缓存读取的 token 数与命中率（`cacheRead / (input+cacheRead+cacheWrite)`），provider 上报过缓存数据即常显；**<50% 黄色警示**（如缓存失效、前缀变动），正常为 muted 色。注：激进缓存的 provider（如 zhipu 自动缓存）命中率会饱和到 100%，属正常现象，以 token 量为主要参考
  - token 格式化与 pi 默认 footer 同口径（<10k 一位小数，如 `1.2k`；更大取整，如 `85k`）
  - 统计口径与 pi 默认 footer 一致：assistant 与 toolResult 的 usage 都计入，压缩/分支摘要条目的 usage 也计入
- 模型切换、思考等级切换、git 分支切换、token 累加均实时刷新

## git 分支检测（git.ts）

扩展内置了独立于 pi 的后台分支探测器，采用三级回退：

```
自身后台探测 → pi 内置 footerData.getGitBranch() → no git
```

探测逻辑：
- 从会话 cwd **逐层向上**查找 `.git`（支持子目录启动）
- 兼容 `.git` 为文件的场景（worktree / submodule，解析 `gitdir:` 相对/绝对路径）
- 解析 `HEAD`：`ref: refs/heads/X` → 分支名；裸 hash → `detached:短hash`（pi 内置只显示 detached）
- 实时性：监听 **HEAD 所在目录**而非文件本身（git 原子写 rename 覆盖会更换 inode），分支切换即时触发重绘
- 全异步（`fs/promises`），不阻塞启动与渲染；watcher 随 footer 生命周期自动启停

**ahead / behind / 未提交计数**：后台异步调用 `git status --porcelain=v1 -b -z`（单次拿全三项），刷新时机：启动、分支切换、每轮 agent 结束（turn_end / agent_end）、低频兑底轮询（10s，捕捉终端里的手动提交）；带去重合并与 5s 超时，git 未安装 / 非仓库时静默降级为仅显示分支名

## 命令

| 命令 | 说明 |
|------|------|
| `/footer` | 自定义底栏 ↔ 默认底栏 切换 |
| `/footer on` / `/footer off` | 显式开启 / 关闭 |
| `/footer list` | 列出支持的货币 |
| `/footer <code\|symbol>` | 设置费用单位，如 `/footer cny`、`/footer ¥`、`/footer eur`（持久化） |

## 费用货币单位

支持按代码或符号设置，内置注册表（`currency.ts`）：

```
usd $ · cny ¥ · eur € · gbp £ · jpy ¥ · krw ₩ · hkd HK$ · twd NT$ · sgd S$ · inr ₹ · rub ₽ · chf CHF
```

- 拓展新货币：在 `currency.ts` 的 `CURRENCIES` 中加一条即可（支持 `position: "suffix"` 后缀样式）
- 选择持久化到 `~/.pi/agent/pi-footer-styler.json`，重启后保留
- **注意**：仅切换展示符号，金额仍是 pi 基于模型计费价目算出的数值（美元口径），不做汇率换算

## 安装

### 方式一：pi 包管理器（推荐）

```bash
# 从 npm 安装
pi install npm:pi-footer-styler

# 或从 GitHub 安装
pi install git:github.com/ducaoya/pi-footer-styler
```

安装后自动启用，无需其他配置；更新用 `pi update npm:pi-footer-styler`。

### 方式二：快速试一下

```bash
pi -e npm:pi-footer-styler
```

### 方式三：手动复制（开发者）

把本目录复制（或软链接）到 pi 全局扩展目录：

```bash
# PowerShell
Copy-Item -Recurse pi-footer-styler "$env:USERPROFILE\.pi\agent\extensions\pi-footer-styler"
```

或复制到当前项目的 `.pi/extensions/` 下（需项目受信任）。

> 使用 `/reload` 可在修改代码后热重载。

## 依赖

无。运行时依赖（`@earendil-works/pi-ai`、`@earendil-works/pi-tui`）由 pi 宿主自动解析。

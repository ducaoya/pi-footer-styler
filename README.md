# pi-footer-styler

自定义 [pi](https://github.com/earendil-works/pi-coding-agent) 底部状态栏的扩展插件。

## 效果

替换 pi 默认底栏，三行布局：

```
zhipu/glm-5.3-flash • high                          [其他扩展状态]
~/projects/pi-footer-styler (master ↑1 ↓2 *3)
↑1.2k ↓3.4k │ ¥0.123 │ ctx 85k/200k (42%) │ cache 84k (99.8%) │ 87 tok/s
↑137k ↓123k │ ¥26.80 (+¥24.85) │ ctx ?/1.0M │ cache 239k (99.9%)
```

第二个示例是「新会话继承了历史会话花费」的形态：`¥26.80` 是总花费，`(+¥24.85)` 是 parentSession 链上历史会话的部分。

- **第一行**：模型名（dim 色）；模型支持推理时追加 `• 思考等级`（关闭时显示 `thinking off`）；有其他扩展状态时右对齐展示
- **第二行**：当前路径（home 目录缩写为 `~`，超宽时保留尾部左侧截断）；在仓库内时括号内显示 git 分支（accent 色，detached 显示短 hash），不在仓库内则无括号；分支后可跟状态计数（dim 色）：`↑1` 领先 upstream、`↓2` 落后 upstream、`*3` 未提交变更数（含未跟踪），**为 0 的段自动隐藏**，全为 0 时仅显示分支名
- **第三行**：token 用量（↑ 输入 ↓ 输出）· 累计花费（货币符号可配）· 上下文用量 · 缓存命中率 · 生成速度
  - **cost**：默认显示**跨会话累计**总花费，如 `¥26.80 (+¥24.85)`——`¥26.80` = 当前会话 + 历史会话，括号里是历史会话（parentSession 链）的部分。
    当前会话部分按**整份会话文件**统计（`getEntries()`，与 pi 默认 footer 同口径）：压缩只追加 compaction 条目，**压缩前的历史条目仍在文件里，因此压缩不会清零**；
    而 plan-mode 的「在新会话里实现」、`/handoff`、`/fork`、`/clone` 会**新建会话文件**，费用天然从 0 起算，此时由 parentSession 链补上历史花费。
    关闭该行为：`/footer chain off`（只统计当前会话）
  - **ctx**：`已用 token/窗口上限 (百分比)`，如 `ctx 85k/200k (42%)`；**>90% 红**、**>70% 黄**；压缩后下次响应前未知时显示 `ctx ?/200k`
  - **cache**：`命中量 (命中率)`，如 `cache 84k (99.8%)`——最近一次请求从缓存读取的 token 数与命中率（`cacheRead / (input+cacheRead+cacheWrite)`，一位小数），provider 上报过缓存数据即常显；**<50% 黄色警示**（如缓存失效、前缀变动），正常为 muted 色。注：zhipu 等自动缓存命中率通常在 95~99.9%，偶发 0% 多为缓存前缀失效（如系统提示词变化）后的全价请求
  - **生成速度**：`87 tok/s`——**最近一次助手响应的输出速率（tokens per second）估算**，只展示「量 + 单位」（不加 `speed` 前缀，符合最主流状态栏表述）。`message_start` 记录请求起点，首个流式增量（text / thinking / toolcall delta）到达时作为生成起点以**剔除首 token 延迟（TTFT）**，`message_end` 用真实 `usage.output` 结算；含思考 token（`output` 本身已包含 reasoning）。切换模型后清空（旧数值不再代表当前模型）
  - token 格式化与 pi 默认 footer 同口径（<10k 一位小数，如 `1.2k`；更大取整，如 `85k`）；输出速率 >=100 取整、>=10 一位小数、其余两位小数
  - 统计口径与 pi 默认 footer 一致：`assistant` 与 `toolResult` 的 usage 都计入，`usage` 条目（缓存预热等）与压缩/分支摘要条目的 usage 也计入；token 与 cache 只统计当前会话，仅**花费**跨会话累加
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

## 跨会话花费累计（history.ts）

pi 有多个入口会**新建会话文件**并把旧会话记进新会话 header 的 `parentSession`：

- plan-mode 的 fresh implementation（「在新会话里实现计划」）、`/handoff`
- `/fork`、`/clone`，以及任何调用 `ctx.newSession({ parentSession })` 的场景

这些场景下当前会话的费用是 0（新会话），看起来像「压缩把费用清零」。本扩展沿 `parentSession` 链向上读取历史会话的 usage，把总花费显示为
`当前会话 + 历史会话`，历史部分用 `(+¥x)` 标出。

- 只累加**花费**；token（↑/↓）、cache、ctx 仍只反映当前会话
- 解析结果按「文件路径 + mtime + size」缓存：5.9MB 历史会话首次解析约 40ms，之后每帧仅 stat（<1ms）
- 文件缺失 / 损坏 / 成环（含指回当前会话）时安全降级，只显示已读到的部分
- 深度上限 16 层，足够覆盖常见的 fresh / handoff 链

## 命令

| 命令 | 说明 |
|------|------|
| `/footer` | 自定义底栏 ↔ 默认底栏 切换 |
| `/footer on` / `/footer off` | 显式开启 / 关闭 |
| `/footer list` | 列出支持的货币 |
| `/footer chain on` / `/footer chain off` | 开启 / 关闭跨会话（parentSession 链）累计花费（持久化，默认开） |
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

## 发布（维护者）

采用 **npm Trusted Publishing（OIDC）**，无需任何长期 token；由 GitHub Actions 在满足条件时自动发布（`.github/workflows/publish.yml`）。

**触发条件**（同时满足）：
1. 代码推送到 `master` 分支
2. 该次推送的**最新一条提交的主题（首行）以 `[release]` 开头**（仅匹配主题，避免正文提及关键字误触发）

```bash
# 发版（自动 bump 版本 + 生成提交与 vX.Y.Z tag）
npm version patch -m "[release] %s"   # 或 minor / major
git push origin master --follow-tags
```

随后 Actions 会自动：升级 npm → 校验版本未发布 → `npm publish --provenance`。

> **首次配置（仅一次）**：npm 包页 → Settings → Trusted Publisher → GitHub Actions，填 `ducaoya` / `pi-footer-styler` / `publish.yml`。
> 若同一版本已存在于 npm，workflow 会自动跳过，不会报错。

## 依赖

无。运行时依赖（`@earendil-works/pi-ai`、`@earendil-works/pi-tui`）由 pi 宿主自动解析。

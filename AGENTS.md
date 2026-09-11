# AGENTS.md — pi-footer-styler 维护者须知

> 面向自动化 agent 的项目上下文。用户可见的说明见 `README.md`。

## 项目是什么

pi（pi-coding-agent）的底栏扩展，替换 pi 默认 footer，显示：模型/思考等级、路径、git 分支、
token 用量、累计花费、上下文占用、缓存命中率、生成速度（tok/s）。以 **pi package** 形式发布到 npm。

## 文件职责

| 文件 | 职责 |
|------|------|
| `index.ts` | 扩展入口：事件订阅、footer 渲染、`/footer` 命令 |
| `config.ts` | 本地配置读写（`~/.pi/agent/pi-footer-styler.json`），自带 `getAgentDir` 以免 import pi barrel |
| `currency.ts` | 费用货币注册表（代码/符号 → 展示）|
| `git.ts` | 独立后台 git 分支/状态探测器（与 pi 内置互为回退）|
| `.github/workflows/publish.yml` | npm 自动发布（Trusted Publishing / OIDC）|

无构建步骤、无测试框架、无运行时依赖（peer deps 由 pi 宿主解析）。

## 本地开发

```bash
# 以本地路径接入（不复制源码），改完 /reload 即生效
pi install /absolute/path/to/pi-footer-styler
pi remove  /absolute/path/to/pi-footer-styler   # 切回 npm 版
pi install npm:pi-footer-styler
```

- pi 以 `jiti(moduleCache: false)` 加载扩展，`/reload` 会重新读盘，无需重启。
- 语法自检（无 tsc 时）：`node --experimental-strip-types --check index.ts`。
- 快速验证渲染（不依赖 TUI）：用 mock 驱动 `index.ts` 默认导出——伪造 `pi.on` 捕获事件处理器、
  伪造 `ExtensionContext`，再调用 footer 工厂拿到的 `render(width)`。可用 jiti 从 pi 的
  `node_modules` 加载 TS。**注意**：`git.ts` 的 watcher 会挂住事件循环，脚本结尾需 `process.exit(0)`。

## 发布（重要，务必遵守）

- 采用 **npm Trusted Publishing（OIDC）**，由 GitHub Actions 发布，**仓库内与本机不保存任何长期 token**。
- 触发条件：push 到 `master` **且**最新提交的**主题（首行）以 `[release]` 开头**
  （workflow 用 `startsWith` 匹配主题，避免正文/文档提到关键字误触发）。
- 发版命令：

  ```bash
  npm version patch -m "[release] %s"      # 或 minor / major，自动 bump + 生成 vX.Y.Z tag
  git push origin master --follow-tags
  ```

- 一次性配置（npm 网页，代码无法代做）：包页 → Settings → Trusted Publisher → GitHub Actions，
  填 `ducaoya` / `pi-footer-styler` / `publish.yml`。
- workflow 行为：升级 npm → 查重（该版本已存在则跳过）→ `npm publish --provenance`；带并发锁。

### 禁忌

- ❌ 不要 `npm config set //registry.npmjs.org/:_authToken=...`（凭据不入 `~/.npmrc` 常驻）。
- ❌ 不要把 token 提交进仓库或粘贴进对话；仓库保持无 `.npmrc`。
- ❌ 不要给普通提交用 `[release]` 开头的主题（会触发发布）。

## 约定

- 缩进用 **Tab**；注释/文档用**中文**；commit 用英文，前缀 `feat:` / `fix:` / `perf:` / `ui:` / `ci:` / `docs:`。
- 修改用户可见行为时，**同步更新 `README.md`**（效果示例、字段说明、命令表）。
- `package.json` 的 `files` 决定发布内容，新增源文件需同步加入。
- 保持 `peerDependencies` 且不打包 peer deps。

# pi-footer-styler

自定义 [pi](https://github.com/earendil-works/pi-coding-agent) 底部状态栏的扩展插件。

## 效果

替换 pi 默认底栏，两行布局：

```
zhipu/glm-5.3-flash                    [其他扩展状态]
main │ ↑1.2k ↓3.4k │ $0.123
```

- **第一行**：模型名（左，dim 色）；有其他扩展状态时右对齐展示
- **第二行**：git 分支（accent 色）· token 用量（↑ 输入 ↓ 输出，自动 k/M 格式化）· 累计花费
- 无 git 仓库时显示 `no git`；模型切换、分支切换、token 累加均实时刷新

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

## 命令

| 命令 | 说明 |
|------|------|
| `/footer` | 自定义底栏 ↔ 默认底栏 切换 |
| `/footer on` / `/footer off` | 显式开启 / 关闭 |

## 安装

### 方式一：全局启用（推荐）

把本目录复制（或软链接）到 pi 全局扩展目录：

```bash
# PowerShell
Copy-Item -Recurse pi-footer-styler "$env:USERPROFILE\.pi\agent\extensions\pi-footer-styler"
```

### 方式二：项目级启用

复制到当前项目的 `.pi/extensions/` 下（需项目受信任）。

### 方式三：快速测试

```bash
pi -e ./pi-footer-styler/index.ts
```

> 使用 `/reload` 可在修改代码后热重载。

## 依赖

无。运行时依赖（`@earendil-works/pi-ai`、`@earendil-works/pi-tui`）由 pi 宿主自动解析。

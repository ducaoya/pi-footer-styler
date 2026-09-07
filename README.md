# pi-footer-styler

自定义 [pi](https://github.com/earendil-works/pi-coding-agent) 底部状态栏的扩展插件。

## 效果

替换 pi 默认底栏，单行左右布局：

```
main │ ↑1.2k ↓3.4k │ $0.123                    openai-codex
```

- **左**：git 分支（accent 色）· token 用量（↑ 输入 ↓ 输出，自动 k/M 格式化）· 累计花费
- **右**：其他扩展注册的状态 · 当前模型名（dim 色）
- 无 git 仓库时显示 `no git`；模型切换、分支切换、token 累加均实时刷新

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

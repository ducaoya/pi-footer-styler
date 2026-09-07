/**
 * pi-footer-styler — 自定义 pi 底部状态栏
 *
 * 显示内容（两行）：
 *   第一行：模型名（左）    [其他扩展状态（右）]
 *   第二行：git 分支 · token 用量（↑输入 ↓输出） · 累计花费
 *
 * git 分支：后台异步逐层向上探测（git.ts），与 pi 内置 FooterDataProvider 互为回退：
 *   自身探测 → footerData.getGitBranch() → no git
 *
 * 命令：
 *   /footer          切换自定义底栏 <-> 默认底栏
 *   /footer on|off   显式开启 / 关闭
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GitBranchWatcher, type GitState } from "./git";

// ---- 模块级状态（跨 session_start 保持） ----
let enabled = true;
let currentModelId: string | undefined;

// ---- 格式化工具 ----

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

// ---- 从当前会话分支统计 token 与花费 ----

function computeUsage(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			if (m.usage) {
				input += m.usage.input ?? 0;
				output += m.usage.output ?? 0;
				cost += m.usage.cost?.total ?? 0;
			}
		}
	}
	return { input, output, cost };
}

// ---- 渲染分支元素：自身探测 → pi 内置 → no git ----

function renderBranch(
	theme: Theme,
	gitState: GitState | null,
	builtinBranch: string | null | undefined,
): string {
	if (gitState) {
		return gitState.kind === "branch"
			? theme.fg("accent", gitState.name)
			: theme.fg("dim", `detached:${gitState.hash}`);
	}
	if (builtinBranch && builtinBranch !== "detached") {
		return theme.fg("accent", builtinBranch);
	}
	if (builtinBranch === "detached") return theme.fg("dim", "detached");
	return theme.fg("dim", "no git");
}

export default function (pi: ExtensionAPI) {
	// 用最新 ctx 安装自定义底栏（session 切换 / reload 后需重新安装）
	const applyFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			// git 分支变化时触发重绘（pi 内置检测）
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			// 独立后台探测：逐层向上查找 .git 并监听 HEAD（异步，不阻塞）
			// 每个 footer 实例持有自己的 watcher，dispose 只停自己的，避免会话切换竞态
			const watcher = new GitBranchWatcher(ctx.cwd, () => tui.requestRender());
			void watcher.start();

			return {
				dispose() {
					unsub();
					watcher.stop();
				},
				invalidate() {},
				render(width: number): string[] {
					const { input, output, cost } = computeUsage(ctx);
					const lines: string[] = [];

					// 第一行：模型名（左） + 其他扩展状态（右，若存在）
					const model = theme.fg(
						"dim",
						currentModelId ?? ctx.model?.id ?? "no model",
					);
					const statuses: string[] = [];
					for (const s of footerData.getExtensionStatuses().values()) {
						if (s) statuses.push(s);
					}
					const right = statuses.join(" ");
					if (right) {
						const avail = Math.max(0, width - visibleWidth(right) - 1);
						const leftFitted = truncateToWidth(model, avail);
						const gap = Math.max(
							1,
							width - visibleWidth(leftFitted) - visibleWidth(right),
						);
						lines.push(leftFitted + " ".repeat(gap) + right);
					} else {
						lines.push(truncateToWidth(model, width));
					}

					// 第二行：分支 · token · 花费
					const branchEl = renderBranch(
						theme,
						watcher.getState(),
						footerData.getGitBranch(),
					);
					const parts = [
						branchEl,
						theme.fg("muted", `↑${fmtTokens(input)} ↓${fmtTokens(output)}`),
						theme.fg("muted", fmtCost(cost)),
					];
					lines.push(truncateToWidth(parts.join(theme.fg("dim", " │ ")), width));

					return lines;
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		currentModelId = ctx.model?.id;
		if (enabled && ctx.mode === "tui") applyFooter(ctx);
	});

	// 切换模型时实时刷新模型名（ctx.model 是普通属性，需自行跟踪）
	pi.on("model_select", async (event) => {
		currentModelId = event.model.id;
	});

	pi.registerCommand("footer", {
		description: "Toggle custom footer (branch | tokens | cost | model)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			enabled = arg === "on" ? true : arg === "off" ? false : !enabled;

			if (ctx.mode !== "tui") {
				ctx.ui.notify(`Custom footer ${enabled ? "enabled" : "disabled"}`, "info");
				return;
			}

			if (enabled) {
				applyFooter(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}

/**
 * pi-footer-styler — 自定义 pi 底部状态栏
 *
 * 显示内容（左 → 右）：
 *   git 分支 · token 用量（↑输入 ↓输出） · 累计花费    [扩展状态]  模型名
 *
 * 命令：
 *   /footer          切换自定义底栏 <-> 默认底栏
 *   /footer on|off   显式开启 / 关闭
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

export default function (pi: ExtensionAPI) {
	// 用最新 ctx 安装自定义底栏（session 切换 / reload 后需重新安装）
	const applyFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			// git 分支变化时触发重绘
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const { input, output, cost } = computeUsage(ctx);

					// 左侧：分支 · token · 花费
					const branch = footerData.getGitBranch();
					const leftParts: string[] = [
						branch ? theme.fg("accent", branch) : theme.fg("dim", "no git"),
						theme.fg("muted", `↑${fmtTokens(input)} ↓${fmtTokens(output)}`),
						theme.fg("muted", fmtCost(cost)),
					];
					const left = leftParts.join(theme.fg("dim", " │ "));

					// 右侧：其他扩展的状态 + 模型名
					const rightParts: string[] = [];
					for (const s of footerData.getExtensionStatuses().values()) {
						if (s) rightParts.push(s);
					}
					rightParts.push(theme.fg("dim", currentModelId ?? ctx.model?.id ?? "no model"));

					// 左右对齐；空间不足时优先截断左侧
					const right = rightParts.join(" ");
					const avail = Math.max(0, width - visibleWidth(right) - 1);
					const leftFitted = truncateToWidth(left, avail);
					const gap = Math.max(1, width - visibleWidth(leftFitted) - visibleWidth(right));
					return [leftFitted + " ".repeat(gap) + right];
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

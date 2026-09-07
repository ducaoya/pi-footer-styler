/**
 * pi-footer-styler — 自定义 pi 底部状态栏
 *
 * 显示内容（三行）：
 *   第一行：模型名 • 思考等级（左）    [其他扩展状态（右）]
 *   第二行：当前路径（git 分支）
 *   第三行：token 用量（↑输入 ↓输出） · 累计花费（货币符号可配） · 上下文占用 ctx% · 缓存低命中警示
 *
 *   ctx%：来自 ctx.getContextUsage()，>90% 红（error）、>70% 黄（warning），压缩后未知时显示 "ctx ?"
 *   cache：最近一次请求的缓存命中率（cacheRead/(input+cacheRead+cacheWrite)），仅 <50% 时显示（正常不占空间），
 *          且要求会话 ≥2 条带 usage 的回复 + 累计出现过缓存 token（排除首轮未预热与不上报缓存的 provider）
 *
 * git 分支：后台异步逐层向上探测（git.ts），与 pi 内置 FooterDataProvider 互为回退：
 *   自身探测 → footerData.getGitBranch() → no git
 *
 * 思考等级：跟踪 ctx.thinkingLevel + thinking_level_select 事件，兼容运行时 "off" 与 undefined
 * 费用单位：/footer <code|symbol> 切换（currency.ts 注册表），持久化到 ~/.pi/agent/pi-footer-styler.json
 *
 * 命令：
 *   /footer                切换自定义底栏 <-> 默认底栏
 *   /footer on|off         显式开启 / 关闭
 *   /footer list           列出支持的货币
 *   /footer <code|symbol>  设置费用单位（如 cny、¥、eur）
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { loadConfig, saveConfig } from "./config";
import {
	DEFAULT_CURRENCY,
	formatCost,
	listCurrencies,
	resolveCurrency,
	type CurrencyDef,
} from "./currency";
import { GitBranchWatcher, type GitState } from "./git";

// ---- 模块级状态（跨 session_start 保持） ----
let enabled = true;
/** 当前模型摘要（model_select 时刷新；ctx.model 是普通属性，需自行跟踪） */
let currentModel: { id: string; reasoning: boolean } | undefined;
/** 当前思考等级（兼容运行时 "off" 字符串与 undefined 两种关闭形态） */
let currentThinkingLevel: string | undefined;
/** 费用展示货币（启动时从配置文件读取） */
let currency: CurrencyDef = resolveCurrency(loadConfig().currency ?? "") ?? DEFAULT_CURRENCY;
/** 当前 footer 实例的重绘函数；gen 守卫防止旧实例 dispose 误清新实例 */
let requestRender: (() => void) | null = null;
let footerGen = 0;

// ---- 格式化工具 ----

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

// ---- 从当前会话分支统计 token / 花费 / 缓存（口径与 pi 默认 footer 一致） ----

interface UsageStats {
	input: number;
	output: number;
	cost: number;
	/** 累计缓存 token（cacheRead + cacheWrite），0 表示 provider 从未上报缓存数据 */
	cacheTokens: number;
	/** 最近一次请求的缓存命中率（%），无可计算数据时为 null */
	latestCacheHitRate: number | null;
	/** 携带 usage 的 assistant 消息数（缓存预热判断用） */
	usageMessages: number;
}

function computeUsage(ctx: ExtensionContext): UsageStats {
	let input = 0;
	let output = 0;
	let cost = 0;
	let cacheTokens = 0;
	let usageMessages = 0;
	let latestCacheHitRate: number | null = null;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message") {
			if (e.message.role !== "assistant" && e.message.role !== "toolResult") continue;
			// assistant / toolResult 两种角色都携带 usage（默认 footer 同样统计二者）
			const m = e.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cost += u.cost?.total ?? 0;
			cacheTokens += (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			if (e.message.role === "assistant") {
				usageMessages++;
				const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				if (prompt > 0) {
					latestCacheHitRate = ((u.cacheRead ?? 0) / prompt) * 100;
				}
			}
		} else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
			const u = e.usage;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cost += u.cost?.total ?? 0;
			cacheTokens += (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		}
	}
	return { input, output, cost, cacheTokens, latestCacheHitRate, usageMessages };
}

// ---- 渲染分支：自身探测 → pi 内置 → 无（返回 null 时不显示括号） ----

interface BranchInfo {
	/** 纯文本分支名（用于宽度计算与括号内展示） */
	name: string;
	/** 着色后的分支名（用于渲染） */
	colored: string;
}

function resolveBranch(
	theme: Theme,
	gitState: GitState | null,
	builtinBranch: string | null | undefined,
): BranchInfo | null {
	if (gitState) {
		return gitState.kind === "branch"
			? { name: gitState.name, colored: theme.fg("accent", gitState.name) }
			: {
					name: `detached:${gitState.hash}`,
					colored: theme.fg("dim", `detached:${gitState.hash}`),
				};
	}
	if (builtinBranch && builtinBranch !== "detached") {
		return { name: builtinBranch, colored: theme.fg("accent", builtinBranch) };
	}
	if (builtinBranch === "detached") {
		return { name: "detached", colored: theme.fg("dim", "detached") };
	}
	return null;
}

// ---- 路径展示：home 缩写 + 超宽时保留尾部的左截断 ----

function shortenHome(p: string): string {
	const home = homedir();
	if (p === home) return "~";
	if (p.startsWith(home)) {
		const rest = p.slice(home.length);
		if (rest.startsWith("\\") || rest.startsWith("/")) return `~${rest}`;
	}
	return p;
}

/** 超宽时从左侧丢弃、以 … 开头（保留最深层级）；s 需为纯文本 */
function leftTruncate(s: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(s) <= maxWidth) return s;
	let out = s;
	while (out.length > 0 && visibleWidth(`…${out}`) > maxWidth) {
		out = out.slice(1);
	}
	return out ? `…${out}` : "…";
}

export default function (pi: ExtensionAPI) {
	// 用最新 ctx 安装自定义底栏（session 切换 / reload 后需重新安装）
	const applyFooter = (ctx: ExtensionContext) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const gen = ++footerGen;
			requestRender = () => tui.requestRender();

			// git 分支变化时触发重绘（pi 内置检测）
			const unsub = footerData.onBranchChange(() => requestRender?.());

			// 独立后台探测：逐层向上查找 .git 并监听 HEAD（异步，不阻塞）
			// 每个 footer 实例持有自己的 watcher，dispose 只停自己的，避免会话切换竞态
			const watcher = new GitBranchWatcher(ctx.cwd, () => requestRender?.());
			void watcher.start();

			return {
				dispose() {
					unsub();
					watcher.stop();
					if (gen === footerGen) requestRender = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const stats = computeUsage(ctx);
					const lines: string[] = [];

					// 第一行：模型名 • 思考等级（左） + 其他扩展状态（右，若存在）
					// 对齐 pi 默认 footer 风格：仅模型支持推理时展示等级，off 显示 "thinking off"
					const modelId = currentModel?.id ?? ctx.model?.id ?? "no model";
					const supportsReasoning = currentModel?.reasoning ?? ctx.model?.reasoning ?? false;
					const lvl = currentThinkingLevel ?? "off";
					const modelText = supportsReasoning
						? `${modelId} • ${lvl === "off" ? "thinking off" : lvl}`
						: modelId;
					const model = theme.fg("dim", modelText);
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

					// 第二行：当前路径（git 分支）
					const branchInfo = resolveBranch(
						theme,
						watcher.getState(),
						footerData.getGitBranch(),
					);
					if (branchInfo) {
						const suffixPlain = ` (${branchInfo.name})`;
						const budget = Math.max(0, width - visibleWidth(suffixPlain) - 1);
						const p = leftTruncate(shortenHome(ctx.cwd), budget);
						lines.push(
							theme.fg("muted", p) +
								theme.fg("dim", " (") +
								branchInfo.colored +
								theme.fg("dim", ")"),
						);
					} else {
						lines.push(
							theme.fg("muted", leftTruncate(shortenHome(ctx.cwd), Math.max(0, width - 1))),
						);
					}

					// 第三行：token · 花费 · 上下文占用 · 缓存低命中警示
					const parts = [
						theme.fg("muted", `↑${fmtTokens(stats.input)} ↓${fmtTokens(stats.output)}`),
						theme.fg("muted", formatCost(stats.cost, currency)),
					];

					// ctx：上下文窗口占用（口径同默认 footer：一位小数；>90% error、>70% warning）
					// 压缩后、下次响应前 percent 未知，显示 "ctx ?"
					const ctxUsage = ctx.getContextUsage();
					if (ctxUsage && ctxUsage.percent != null) {
						const color = ctxUsage.percent > 90 ? "error" : ctxUsage.percent > 70 ? "warning" : "muted";
						parts.push(theme.fg(color, `ctx ${ctxUsage.percent.toFixed(1)}%`));
					} else if (ctxUsage) {
						parts.push(theme.fg("dim", "ctx ?"));
					}

					// cache：最近一次请求的缓存命中率，仅异常（<50%）时显示
					// 门槛：累计出现过缓存 token（排除不上报缓存的 provider）+ ≥2 条带 usage 的回复（排除首轮未预热）
					if (
						stats.cacheTokens > 0 &&
						stats.usageMessages >= 2 &&
						stats.latestCacheHitRate != null &&
						stats.latestCacheHitRate < 50
					) {
						parts.push(theme.fg("warning", `cache ${Math.round(stats.latestCacheHitRate)}%`));
					}

					lines.push(truncateToWidth(parts.join(theme.fg("dim", " │ ")), width));

					return lines;
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		currentModel = ctx.model ? { id: ctx.model.id, reasoning: ctx.model.reasoning } : undefined;
		currentThinkingLevel = ctx.thinkingLevel;
		if (enabled && ctx.mode === "tui") applyFooter(ctx);
	});

	// 切换模型时实时刷新模型名与推理能力标记（ctx.model 是普通属性，需自行跟踪）
	pi.on("model_select", async (event) => {
		currentModel = { id: event.model.id, reasoning: event.model.reasoning };
		requestRender?.();
	});

	// 思考等级变化时刷新（运行时 level 可能为 "off"，类型标注不含）
	pi.on("thinking_level_select", async (event) => {
		currentThinkingLevel = event.level;
		requestRender?.();
	});

	// usage / 上下文变化后刷新（流式期间 TUI 随消息更新自行重绘，这里兜底收尾时刻）
	pi.on("turn_end", async () => requestRender?.());
	pi.on("agent_end", async () => requestRender?.());
	pi.on("session_compact", async () => requestRender?.());

	pi.registerCommand("footer", {
		description: "Toggle custom footer; set cost currency (e.g. /footer cny)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const arg = raw.toLowerCase();
			const [head, ...rest] = raw.split(/\s+/);
			const headLower = (head ?? "").toLowerCase();

			if (!raw) {
				enabled = !enabled;
			} else if (arg === "on" || arg === "off") {
				enabled = arg === "on";
			} else if (headLower === "list" || headLower === "units") {
				ctx.ui.notify(`Supported currencies: ${listCurrencies()}`, "info");
				return;
			} else {
				// /footer currency cny 或 /footer cny /footer ¥
				const input = headLower === "currency" ? rest.join(" ") : raw;
				const next = input ? resolveCurrency(input) : null;
				if (!next) {
					ctx.ui.notify(
						`Unknown arg "${raw}". Usage: /footer [on|off|list|<code|symbol>]`,
						"warning",
						);
					return;
				}
				currency = next;
				saveConfig({ currency: next.code });
				requestRender?.();
				ctx.ui.notify(`Cost unit: ${next.symbol} (${next.name})`, "info");
				return;
			}

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

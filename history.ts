/**
 * history.ts — 跨会话用量累计（parentSession 链）
 *
 * 背景：pi 新建会话的路径都会把旧会话写进新会话 header 的 parentSession：
 *   - plan-mode 的 fresh implementation（"在新会话里实现计划"）
 *   - /handoff、/new（带 parentSession）、/fork
 * 这些场景下当前会话的费用天然从 0 起算，看起来像"压缩清零"，实际是换了会话文件。
 *
 * 本模块沿 parentSession 链向上读取历史会话的 usage，给出「祖先会话累计用量」，
 * 供 footer 显示为总花费（当前会话 + 历史会话）。
 *
 * 性能：footer 每帧都可能 render，因此按「文件路径 + mtime + size」缓存解析结果；
 * 只 stat 一次即可命中缓存，文件不变不会重复解析。
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface UsageTotals {
	input: number;
	output: number;
	/** 累计花费（pi 以计费价目算出的数值，展示货币只换符号） */
	cost: number;
	/** 累计缓存 token（cacheRead + cacheWrite），0 表示 provider 从未上报缓存数据 */
	cacheTokens: number;
	/** 最近一次请求的缓存命中率（%），无可计算数据时为 null */
	latestCacheHitRate: number | null;
	/** 最近一次请求从缓存读取的 token 数，无可计算数据时为 null */
	latestCacheRead: number | null;
}

export function createTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cost: 0,
		cacheTokens: 0,
		latestCacheHitRate: null,
		latestCacheRead: null,
	};
}

/** 只累加数值字段；latest* 保留 base（当前会话）的值，不被历史会话污染 */
export function addTotals(base: UsageTotals, add: UsageTotals): UsageTotals {
	base.input += add.input;
	base.output += add.output;
	base.cost += add.cost;
	base.cacheTokens += add.cacheTokens;
	return base;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number } | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

/**
 * 取出条目里参与统计的 usage（口径与 pi 默认 footer 一致）：
 *   - message: assistant / toolResult
 *   - usage:   不进入模型上下文的用量（缓存预热等）
 *   - compaction / branch_summary: 摘要请求本身的用量
 * 其余条目（user 消息、model_change、label…）返回 null。
 */
function usageOf(entry: unknown): { usage: UsageLike; isAssistant: boolean } | null {
	if (!isRecord(entry)) return null;
	const type = entry.type;
	if (type === "message") {
		const message = entry.message;
		if (!isRecord(message)) return null;
		const role = message.role;
		if (role !== "assistant" && role !== "toolResult") return null;
		if (!isRecord(message.usage)) return null;
		return { usage: message.usage as UsageLike, isAssistant: role === "assistant" };
	}
	if (type === "usage") {
		if (!isRecord(entry.usage)) return null;
		return { usage: entry.usage as UsageLike, isAssistant: false };
	}
	if ((type === "compaction" || type === "branch_summary") && isRecord(entry.usage)) {
		return { usage: entry.usage as UsageLike, isAssistant: false };
	}
	return null;
}

/** 把条目数组里的用量累加进 totals（当前会话与历史会话共用同一口径） */
export function accumulateEntries(totals: UsageTotals, entries: readonly unknown[]): UsageTotals {
	for (const entry of entries) {
		const found = usageOf(entry);
		if (!found) continue;
		const u = found.usage;
		totals.input += u.input ?? 0;
		totals.output += u.output ?? 0;
		totals.cost += u.cost?.total ?? 0;
		totals.cacheTokens += (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (found.isAssistant) {
			const cacheRead = u.cacheRead ?? 0;
			totals.latestCacheRead = cacheRead;
			const prompt = (u.input ?? 0) + cacheRead + (u.cacheWrite ?? 0);
			totals.latestCacheHitRate = prompt > 0 ? (cacheRead / prompt) * 100 : null;
		}
	}
	return totals;
}

interface SessionFileUsage {
	totals: UsageTotals;
	parentSession: string | undefined;
}

interface CacheEntry extends SessionFileUsage {
	mtimeMs: number;
	size: number;
}

const cache = new Map<string, CacheEntry>();

/** 解析单个会话文件：累加 usage + 取 header.parentSession（结果按 mtime/size 缓存） */
function readSessionFileUsage(file: string): SessionFileUsage | null {
	let mtimeMs: number;
	let size: number;
	try {
		const st = statSync(file);
		mtimeMs = st.mtimeMs;
		size = st.size;
	} catch {
		cache.delete(file);
		return null;
	}

	const cached = cache.get(file);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;

	const totals = createTotals();
	let parentSession: string | undefined;
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(trimmed);
			} catch {
				continue; // 半行/损坏行跳过，不影响其它条目
			}
			if (isRecord(entry) && entry.type === "session" && typeof entry.parentSession === "string") {
				parentSession = entry.parentSession;
				continue;
			}
			accumulateEntries(totals, [entry]);
		}
	} catch {
		return null;
	}

	const result: CacheEntry = { totals, parentSession, mtimeMs, size };
	cache.set(file, result);
	return result;
}

/** parentSession 链深度上限（防御异常/自引用） */
const MAX_DEPTH = 16;

/**
 * 沿 parentSession 链读取所有祖先会话的累计用量（不含当前会话）。
 * 文件缺失/损坏/成环/指回当前会话时提前返回已读到的部分。
 */
export function readAncestorUsage(
	parentSession: string | undefined,
	exclude?: string | null,
): UsageTotals {
	const totals = createTotals();
	const visited = new Set<string>();
	if (exclude) {
		try {
			visited.add(resolve(exclude));
		} catch {
			// 路径不可解析时忽略
		}
	}
	let current: string | undefined = parentSession;

	for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
		let key: string;
		try {
			key = resolve(current);
		} catch {
			break;
		}
		if (visited.has(key)) break;
		visited.add(key);

		const info = readSessionFileUsage(key);
		if (!info) break;
		addTotals(totals, info.totals);
		current = info.parentSession;
	}
	return totals;
}

/**
 * config.ts — 扩展本地配置（持久化到 ~/.pi/agent/pi-footer-styler.json）
 *
 * 性能说明：pi 以 jiti(moduleCache: false) 加载扩展，扩展运行时 import 的每个模块
 * 都会被完整重新实例化——import pi-coding-agent 的 barrel 需 ~100ms+。
 * 因此这里本地实现 getAgentDir（与 pi config.js 逻辑一致：
 * env PI_CODING_AGENT_DIR → tilde 展开 → ~/.pi/agent），避免拖入整个 barrel。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface FooterConfig {
	/** 费用货币代码，如 "cny" */
	currency?: string;
}

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const CONFIG_DIR_NAME = ".pi";

/** 与 pi-coding-agent getAgentDir() 行为一致（env 覆盖 → ~/.pi/agent） */
function resolveAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		const expanded = envDir.startsWith("~")
			? join(homedir(), envDir.slice(1))
			: envDir;
		return isAbsolute(expanded) ? expanded : join(homedir(), expanded);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

const configPath = join(resolveAgentDir(), "pi-footer-styler.json");

export function loadConfig(): FooterConfig {
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as FooterConfig;
		return typeof raw === "object" && raw !== null ? raw : {};
	} catch {
		return {};
	}
}

export function saveConfig(config: FooterConfig): void {
	try {
		writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	} catch {
		// 写失败不致命（只影响下次启动的默认值）
	}
}

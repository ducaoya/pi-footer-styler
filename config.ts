/**
 * config.ts — 扩展本地配置（持久化到 ~/.pi/agent/pi-footer-styler.json）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface FooterConfig {
	/** 费用货币代码，如 "cny" */
	currency?: string;
}

const configPath = join(getAgentDir(), "pi-footer-styler.json");

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

/**
 * currency.ts — 费用展示单位（货币符号）注册表
 *
 * 仅切换展示符号，金额仍是 pi 基于计费价目算出的数值（默认美元口径），不做汇率换算。
 * 拓展新货币：在 CURRENCIES 中加一条即可，代码/符号均可被 /footer 识别。
 */

export interface CurrencyDef {
	/** 小写代码，如 "cny" */
	code: string;
	/** 展示符号，如 "¥" */
	symbol: string;
	/** 货币全名（用于命令回显） */
	name: string;
	/** 符号位置 */
	position: "prefix" | "suffix";
}

export const DEFAULT_CURRENCY: CurrencyDef = {
	code: "usd",
	symbol: "$",
	name: "US Dollar",
	position: "prefix",
};

export const CURRENCIES: readonly CurrencyDef[] = [
	DEFAULT_CURRENCY,
	{ code: "cny", symbol: "¥", name: "Chinese Yuan", position: "prefix" },
	{ code: "eur", symbol: "€", name: "Euro", position: "prefix" },
	{ code: "gbp", symbol: "£", name: "British Pound", position: "prefix" },
	{ code: "jpy", symbol: "¥", name: "Japanese Yen", position: "prefix" },
	{ code: "krw", symbol: "₩", name: "South Korean Won", position: "prefix" },
	{ code: "hkd", symbol: "HK$", name: "Hong Kong Dollar", position: "prefix" },
	{ code: "twd", symbol: "NT$", name: "New Taiwan Dollar", position: "prefix" },
	{ code: "sgd", symbol: "S$", name: "Singapore Dollar", position: "prefix" },
	{ code: "inr", symbol: "₹", name: "Indian Rupee", position: "prefix" },
	{ code: "rub", symbol: "₽", name: "Russian Ruble", position: "prefix" },
	{ code: "chf", symbol: "CHF", name: "Swiss Franc", position: "suffix" },
];

/** 按代码或符号解析货币（大小写不敏感）；不匹配返回 null */
export function resolveCurrency(input: string): CurrencyDef | null {
	const s = input.trim().toLowerCase();
	if (!s) return null;
	return CURRENCIES.find((c) => c.code === s) ?? CURRENCIES.find((c) => c.symbol.toLowerCase() === s) ?? null;
}

/** 金额 + 位数格式化（0 → "0"；<1 → 3 位小数；其余 2 位） */
function formatDigits(amount: number): string {
	if (amount === 0) return "0";
	if (amount < 1) return amount.toFixed(3);
	return amount.toFixed(2);
}

/** 按货币定义格式化费用 */
export function formatCost(amount: number, currency: CurrencyDef): string {
	const digits = formatDigits(amount);
	return currency.position === "suffix" ? `${digits} ${currency.symbol}` : `${currency.symbol}${digits}`;
}

/** 生成货币清单文案（命令回显用） */
export function listCurrencies(): string {
	return CURRENCIES.map((c) => `${c.code} ${c.symbol}`).join(" · ");
}

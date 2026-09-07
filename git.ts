/**
 * git.ts — 独立的 git 分支后台探测（不依赖 pi 内置 FooterDataProvider）
 *
 * - 逐层向上查找 .git（目录或 worktree/submodule 的 gitdir 文件）
 * - 解析 HEAD：分支名 / detached 短 hash
 * - 监听 HEAD 所在目录（git 原子写会 rename 覆盖 HEAD，监听文件本身会因 inode 变化失效）
 * - 分支领先/落后/未提交数：后台异步调 git CLI（git status --porcelain -b -z），
 *   变化时触发 onChange；git 不可用时静默降级（仅显示分支名）
 */

import { spawn } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 当前 git 状态：分支名，或 detached HEAD（短 hash） */
export type GitState =
	| { kind: "branch"; name: string }
	| { kind: "detached"; hash: string };

/** 分支相对 upstream 的状态；各项为 0 时由渲染层隐藏 */
export interface GitStatus {
	/** 领先 upstream 的提交数（无 upstream 时为 0） */
	ahead: number;
	/** 落后 upstream 的提交数（无 upstream / upstream 已删时为 0） */
	behind: number;
	/** 未提交变更文件数（含未跟踪） */
	dirty: number;
}

const HEAD_REF_PREFIX = "ref: refs/heads/";
const HASH_RE = /^[0-9a-f]{7,40}$/i;

/** 逐层向上查找包含 .git 的目录；找不到返回 null */
async function findGitRoot(startDir: string): Promise<string | null> {
	let dir = resolve(startDir);
	for (;;) {
		try {
			const st = await stat(join(dir, ".git"));
			if (st.isDirectory() || st.isFile()) return dir;
		} catch {
			// 当前层无 .git，继续向上
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // 到达文件系统根
		dir = parent;
	}
}

/** 解析真实 gitDir：.git 为目录直接用；为文件时读 "gitdir: ..."（支持相对路径） */
async function resolveGitDir(repoRoot: string): Promise<string | null> {
	const dotGit = join(repoRoot, ".git");
	try {
		const st = await stat(dotGit);
		if (st.isDirectory()) return dotGit;
		const content = await readFile(dotGit, "utf8");
		const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
		if (!m?.[1]) return null;
		const p = m[1];
		return isAbsolute(p) ? p : resolve(repoRoot, p);
	} catch {
		return null;
	}
}

/** 解析 HEAD 内容；解析不出（异常/空仓库）返回 null */
async function readHead(gitDir: string): Promise<GitState | null> {
	try {
		const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
		if (head.startsWith(HEAD_REF_PREFIX)) {
			const name = head.slice(HEAD_REF_PREFIX.length);
			return name ? { kind: "branch", name } : null;
		}
		if (HASH_RE.test(head)) {
			return { kind: "detached", hash: head.slice(0, 7) };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * 通过 git CLI 获取 ahead/behind/未提交数。
 * 单次调用同时拿全三项；git 不可用、超时或非仓库时返回 null。
 */
async function fetchGitStatus(cwd: string): Promise<GitStatus | null> {
	try {
		const stdout = await new Promise<string>((done, fail) => {
			const child = spawn(
				"git",
				["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"],
				{ cwd, windowsHide: true, timeout: 5000, killSignal: "SIGKILL" },
			);
			let out = "";
			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString("utf8");
			});
			child.on("error", fail); // git 未安装等
			child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`exit ${code}`))));
		});

		const segments = stdout.split("\0");
		const status: GitStatus = { ahead: 0, behind: 0, dirty: 0 };
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i];
			if (!seg) continue;
			if (seg.startsWith("## ")) {
				// 分支头：## main...origin/main [ahead 1, behind 2]；[gone] = upstream 已删
				const bracket = /\[([^\]]+)\]/.exec(seg);
				if (!bracket || bracket[1] === "gone") continue;
				for (const part of bracket[1].split(",")) {
					const m = /^\s*(ahead|behind)\s+(\d+)\s*$/.exec(part);
					if (!m) continue;
					if (m[1] === "ahead") status.ahead = Number(m[2]);
					else status.behind = Number(m[2]);
				}
				continue;
			}
			// 变更条目：XY PATH；rename/copy 条目后跟一个额外的 ORIG_PATH 段，需跳过
			status.dirty++;
			const code = seg.slice(0, 2);
			if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i++;
		}
		return status;
	} catch {
		return null;
	}
}

/**
 * 后台 git 分支探测器。
 * start() 异步执行（不阻塞调用方）；结果变化时触发 onChange（用于 requestRender）。
 * 分支领先/落后/未提交数：启动、分支切换、外部 refreshStatus() 调用及低频轮询时更新。
 */
export class GitBranchWatcher {
	private readonly cwd: string;
	private readonly onChange: () => void;
	private dirWatcher: FSWatcher | null = null;
	private state: GitState | null = null;
	private status: GitStatus | null = null;
	private statusInFlight = false;
	private statusPending = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private stopped = false;

	constructor(cwd: string, onChange: () => void) {
		this.cwd = cwd;
		this.onChange = onChange;
	}

	/** 当前探测结果；尚未完成或不在仓库内时为 null */
	getState(): GitState | null {
		return this.state;
	}

	/** 当前 ahead/behind/未提交数；不可用（无 git / 非仓库 / 未完成）时为 null */
	getStatus(): GitStatus | null {
		return this.status;
	}

	/** 后台启动探测并开始监听 */
	async start(): Promise<void> {
		this.state = null;
		this.status = null;
		const root = await findGitRoot(this.cwd);
		if (this.stopped) return;
		if (!root) return;
		const gitDir = await resolveGitDir(root);
		if (this.stopped) return;
		if (!gitDir) return;

		this.state = await readHead(gitDir);
		void this.refreshStatus();
		this.onChange();

		// 监听 HEAD 所在目录而非文件本身（git 原子写 rename 覆盖会更换 inode）
		try {
			this.dirWatcher = watch(
				dirname(join(gitDir, "HEAD")),
				{ persistent: false },
				(_event, filename) => {
					if (this.stopped) return;
					if (filename && filename !== "HEAD") return;
					void this.refresh(gitDir);
				},
			);
			this.dirWatcher.on("error", () => {
				// 监听失败（如目录被删除）：保留最后一次结果，静默降级
			});
		} catch {
			// 无法监听时退化为静态值
		}

		// 低频兜底轮询：捕捉终端/编辑器里的手动提交、文件改动等（agent 事件之外的场景）
		this.pollTimer = setInterval(() => {
			if (!this.stopped) void this.refreshStatus();
		}, 10_000);
	}

	private async refresh(gitDir: string): Promise<void> {
		const next = await readHead(gitDir);
		if (this.stopped) return;
		this.state = next;
		// 分支切换后 upstream 通常随之变化，顺手刷新 status
		void this.refreshStatus();
		this.onChange();
	}

	/** 请求刷新 ahead/behind/未提交数（异步、去重；结果变化时触发 onChange） */
	refreshStatus(): void {
		if (this.stopped || this.statusInFlight) {
			this.statusPending = true;
			return;
		}
		this.statusInFlight = true;
		void fetchGitStatus(this.cwd)
			.then((next) => {
				this.statusInFlight = false;
				if (this.stopped) return;
				const prev = this.status;
				const changed =
					!prev || !next || prev.ahead !== next.ahead || prev.behind !== next.behind || prev.dirty !== next.dirty;
				this.status = next;
				if (changed) this.onChange();
				if (this.statusPending) {
					this.statusPending = false;
					this.refreshStatus();
				}
			})
			.catch(() => {
				this.statusInFlight = false;
			});
	}

	/** 停止监听并释放资源（幂等） */
	stop(): void {
		this.stopped = true;
		this.dirWatcher?.close();
		this.dirWatcher = null;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}

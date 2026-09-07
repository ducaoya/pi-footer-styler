/**
 * git.ts — 独立的 git 分支后台探测（不依赖 pi 内置 FooterDataProvider）
 *
 * - 逐层向上查找 .git（目录或 worktree/submodule 的 gitdir 文件）
 * - 解析 HEAD：分支名 / detached 短 hash
 * - 监听 HEAD 所在目录（git 原子写会 rename 覆盖 HEAD，监听文件本身会因 inode 变化失效）
 */

import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 当前 git 状态：分支名，或 detached HEAD（短 hash） */
export type GitState =
	| { kind: "branch"; name: string }
	| { kind: "detached"; hash: string };

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
 * 后台 git 分支探测器。
 * start() 异步执行（不阻塞调用方）；结果变化时触发 onChange（用于 requestRender）。
 */
export class GitBranchWatcher {
	private readonly cwd: string;
	private readonly onChange: () => void;
	private dirWatcher: FSWatcher | null = null;
	private state: GitState | null = null;
	private stopped = false;

	constructor(cwd: string, onChange: () => void) {
		this.cwd = cwd;
		this.onChange = onChange;
	}

	/** 当前探测结果；尚未完成或不在仓库内时为 null */
	getState(): GitState | null {
		return this.state;
	}

	/** 后台启动探测并开始监听 */
	async start(): Promise<void> {
		this.state = null;
		const root = await findGitRoot(this.cwd);
		if (this.stopped) return;
		if (!root) return;
		const gitDir = await resolveGitDir(root);
		if (this.stopped) return;
		if (!gitDir) return;

		this.state = await readHead(gitDir);
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
	}

	private async refresh(gitDir: string): Promise<void> {
		const next = await readHead(gitDir);
		if (this.stopped) return;
		this.state = next;
		this.onChange();
	}

	/** 停止监听并释放资源（幂等） */
	stop(): void {
		this.stopped = true;
		this.dirWatcher?.close();
		this.dirWatcher = null;
	}
}

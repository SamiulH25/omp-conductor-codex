// Worker guard for omp-conductor (a Pi extension, loaded with `pi -e`).
// 1. Blocks repeating a read/search whose answer is already in context (file unchanged since).
// 2. Once per run: if files were changed but nothing was run afterwards, asks the worker to verify before it reports.
// 3. With PI_SNAPSHOT_DIR set (workers with no git worktree): saves each file's original before its first edit/write,
//    so the supervisor can diff a directory that has no git history.
// 4. A multi-edit `edit` call fails as a whole when one oldText does not match. The edits that do match are applied and
//    the result names the ones that were not, so the worker retries only those instead of patching with python/sed.
// 5. Worktree workers (PI_MAIN_ROOT / PI_WORK_ROOT set): any path or shell command that points at the original repo is
//    redirected into the worker's own worktree, so a brief that names the main repo's absolute path cannot make the
//    worker edit the main tree.
// 6. Once per run: if the task asked for a SUMMARY:/FINDINGS: block and the final reply lacks it, asks for it.
// 7. PI_CHECKS_REQUIRED (toolbox checks run with the plugin's `check` command): once per run, if files were changed and
//    a required check was not run after the last change, asks for exactly those `check <name>` runs before the report.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const MARK = "[guard]";
const SEARCH = new Set(["grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
	const reads = new Map<string, string>(); // path|range -> file signature when last read
	const searches = new Map<string, number>(); // call key -> mutation counter when last run
	let mutations = 0;
	let edited = false; // changed files with no command run since
	let taskText = "";
	let nudgedVerify = false;
	let nudgedReport = false;
	let nudgedChecks = false;
	const required = (process.env.PI_CHECKS_REQUIRED ?? "").split(",").filter(Boolean);
	const checkedAt = new Map<string, number>(); // check name -> edit counter when it was last run
	let edits = 0; // edit/write calls this run
	let lastEdit = 0;
	const CHECK_RE = /(?:^|[\s;&|(])check\s+([\w.-]+)/g;

	const sig = (p: string) => {
		try {
			const s = statSync(p);
			return `${s.mtimeMs}:${s.size}`;
		} catch {
			return "";
		}
	};

	const MAIN = (process.env.PI_MAIN_ROOT ?? "").replace(/\/+$/, "");
	const WORK = (process.env.PI_WORK_ROOT ?? "").replace(/\/+$/, "");
	const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const mainRe = MAIN ? new RegExp(`${esc(MAIN)}(?=/|\\s|$|["'])`, "g") : undefined;
	const remap = (abs: string) => (MAIN && WORK && (abs === MAIN || abs.startsWith(`${MAIN}/`)) ? `${WORK}${abs.slice(MAIN.length)}` : abs);
	const notes = new Map<string, string>(); // toolCallId -> text appended to that edit's result
	const snapped = new Set<string>();
	const snapshot = (abs: string) => {
		const dir = process.env.PI_SNAPSHOT_DIR;
		if (!dir || snapped.has(abs)) return;
		snapped.add(abs);
		try {
			mkdirSync(dir, { recursive: true });
			let orig = "";
			if (existsSync(abs)) {
				orig = `${dir}/${snapped.size}.orig`;
				copyFileSync(abs, orig);
			}
			appendFileSync(`${dir}/manifest.jsonl`, `${JSON.stringify({ path: abs, orig })}\n`);
		} catch {
			// best effort: a failed snapshot must never block the worker
		}
	};

	pi.on("before_agent_start", async (event: any) => {
		const prompt = String(event.prompt ?? "");
		if (prompt.startsWith(MARK)) return; // our own nudge: same run
		taskText = prompt;
		nudgedVerify = false;
		nudgedReport = false;
		nudgedChecks = false;
		edited = false;
		edits = 0;
		lastEdit = 0;
		checkedAt.clear();
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		const name = String(event.toolName);
		const input = (event.input ?? {}) as Record<string, any>;
		if (MAIN && WORK) {
			let moved = "";
			if (typeof input.path === "string") {
				const abs = resolve(ctx.cwd ?? process.cwd(), input.path);
				const to = remap(abs);
				if (to !== abs) {
					input.path = to;
					moved = `${abs} -> ${to}`;
				}
			}
			if (name === "bash" && typeof input.command === "string" && mainRe && mainRe.test(input.command)) {
				mainRe.lastIndex = 0;
				input.command = input.command.replace(mainRe, WORK);
				moved = moved || "command paths";
			}
			if (moved) notes.set(String(event.toolCallId), `${MARK} redirected into your private worktree (${moved}). Your working directory ${WORK} is a worktree of ${MAIN}: use relative paths and never write under ${MAIN}.`);
		}
		if (name === "read" && typeof input.path === "string") {
			const abs = resolve(ctx.cwd ?? process.cwd(), input.path);
			const key = `${abs}|${input.offset ?? ""}|${input.limit ?? ""}`;
			const s = sig(abs);
			if (s && reads.get(key) === s) {
				return { block: true, reason: `${MARK} already read ${input.path} (unchanged since): use what is in your context, or read a different range.` };
			}
			if (s) reads.set(key, s);
		} else if (SEARCH.has(name)) {
			const key = JSON.stringify([name, input]);
			if (searches.get(key) === mutations) {
				return { block: true, reason: `${MARK} already ran this ${name} and nothing changed since: use the earlier result.` };
			}
			searches.set(key, mutations);
		} else if (name === "edit" || name === "write") {
			if (typeof input.path === "string") snapshot(resolve(ctx.cwd ?? process.cwd(), input.path));
			if (name === "edit" && typeof input.path === "string" && Array.isArray(input.edits) && input.edits.length > 1) {
				try {
					const text = readFileSync(resolve(ctx.cwd ?? process.cwd(), input.path), "utf8");
					const good: any[] = [];
					const bad: string[] = [];
					input.edits.forEach((e: any, i: number) => {
						const old = String(e?.oldText ?? "");
						const n = old ? text.split(old).length - 1 : 0;
						if (n === 1) good.push(e);
						else bad.push(`edits[${i}] (${n === 0 ? "oldText not found" : `oldText matches ${n} places`}: ${JSON.stringify(old.slice(0, 60))})`);
					});
					if (good.length && bad.length) {
						input.edits = good;
						notes.set(String(event.toolCallId), `${notes.get(String(event.toolCallId)) ? `${notes.get(String(event.toolCallId))}\n` : ""}${MARK} ${good.length} edit(s) applied. NOT applied: ${bad.join("; ")}. Re-read the lines around each, then resend only those edits with an oldText copied exactly (long enough to be unique). Do not switch to python/sed.`);
					}
				} catch {
					// unreadable file: let the edit tool report it
				}
			}
			mutations++;
			edited = true;
			lastEdit = ++edits;
		} else if (name === "bash") {
			mutations++;
			edited = false; // something was run after the last change
			if (typeof input.command === "string") {
				for (const m of input.command.matchAll(CHECK_RE)) {
					for (const n of m[1] === "all" ? required : [m[1]]) checkedAt.set(n, edits);
				}
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event: any) => {
		const note = notes.get(String(event.toolCallId));
		if (!note) return undefined;
		notes.delete(String(event.toolCallId));
		return { content: [...(event.content ?? []), { type: "text", text: note }] };
	});

	pi.on("agent_end", async (event: any) => {
		const msgs: any[] = event.messages ?? [];
		const last = [...msgs].reverse().find((m) => m.role === "assistant");
		if (!last || last.stopReason === "error" || last.stopReason === "aborted") return;
		const text = (last.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
		const stale = required.filter((n) => (checkedAt.get(n) ?? -1) < lastEdit);
		if (edits > 0 && stale.length && !nudgedChecks) {
			nudgedChecks = true;
			nudgedVerify = true; // this is the verify request, with the exact commands
			pi.sendUserMessage(`${MARK} Your supervisor requires these toolbox checks after your last edit, and they have not run since: ${stale.map((n) => `\`check ${n}\``).join(", ")}. Run them now (they are allowed and lock-safe with other workers), fix what your change broke, then give your final report. If one cannot run, quote its error lines in the report.`, { deliverAs: "followUp" });
			return;
		}
		if (edited && !nudgedVerify) {
			nudgedVerify = true;
			pi.sendUserMessage(`${MARK} You changed files but ran nothing afterwards. Run the check the task names (or the project's tests) now, fix anything it shows, then give your final report. If no check exists, say so.`, { deliverAs: "followUp" });
			return;
		}
		const want = /\bSUMMARY:|\bFINDINGS:/.exec(taskText)?.[0];
		if (want && !nudgedReport && !new RegExp(`(^|\\n)[#*\\s]*${want}`).test(text)) {
			nudgedReport = true;
			pi.sendUserMessage(`${MARK} Your last reply is missing the required ${want} block. Reply again with only that block.`, { deliverAs: "followUp" });
		}
	});
}

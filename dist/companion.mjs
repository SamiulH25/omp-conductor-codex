// src/companion.ts
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/panel.ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
async function readPanels(dataDir, panelId) {
  const root2 = join(dataDir, "panels");
  const groups = panelId ? [panelId] : await readdir(root2).catch(() => []);
  const result = [];
  for (const group of groups) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(group)) continue;
    const dir = join(root2, group);
    const names = await readdir(dir).catch(() => []);
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const value2 = JSON.parse(await readFile(join(dir, name), "utf8"));
        if (value2.version === 1 && value2.panelId === group && typeof value2.sessionId === "string" && Array.isArray(value2.workers) && value2.ledger) result.push(value2);
      } catch {
      }
    }
  }
  return result.sort((a, b) => b.at - a.at);
}
var clean = (text) => String(text ?? "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
var widthOf = (ch) => new RegExp("\\p{Mark}", "u").test(ch) ? 0 : new RegExp("[\\u1100-\\u115f\\u2329\\u232a\\u2e80-\\ua4cf\\uac00-\\ud7a3\\uf900-\\ufaff\\ufe10-\\ufe6f\\uff00-\\uff60\\uffe0-\\uffe6]|\\p{Extended_Pictographic}", "u").test(ch) ? 2 : 1;
function fit(text, width) {
  const chars = Array.from(clean(text)), total = chars.reduce((n, ch) => n + widthOf(ch), 0);
  if (total <= width) return chars.join("");
  let used = 0, out = "";
  for (const ch of chars) {
    const size = widthOf(ch);
    if (used + size > width - 1) break;
    out += ch;
    used += size;
  }
  return out + "~";
}
var count = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
var money = (n) => n > 0 ? `$${n.toFixed(n >= 1 ? 2 : 4)}` : "plan";
var elapsed = (w, now) => {
  const sec = Math.max(0, Math.floor(((w.endedAt ?? now) - w.startedAt) / 1e3));
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
};
var palette = { running: "\x1B[36m", done: "\x1B[32m", failed: "\x1B[31m", killed: "\x1B[90m" };
function renderPanel(snapshots, options) {
  const width = Math.max(8, options.width), now = options.now ?? Date.now(), frame = options.frame ?? 0;
  const line = (s) => fit(s, width);
  const output = [line("PI CONDUCTOR"), line("Workers beside Codex"), "-".repeat(Math.min(width, 44))];
  if (!snapshots.length) return [...output, "", line("Waiting for Codex..."), "", line("Ask Codex to use Pi Conductor."), line("Worker activity appears here."), "", line("q close panel  |  j/k scroll")];
  const live = snapshots.filter((s) => !s.closed && now - s.at < 5e3);
  const recent = snapshots.filter((s) => live.includes(s) || now - s.at < 60 * 6e4).slice(0, 12);
  if (!recent.length) return [...output, "", line("No recent sessions."), line("Launch: conductor -- -C PROJECT")];
  const all = recent.flatMap((s) => s.workers);
  const running = live.flatMap((s) => s.workers).filter((w) => w.state === "running").length;
  const total = recent.reduce((sum, s) => ({ tokens: sum.tokens + s.ledger.tokens, cost: sum.cost + s.ledger.cost }), { tokens: 0, cost: 0 });
  output.push(line(`${running} running / ${all.length} workers`), line(`${count(total.tokens)} tokens  |  ${money(total.cost)}`), line(`${live.length ? "LIVE" : "OFFLINE - saved state"}  |  ${new Date(recent[0].at).toLocaleTimeString()}`), "");
  for (const snapshot of recent) {
    output.push(line(`Model: ${snapshot.model.split("/").at(-1)}`), line(`Effort: ${snapshot.effort}`));
    if (!snapshot.workers.length) output.push(line("Ready. No workers yet."), "");
    for (let i = 0; i < snapshot.workers.length; i++) {
      const w = snapshot.workers[i], stale = snapshot.closed || now - snapshot.at >= 5e3;
      const state = w.state === "running" && stale ? "interrupted" : w.state;
      const eyes = state === "done" ? "^ ^" : state === "failed" ? "x x" : state === "killed" || state === "interrupted" ? "- -" : w.act === "edit" ? "> <" : w.act === "bash" ? "O O" : frame % 16 === 0 ? "- -" : "o o";
      const face = ["(", "[", "{", "<"][i % 4] + eyes + [")", "]", "}", ">"][i % 4];
      const spin = state === "running" ? "|/-\\"[frame % 4] : state === "done" ? "+" : "!";
      const title = line(`${face} ${spin} ${w.id} ${w.agent} / ${state}`);
      output.push(options.color ? `${palette[state] ?? "\x1B[90m"}${title}\x1B[0m` : title, line(w.title), line(`${elapsed(w, now)}  ${w.files.length} files  ${count(w.tokens)} tok`));
      const speed = state === "running" ? w.tps : w.avgTps;
      const graph = w.spark?.length ? w.spark.map((n) => "._-=+*#@"[Math.min(7, Math.floor(n / Math.max(1, ...w.spark) * 7))]).join("") : "";
      output.push(line(`${speed ? `${Math.round(speed)} tok/s  ` : ""}${money(w.cost)}  ${graph}`));
      if (state === "running" && w.maxMinutes) {
        const progress = Math.min(1, (now - w.startedAt) / (w.maxMinutes * 6e4)), size = Math.max(3, Math.min(20, width - 9));
        output.push(line(`[${"#".repeat(Math.floor(progress * size))}${".".repeat(size - Math.floor(progress * size))}] time`));
      }
      output.push(line(w.last || "Starting..."));
      if (w.error) output.push(line(`Error: ${w.error}`));
      for (const warning of w.warnings ?? []) output.push(line(`! ${warning}`));
      output.push("");
    }
  }
  output.push(line("q close panel  |  j/k scroll"));
  return output;
}
function demoSnapshot(now = Date.now()) {
  return { version: 1, sessionId: "demo", panelId: "demo", pid: 0, at: now, closed: false, cwd: "/demo", model: "opencode-go/deepseek-v4.1-flash", effort: "low", ledger: { tokens: 18450, cost: 0, spawned: 4 }, workers: ["running", "done", "failed", "killed"].map((state, i) => ({ id: `w${i + 1}`, title: ["Implementing inventory slots", "Reviewing the save format", "Checking input bindings", "Stopped by supervisor"][i], agent: i === 1 ? "review" : "dev", state, act: "edit", last: state === "running" ? "edit src/inventory.ts" : "Worker finished", startedAt: now - 125e3, endedAt: state === "running" ? void 0 : now - 5e3, files: ["src/example.ts"], tokens: 4e3 + i * 400, cost: 0, warnings: state === "failed" ? ["verify FAILED: input test"] : [], spark: [12, 35, 24, 48, 39, 55], tps: 55, avgTps: 41, maxMinutes: 20 })) };
}

// src/companion.ts
var root = fileURLToPath(new URL("../", import.meta.url));
var help = `Pi Conductor companion

  conductor [launch] [--detach] -- [codex arguments]
  conductor dashboard [--once] [--demo] [--panel ID] [--data-dir PATH]

Examples:
  ./bin/conductor -- -C ~/my-project
  ./bin/conductor dashboard --demo

Requires tmux for launch. Ctrl-b then left/right changes panes; q closes the panel.
The launcher uses codex --no-daemon to pass panel identity to its MCP server.
Dashboard reads local snapshots and never calls a model.
`;
var quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function tmux(args2, allowFailure = false) {
  const r = spawnSync("tmux", args2, { encoding: "utf8" });
  if ((r.error || r.status !== 0) && !allowFailure) throw new Error(r.error?.code === "ENOENT" ? "tmux is not installed. Install tmux, then run conductor again." : r.stderr.trim() || String(r.error ?? "tmux failed"));
  return r.stdout?.trim() ?? "";
}
function value(args2, name) {
  const i = args2.indexOf(name);
  if (i < 0) return void 0;
  if (!args2[i + 1] || args2[i + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args2[i + 1];
}
async function dashboard(args2) {
  const dataDir = resolve(value(args2, "--data-dir") ?? process.env.OMP_CONDUCTOR_DATA_DIR ?? join2(homedir(), ".codex/plugin-data/omp-conductor-codex"));
  const panelId = value(args2, "--panel") ?? process.env.OMP_CONDUCTOR_PANEL_ID;
  if (panelId && !/^[a-zA-Z0-9_-]{1,100}$/.test(panelId)) throw new Error("Invalid panel ID");
  const watchPane = value(args2, "--watch-pane"), demo = args2.includes("--demo"), once = args2.includes("--once") || !process.stdout.isTTY;
  let frame = 0, offset = 0, stopped = false;
  const restore = () => {
    if (stopped) return;
    stopped = true;
    if (!once) {
      process.stdout.write("\x1B[0m\x1B[?25h\x1B[?1049l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
  if (!once) {
    process.stdout.write("\x1B[?1049h\x1B[?25l");
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (b) => {
        const key = b.toString();
        if (key === "q" || key === "" || key === "") restore();
        else if (key === "j" || key === "\x1B[B") offset += 3;
        else if (key === "k" || key === "\x1B[A") offset = Math.max(0, offset - 3);
      });
    }
    process.on("SIGINT", restore);
    process.on("SIGTERM", restore);
  }
  try {
    do {
      const snapshots = demo ? [demoSnapshot()] : await readPanels(dataDir, panelId);
      const rows = renderPanel(snapshots, { width: process.stdout.columns ?? 48, frame: frame++, color: !once });
      const height = Math.max(1, (process.stdout.rows ?? 30) - 1);
      offset = Math.min(offset, Math.max(0, rows.length - height));
      if (once) {
        process.stdout.write(rows.join("\n") + "\n");
        break;
      }
      process.stdout.write("\x1B[H\x1B[2J" + rows.slice(offset, offset + height).join("\r\n"));
      if (watchPane && frame % 4 === 0 && !tmux(["list-panes", "-a", "-F", "#{pane_id}"], true).split("\n").includes(watchPane)) break;
      await new Promise((r) => setTimeout(r, 250));
    } while (!stopped);
  } finally {
    restore();
  }
}
async function launch(args2) {
  const separator = args2.indexOf("--"), options = separator >= 0 ? args2.slice(0, separator) : [];
  const codexArgs = separator >= 0 ? args2.slice(separator + 1) : args2;
  const detached = options.includes("--detach");
  if (!process.stdin.isTTY && !detached) throw new Error("Launch needs an interactive terminal. Use dashboard --once for plain output, or launch --detach -- for a detached tmux session.");
  const codex = process.env.OMP_CONDUCTOR_CODEX_BIN ?? "codex";
  const probe = spawnSync(codex, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) throw new Error("Codex is not installed or not on PATH.");
  tmux(["-V"]);
  const panelId = randomUUID(), dataDir = resolve(process.env.OMP_CONDUCTOR_DATA_DIR ?? join2(homedir(), ".codex/plugin-data/omp-conductor-codex"));
  const env = { ...process.env, OMP_CONDUCTOR_PANEL_ID: panelId, OMP_CONDUCTOR_DATA_DIR: dataDir };
  const codexCommand = ["env", `OMP_CONDUCTOR_PANEL_ID=${panelId}`, `OMP_CONDUCTOR_DATA_DIR=${dataDir}`, codex, "--no-daemon", ...codexArgs].map(quote).join(" ");
  const panelCommand = (pane) => [process.execPath, join2(root, "dist/companion.mjs"), "dashboard", "--panel", panelId, "--data-dir", dataDir, "--watch-pane", pane].map(quote).join(" ");
  if (process.env.TMUX && !detached) {
    const main = tmux(["display-message", "-p", "#{pane_id}"]);
    const side = tmux(["split-window", "-h", "-p", "35", "-d", "-P", "-F", "#{pane_id}", "-t", main, "-c", process.cwd(), panelCommand(main)]);
    tmux(["set-option", "-p", "-t", side, "remain-on-exit", "off"]);
    try {
      const child = spawn(codex, ["--no-daemon", ...codexArgs], { stdio: "inherit", env });
      const forward = () => child.kill("SIGTERM"), keepLauncher = () => {
      };
      process.on("SIGTERM", forward);
      process.on("SIGINT", keepLauncher);
      await new Promise((resolve2, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          process.exitCode = code ?? 1;
          resolve2();
        });
      });
      process.removeListener("SIGTERM", forward);
      process.removeListener("SIGINT", keepLauncher);
    } finally {
      tmux(["kill-pane", "-t", side], true);
    }
    return;
  }
  const session = `conductor-${panelId.slice(0, 8)}`;
  let created = false;
  try {
    const main = tmux(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-n", "Codex + Conductor", "-x", String(process.stdout.columns ?? 140), "-y", String(process.stdout.rows ?? 40), "-c", process.cwd(), codexCommand]);
    created = true;
    tmux(["set-option", "-w", "-t", session, "remain-on-exit", "off"]);
    tmux(["split-window", "-h", "-p", "35", "-d", "-t", main, "-c", process.cwd(), panelCommand(main)]);
    tmux(["select-pane", "-t", main]);
    if (detached) {
      console.log(`Started ${session}
Attach: tmux attach -t ${session}`);
      return;
    }
    const attached = spawnSync("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
    process.exitCode = attached.status ?? 1;
  } catch (e) {
    if (created) tmux(["kill-session", "-t", session], true);
    throw e;
  }
}
var args = process.argv.slice(2);
try {
  const ownArgs = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  if (ownArgs.includes("--help") || ownArgs.includes("-h")) console.log(help);
  else if (args[0] === "dashboard") await dashboard(args.slice(1));
  else if (args[0] === "demo") await dashboard(["--demo", ...args.slice(1)]);
  else await launch(args[0] === "launch" ? args.slice(1) : args);
} catch (e) {
  console.error(`conductor: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}

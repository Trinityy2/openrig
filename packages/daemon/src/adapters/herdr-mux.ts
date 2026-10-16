// The herdr terminal backend: OpenRig seats run as herdr panes instead of tmux sessions.
//
// TmuxAdapter (and the seat delivery guard, identity checks and launch staging built into it) drives its
// multiplexer through one injected exec seam that receives tmux argv. This module implements that seam on top of
// herdr's control socket: it interprets the subset of tmux commands the adapter issues and answers in tmux's
// output shapes, so every consumer of TmuxAdapter runs unchanged while no tmux binary or server exists.
//
// herdr is AGPL. As in domain/terminal/herdr-transport.ts, OpenRig talks to the operator's installed herdr over
// its local control socket only; no herdr code is imported, linked or vendored.
//
// The mapping:
// - A tmux session is one herdr tab. Its first pane carries the metadata token `openrig_session=<name>`, which is
//   the session's identity and survives a daemon restart. Seats of rig `R` (session names `pod-member@R`) are
//   tabs of the herdr workspace labelled `R`, so a rig shows up as a workspace in the herdr sidebar.
// - Pane, window and session ids (`%N`, `@N`, `$N`) are the decimal form of the root pane's herdr terminal id
//   (`term_<hex>`): stable for the terminal's life, never reused, and unaffected by herdr moving the pane.
// - Session environment, options and creation time live in a small state file next to the daemon's database.
// - herdr panes always start the login shell, so every pane is "shell backed". `respawn-pane` is emulated by
//   typing a staged script into that shell; `remain-on-exit` + "pane dead" mean the shell is back in the
//   foreground; a signal aimed at a held pane's shell goes to its foreground job instead, so the pane (and its
//   scrollback) survives exactly as a tmux pane held by remain-on-exit would.
// - `pipe-pane` streams `herdr terminal session observe` frames into the sink file.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ArgvExecFn, ExecFn } from "./tmux.js";
import {
  createHerdrSocketRpc,
  resolveHerdrSocketPath,
  type HerdrResult,
  type HerdrSocketRpc,
} from "../domain/terminal/herdr-transport.js";

/** The token on a session's root pane that names the tmux session it stands for. */
export const HERDR_SESSION_TOKEN = "openrig_session";
const METADATA_SOURCE = "openrig";
/** herdr reads at most about this many lines of history per request. */
const MAX_READ_LINES = 1000;
const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;

export interface HerdrMuxOptions {
  /** Socket RPC; defaults to the real unix socket at `socketPath`. */
  rpc?: HerdrSocketRpc;
  socketPath?: string;
  /** A named herdr session (`herdr --session NAME`) for spawned herdr commands. */
  herdrSession?: string;
  herdrBin?: string;
  /** Persisted session environment/options. Omit to keep state in memory only. */
  statePath?: string;
  /** Runs commands that are not tmux commands (the adapter's `kill -SIG pid`). */
  fallbackExec: ExecFn;
  /** Start a herdr server when none answers (startServer). */
  autoStart?: boolean;
  now?: () => number;
  /** Test seam: start a long-lived herdr command (pipe-pane observe, server). */
  spawnProcess?: (argv: string[], detached: boolean) => ChildProcess;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface HerdrPane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  cwd?: string;
  foreground_cwd?: string;
  focused?: boolean;
  revision?: number;
  tokens?: Record<string, string>;
  scroll?: { viewport_rows?: number };
}
interface HerdrTab { tab_id: string; workspace_id: string; label?: string; pane_count?: number }
interface HerdrWorkspace { workspace_id: string; label?: string }
interface HerdrLayout { tab_id?: string; area?: { width?: number; height?: number }; panes?: Array<{ pane_id: string; rect?: { width?: number; height?: number } }> }
interface HerdrSnapshot {
  panes: HerdrPane[];
  tabs: HerdrTab[];
  workspaces: HerdrWorkspace[];
  layouts: HerdrLayout[];
  focused_pane_id?: string | null;
}
interface ProcessInfo { shellPid: number; foregroundGroup: number | null; command: string | null; shellForeground: boolean }

interface SessionState {
  name: string;
  /** Epoch seconds. */
  created: number;
  /** null marks a variable removed from the session (tmux `set-environment -r` / `-u`). */
  env: Record<string, string | null>;
  options: Record<string, string>;
  paneOptions: Record<string, string>;
}
interface MuxState { sessions: Record<string, SessionState>; serverOptions: Record<string, string> }

/** One OpenRig session as herdr shows it: the tab and its panes, root first. */
interface MuxSession { name: string; id: string; root: HerdrPane; panes: HerdrPane[]; tab: HerdrTab | undefined; state: SessionState }
interface Resolved { session: MuxSession; pane: HerdrPane }

/** An error shaped like a failed tmux exec: classification reads its message and `execStderr`. */
class MuxError extends Error {
  readonly execStderr: string;
  stdout = "";
  constructor(message: string) {
    super(message);
    this.execStderr = message;
  }
}

/** The tmux pane/window/session number for a herdr terminal id. */
export function herdrTerminalNumber(terminalId: string): string {
  const hex = terminalId.replace(/^term_/, "");
  if (/^[0-9a-f]+$/i.test(hex)) return BigInt(`0x${hex}`).toString();
  let h = 0n;
  for (const ch of terminalId) h = (h * 131n + BigInt(ch.codePointAt(0)!)) % 9007199254740881n;
  return h.toString();
}

/** The herdr workspace label a session's tab lives under. */
export function herdrWorkspaceLabel(sessionName: string): string {
  const at = sessionName.lastIndexOf("@");
  return at >= 0 && at < sessionName.length - 1 ? sessionName.slice(at + 1) : "openrig";
}

/** Split a POSIX shell command line into words (quotes and backslashes; no expansion). */
export function splitShellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated single quote");
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (ch === '"') {
      i++;
      for (; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`\n'.includes(line[i + 1]!)) i++;
        cur += line[i]!;
      }
      if (i >= line.length) throw new Error("unterminated double quote");
      inWord = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i]!;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** tmux key names herdr spells differently, and keys herdr has no name for (sent as their escape sequence). */
const KEY_NAMES: Record<string, string> = {
  Enter: "enter", KPEnter: "enter", "C-m": "enter", Escape: "esc", Tab: "tab", BTab: "shift+tab", Space: "space",
  BSpace: "backspace", Up: "up", Down: "down", Left: "left", Right: "right",
};
const KEY_SEQUENCES: Record<string, string> = {
  Home: "\x1b[H", End: "\x1b[F", DC: "\x1b[3~", Delete: "\x1b[3~", IC: "\x1b[2~", Insert: "\x1b[2~",
  PPage: "\x1b[5~", PageUp: "\x1b[5~", NPage: "\x1b[6~", PageDown: "\x1b[6~",
};

type KeyChunk = { kind: "keys"; keys: string[] } | { kind: "text"; text: string };

/** Turn tmux send-keys arguments into herdr key presses and literal text, in order. */
export function translateKeys(keys: string[]): KeyChunk[] {
  const out: KeyChunk[] = [];
  const push = (chunk: KeyChunk) => {
    const last = out.at(-1);
    if (last && last.kind === "keys" && chunk.kind === "keys") last.keys.push(...chunk.keys);
    else if (last && last.kind === "text" && chunk.kind === "text") last.text += chunk.text;
    else out.push(chunk);
  };
  for (const key of keys) {
    const named = KEY_NAMES[key];
    const ctrl = /^C-(.)$/.exec(key);
    const meta = /^M-(.)$/.exec(key);
    if (named) push({ kind: "keys", keys: [named] });
    else if (KEY_SEQUENCES[key]) push({ kind: "text", text: KEY_SEQUENCES[key]! });
    else if (/^F([1-9]|1[0-2])$/.test(key)) push({ kind: "keys", keys: [key] });
    else if (ctrl) push({ kind: "keys", keys: [`ctrl+${ctrl[1]!.toLowerCase()}`] });
    else if (meta) push({ kind: "keys", keys: [`alt+${meta[1]!}`] });
    else push({ kind: "text", text: key }); // tmux sends an unknown key name as literal text
  }
  return out;
}

/** Parsed tmux command arguments. `valueFlags` lists the flags that take a value. */
interface ParsedArgs { flags: Map<string, string[]>; bools: Set<string>; positionals: string[] }
function parseArgs(args: string[], valueFlags: string): ParsedArgs {
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (positionals.length > 0 || !arg.startsWith("-") || arg === "-" || arg === "--") {
      if (arg === "--" && positionals.length === 0) { positionals.push(...args.slice(i + 1)); break; }
      positionals.push(arg);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const f = arg[j]!;
      if (valueFlags.includes(f)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) throw new MuxError(`command requires a value for -${f}`);
        flags.set(f, [...(flags.get(f) ?? []), value]);
        break;
      }
      bools.add(f);
    }
  }
  return { flags, bools, positionals };
}
const flag = (p: ParsedArgs, f: string): string | undefined => p.flags.get(f)?.at(-1);

function emptyState(): MuxState {
  return { sessions: {}, serverOptions: {} };
}

/**
 * Interprets tmux commands against a herdr server. Construct one per daemon and wire its `exec`/`argvExec`
 * into TmuxAdapter.
 */
export class HerdrMux {
  private readonly rpc: HerdrSocketRpc;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private state: MuxState;
  private readonly buffers = new Map<string, string>();
  private readonly activity = new Map<string, { revision: number; at: number }>();
  /** shell pid -> terminal id, from process reads: lets a `kill` aimed at a held pane's shell find its pane. */
  private readonly shellPids = new Map<number, string>();
  private readonly pipes = new Map<string, ChildProcess>();
  private createLock: Promise<unknown> = Promise.resolve();
  private counter = 0;

  readonly exec: ExecFn;
  readonly argvExec: ArgvExecFn;

  constructor(private readonly opts: HerdrMuxOptions) {
    this.socketPath = opts.socketPath ?? resolveHerdrSocketPath(opts.herdrSession ? { ...process.env, HERDR_SOCKET_PATH: "", HERDR_SESSION: opts.herdrSession } : process.env);
    this.rpc = opts.rpc ?? createHerdrSocketRpc(this.socketPath);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.state = this.loadState();
    this.exec = (cmd) => this.execString(cmd);
    this.argvExec = (argv) => this.execArgv(argv);
  }

  // ---------------------------------------------------------------- exec entry points

  private async execString(cmd: string): Promise<string> {
    const trimmed = cmd.trim();
    if (/^tmux(\s|$)/.test(trimmed)) {
      // startServer's `tmux -D </dev/null >/dev/null 2>&1 &`: only the server start matters here.
      if (/^tmux\s+-D\b/.test(trimmed)) { await this.ensureServer(); return ""; }
      return this.execArgv(splitShellWords(trimmed));
    }
    const kill = /^kill -(TERM|KILL) (\d+)$/.exec(trimmed);
    if (kill && await this.redirectHeldShellSignal(Number(kill[2]), `SIG${kill[1]}` as NodeJS.Signals)) return "";
    return this.opts.fallbackExec(cmd);
  }

  private async execArgv(argv: string[]): Promise<string> {
    const [bin, ...rest] = argv;
    if (bin !== "tmux") {
      return this.opts.fallbackExec(argv.map(shellQuote).join(" "));
    }
    // Server-selection flags belong to tmux; herdr's socket is fixed per mux.
    let args = rest;
    while (args[0] === "-L" || args[0] === "-S" || args[0] === "-f") args = args.slice(2);
    if (args[0] === "-V") return `tmux herdr-backend (${(await this.version()) ?? "herdr"})\n`;
    if (args[0] === "-D") { await this.ensureServer(); return ""; }
    const commands: string[][] = [[]];
    for (const a of args) {
      if (a === ";") commands.push([]);
      else commands.at(-1)!.push(a);
    }
    let stdout = "";
    for (const command of commands) {
      if (command.length === 0) continue;
      try {
        stdout += await this.runCommand(command);
      } catch (err) {
        const e = err instanceof MuxError ? err : new MuxError(err instanceof Error ? err.message : String(err));
        e.stdout = stdout;
        throw e;
      }
    }
    return stdout;
  }

  private async runCommand(command: string[]): Promise<string> {
    const [name, ...args] = command;
    switch (name) {
      case "new-session": return this.newSession(parseArgs(args, "sceFnxy"));
      case "has-session": await this.resolve(flag(parseArgs(args, "t"), "t") ?? "", "session"); return "";
      case "kill-session": return this.killSession(parseArgs(args, "t"));
      case "detach-client": return "";
      case "list-sessions": return this.listSessions(parseArgs(args, "Ff"));
      case "list-windows": return this.listWindows(parseArgs(args, "Fft"));
      case "list-panes": return this.listPanes(parseArgs(args, "Fft"));
      case "display-message": case "display": return this.displayMessage(parseArgs(args, "tcd"));
      case "capture-pane": return this.capturePane(parseArgs(args, "tSEb"));
      case "send-keys": case "send": return this.sendKeys(parseArgs(args, "tNX"));
      case "load-buffer": return this.loadBuffer(parseArgs(args, "bt"));
      case "paste-buffer": return this.pasteBuffer(parseArgs(args, "tbs"));
      case "delete-buffer": this.buffers.delete(flag(parseArgs(args, "b"), "b") ?? ""); return "";
      case "set-environment": case "setenv": return this.setEnvironment(parseArgs(args, "t"));
      case "show-environment": case "showenv": return this.showEnvironment(parseArgs(args, "t"));
      case "set-option": case "set": return this.setOption(parseArgs(args, "t"));
      case "show-options": case "show-option": case "show": return this.showOptions(parseArgs(args, "t"));
      case "respawn-pane": return this.respawnPane(parseArgs(args, "tce"));
      case "pipe-pane": return this.pipePane(parseArgs(args, "t"));
      case "resize-window": case "resize-pane": return "";
      case "list-clients": return this.listClients(parseArgs(args, "Ft"));
      case "switch-client": return this.switchClient(parseArgs(args, "ct"));
      case "if-shell": return this.ifShell(parseArgs(args, "t"));
      case "start-server": await this.ensureServer(); return "";
      default: throw new MuxError(`unknown command: ${name} (not supported by the herdr backend)`);
    }
  }

  // ---------------------------------------------------------------- herdr access

  private async request(method: string, params: Record<string, unknown>): Promise<HerdrResult> {
    try {
      return await this.rpc({ id: `openrig-mux-${++this.counter}`, method, params });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "ENOENT" || code === "ECONNREFUSED" || /socket timeout|closed before a response/.test(message)) {
        throw new MuxError(`no server running on ${this.socketPath} (herdr: ${message})`);
      }
      if (/pane_not_found/.test(message)) throw new MuxError(`can't find pane: ${String(params["pane_id"] ?? "")}`);
      if (/tab_not_found/.test(message)) throw new MuxError(`can't find window: ${String(params["tab_id"] ?? "")}`);
      if (/workspace_not_found/.test(message)) throw new MuxError(`can't find session: ${String(params["workspace_id"] ?? "")}`);
      const detail = /"message":"((?:[^"\\]|\\.){0,200})/.exec(message)?.[1] ?? message.slice(0, 200);
      throw new MuxError(`herdr ${method}: ${detail}`);
    }
  }

  private async version(): Promise<string | null> {
    try {
      const pong = await this.rpc({ id: `openrig-mux-${++this.counter}`, method: "ping", params: {} });
      return typeof pong["version"] === "string" ? `herdr ${pong["version"]}` : "herdr";
    } catch {
      return null;
    }
  }

  private async ensureServer(): Promise<void> {
    if ((await this.version()) !== null) return;
    if (this.opts.autoStart === false) throw new MuxError(`no server running on ${this.socketPath}`);
    const argv = [this.opts.herdrBin ?? "herdr", ...(this.opts.herdrSession ? ["--session", this.opts.herdrSession] : []), "server"];
    const child = this.spawn(argv, true);
    child.unref();
    for (let i = 0; i < 40; i++) {
      await this.sleep(50);
      if ((await this.version()) !== null) return;
    }
    throw new MuxError(`no server running on ${this.socketPath}: herdr server did not start`);
  }

  private spawn(argv: string[], detached: boolean): ChildProcess {
    if (this.opts.spawnProcess) return this.opts.spawnProcess(argv, detached);
    return spawn(argv[0]!, argv.slice(1), { detached, stdio: detached ? "ignore" : ["ignore", "pipe", "ignore"] });
  }

  private async snapshot(): Promise<HerdrSnapshot> {
    const result = await this.request("session.snapshot", {});
    const snap = (result["snapshot"] ?? result) as Partial<HerdrSnapshot>;
    const out: HerdrSnapshot = {
      panes: snap.panes ?? [], tabs: snap.tabs ?? [], workspaces: snap.workspaces ?? [],
      layouts: Array.isArray(snap.layouts) ? snap.layouts : [], focused_pane_id: snap.focused_pane_id ?? null,
    };
    const now = Math.floor(this.now() / 1000);
    for (const pane of out.panes) {
      const seen = this.activity.get(pane.terminal_id);
      const revision = pane.revision ?? 0;
      if (!seen) this.activity.set(pane.terminal_id, { revision, at: this.state.sessions[pane.terminal_id]?.created ?? now });
      else if (seen.revision !== revision) this.activity.set(pane.terminal_id, { revision, at: now });
    }
    return out;
  }

  /** Every OpenRig session herdr holds, in the order herdr lists their root panes. */
  private sessions(snap: HerdrSnapshot): MuxSession[] {
    const out: MuxSession[] = [];
    const seen = new Set<string>();
    let stateChanged = false;
    for (const root of snap.panes) {
      const name = root.tokens?.[HERDR_SESSION_TOKEN];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      let state = this.state.sessions[root.terminal_id];
      if (!state || state.name !== name) {
        state = { name, created: Math.floor(this.now() / 1000), env: {}, options: {}, paneOptions: {} };
        this.state.sessions[root.terminal_id] = state;
        stateChanged = true;
      }
      const panes = [root, ...snap.panes.filter((p) => p.tab_id === root.tab_id && p.pane_id !== root.pane_id)];
      out.push({ name, id: herdrTerminalNumber(root.terminal_id), root, panes, tab: snap.tabs.find((t) => t.tab_id === root.tab_id), state });
    }
    // Forget sessions whose terminals are gone.
    const live = new Set(snap.panes.map((p) => p.terminal_id));
    for (const id of Object.keys(this.state.sessions)) {
      if (!live.has(id)) { delete this.state.sessions[id]; stateChanged = true; }
    }
    if (stateChanged) this.saveState();
    return out;
  }

  /** Resolve a tmux target: `%N`, `@N`, `$N`, `=name`, `=name:`, `name:0.1`. */
  private async resolve(target: string, kind: "session" | "pane", snap?: HerdrSnapshot): Promise<Resolved> {
    const sessions = this.sessions(snap ?? await this.snapshot());
    const byId = /^([%@$])(\d+)$/.exec(target);
    if (byId) {
      for (const session of sessions) {
        if (byId[1] === "%") {
          const pane = session.panes.find((p) => herdrTerminalNumber(p.terminal_id) === byId[2]);
          if (pane) return { session, pane };
        } else if (session.id === byId[2]) {
          return { session, pane: session.root };
        }
      }
      throw new MuxError(byId[1] === "%" ? `can't find pane: ${target}` : byId[1] === "@" ? `can't find window: ${target}` : `can't find session: ${target}`);
    }
    const bare = target.startsWith("=") ? target.slice(1) : target;
    const colon = bare.indexOf(":");
    const name = colon >= 0 ? bare.slice(0, colon) : bare;
    const rest = colon >= 0 ? bare.slice(colon + 1) : "";
    const session = sessions.find((s) => s.name === name);
    if (!session) throw new MuxError(`can't find session: ${name}`);
    const dot = rest.indexOf(".");
    const paneIndex = dot >= 0 ? Number(rest.slice(dot + 1)) : NaN;
    if (kind === "pane" && Number.isInteger(paneIndex)) {
      const pane = session.panes[paneIndex];
      if (!pane) throw new MuxError(`can't find pane: ${rest.slice(dot + 1)}`);
      return { session, pane };
    }
    const focused = session.panes.find((p) => p.focused);
    return { session, pane: kind === "pane" && focused ? focused : session.root };
  }

  private async processInfo(pane: HerdrPane): Promise<ProcessInfo | null> {
    try {
      const result = await this.request("pane.process_info", { pane_id: pane.pane_id });
      const info = (result["process_info"] ?? result) as { shell_pid?: number; foreground_process_group_id?: number | null; foreground_processes?: Array<{ pid: number; name?: string; argv0?: string }> };
      const shellPid = info.shell_pid ?? 0;
      if (shellPid > 0) this.shellPids.set(shellPid, pane.terminal_id);
      const fg = info.foreground_processes ?? [];
      const shellForeground = fg.length === 0 || fg.some((p) => p.pid === shellPid) || info.foreground_process_group_id === shellPid;
      const lead = fg.find((p) => p.pid === info.foreground_process_group_id) ?? fg[0];
      const command = (lead?.name || lead?.argv0 || "").replace(/^-/, "") || null;
      return { shellPid, foregroundGroup: info.foreground_process_group_id ?? null, command, shellForeground };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- formats

  private paneSize(snap: HerdrSnapshot | undefined, pane: HerdrPane): { width: number; height: number } {
    for (const layout of snap?.layouts ?? []) {
      const rect = layout.panes?.find((p) => p.pane_id === pane.pane_id)?.rect;
      if (rect?.width && rect.height) return { width: rect.width, height: rect.height };
    }
    return { width: DEFAULT_COLS, height: pane.scroll?.viewport_rows ?? DEFAULT_ROWS };
  }

  private async render(format: string, r: Resolved, snap: HerdrSnapshot | undefined): Promise<string> {
    const needsProcess = /#\{(pane_pid|pane_current_command|pane_dead)\}/.test(format);
    const info = needsProcess ? await this.processInfo(r.pane) : null;
    const size = this.paneSize(snap, r.pane);
    const activity = this.activity.get(r.pane.terminal_id)?.at ?? r.session.state.created;
    const sessionActivity = Math.max(...r.session.panes.map((p) => this.activity.get(p.terminal_id)?.at ?? 0), activity);
    const paneId = `%${herdrTerminalNumber(r.pane.terminal_id)}`;
    const remain = r.session.state.paneOptions[`${r.pane.terminal_id}:remain-on-exit`] === "on";
    const focusedHere = snap?.focused_pane_id != null && r.session.panes.some((p) => p.pane_id === snap.focused_pane_id);
    const values: Record<string, string> = {
      session_name: r.session.name,
      session_id: `$${r.session.id}`,
      session_windows: "1",
      session_created: String(r.session.state.created),
      session_attached: focusedHere ? "1" : "0",
      window_index: "0",
      window_id: `@${r.session.id}`,
      window_name: r.session.name,
      window_panes: String(r.session.panes.length),
      window_active: "1",
      window_activity: String(sessionActivity),
      window_width: String(size.width),
      window_height: String(size.height),
      pane_id: paneId,
      pane_index: String(Math.max(0, r.session.panes.indexOf(r.pane))),
      pane_current_path: r.pane.foreground_cwd || r.pane.cwd || "",
      pane_width: String(size.width),
      pane_height: String(size.height),
      pane_active: r.pane === r.session.root || r.pane.focused ? "1" : "0",
      pane_pid: info && info.shellPid > 0 ? String(info.shellPid) : "",
      pane_current_command: info?.command ?? "",
      pane_dead: info && remain && info.shellForeground ? "1" : "0",
      pane_in_mode: "0",
      pane_silence_flag: "0",
      history_size: "0",
      history_bytes: "0",
      cursor_x: "",
      cursor_y: "",
      client_name: "herdr",
      client_session: r.session.name,
    };
    return format.replace(/#\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? "");
  }

  // ---------------------------------------------------------------- session lifecycle

  private async newSession(p: ParsedArgs): Promise<string> {
    const name = flag(p, "s") ?? `openrig-${randomUUID().slice(0, 8)}`;
    if (name.includes(":") || name.includes(".")) throw new MuxError(`invalid session name: ${name}`);
    const cwd = flag(p, "c");
    const env: Record<string, string> = {};
    for (const pair of p.flags.get("e") ?? []) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const run = async (): Promise<Resolved> => {
      const snap = await this.snapshot();
      if (this.sessions(snap).some((s) => s.name === name)) throw new MuxError(`duplicate session: ${name}`);
      const label = herdrWorkspaceLabel(name);
      const workspace = snap.workspaces.find((w) => w.label === label);
      let root: HerdrPane;
      if (workspace) {
        const created = await this.request("tab.create", { workspace_id: workspace.workspace_id, cwd: cwd ?? null, env, label: name, focus: false });
        root = created["root_pane"] as HerdrPane;
      } else {
        const created = await this.request("workspace.create", { cwd: cwd ?? null, env, label, focus: false });
        root = created["root_pane"] as HerdrPane;
        const tab = created["tab"] as HerdrTab | undefined;
        if (tab?.tab_id) await this.request("tab.rename", { tab_id: tab.tab_id, label: name });
      }
      if (!root?.pane_id || !root.terminal_id) throw new MuxError("herdr did not report the new pane");
      await this.request("pane.report_metadata", { pane_id: root.pane_id, source: METADATA_SOURCE, tokens: { [HERDR_SESSION_TOKEN]: name } });
      this.state.sessions[root.terminal_id] = { name, created: Math.floor(this.now() / 1000), env: { ...env }, options: {}, paneOptions: {} };
      this.saveState();
      const after = await this.snapshot();
      return this.resolve(`=${name}`, "pane", after);
    };
    // Serialized: two seats of one rig must not each create the rig's workspace.
    const next = this.createLock.then(run, run);
    this.createLock = next.catch(() => undefined);
    const resolved = await next;
    const command = p.positionals.join(" ");
    if (command) await this.typeScript(resolved.pane, command, { cwd, env: {}, inShell: false });
    return p.bools.has("P") ? `${await this.render(flag(p, "F") ?? "#{session_name}:", resolved, undefined)}\n` : "";
  }

  private async killSession(p: ParsedArgs): Promise<string> {
    const { session } = await this.resolve(flag(p, "t") ?? "", "session");
    this.stopPipe(session.root.terminal_id);
    if (session.tab) await this.request("tab.close", { tab_id: session.tab.tab_id });
    else await this.request("pane.close", { pane_id: session.root.pane_id });
    delete this.state.sessions[session.root.terminal_id];
    this.saveState();
    return "";
  }

  /** removeCreatedSession: `if-shell -F -t $id '#{&&:#{==:#{session_name},NAME},#{==:#{session_created},AT}}' 'kill-session -t $id' 'display-message -p kept'`. */
  private async ifShell(p: ParsedArgs): Promise<string> {
    const [condition = "", then = "", otherwise = ""] = p.positionals;
    const name = /#\{==:#\{session_name\},(.*?)\}/.exec(condition)?.[1];
    const created = /#\{==:#\{session_created\},(\d+)\}/.exec(condition)?.[1];
    if (!p.bools.has("F") || name === undefined || created === undefined) throw new MuxError("if-shell: unsupported condition for the herdr backend");
    let holds = false;
    try {
      const { session } = await this.resolve(flag(p, "t") ?? "", "session");
      holds = session.name === name && String(session.state.created) === created;
    } catch { /* gone: the condition is false */ }
    const chosen = holds ? then : otherwise;
    return chosen ? this.execArgv(["tmux", ...splitShellWords(chosen)]) : "";
  }

  // ---------------------------------------------------------------- listings

  private async listSessions(p: ParsedArgs): Promise<string> {
    let snap: HerdrSnapshot;
    try { snap = await this.snapshot(); } catch (err) {
      if (err instanceof MuxError && err.message.startsWith("no server running")) throw err;
      throw err;
    }
    const format = flag(p, "F") ?? "#{session_name}: #{session_windows} windows";
    const lines: string[] = [];
    for (const session of this.sessions(snap)) lines.push(await this.render(format, { session, pane: session.root }, snap));
    return lines.map((l) => `${l}\n`).join("");
  }

  private async listWindows(p: ParsedArgs): Promise<string> {
    const snap = await this.snapshot();
    const format = flag(p, "F") ?? "#{window_index}: #{window_name}";
    const sessions = p.bools.has("a") ? this.sessions(snap) : [(await this.resolve(flag(p, "t") ?? "", "session", snap)).session];
    const lines: string[] = [];
    for (const session of sessions) lines.push(await this.render(format, { session, pane: session.panes.find((x) => x.focused) ?? session.root }, snap));
    return lines.map((l) => `${l}\n`).join("");
  }

  private async listPanes(p: ParsedArgs): Promise<string> {
    const snap = await this.snapshot();
    const format = flag(p, "F") ?? "#{pane_index}: #{pane_id}";
    const sessions = p.bools.has("a") ? this.sessions(snap) : [(await this.resolve(flag(p, "t") ?? "", "session", snap)).session];
    const lines: string[] = [];
    for (const session of sessions) for (const pane of session.panes) lines.push(await this.render(format, { session, pane }, snap));
    return lines.map((l) => `${l}\n`).join("");
  }

  private async displayMessage(p: ParsedArgs): Promise<string> {
    const target = flag(p, "t");
    if (target === undefined) throw new MuxError("no current client");
    const snap = await this.snapshot();
    const resolved = await this.resolve(target, "pane", snap);
    const text = await this.render(p.positionals.join(" "), resolved, snap);
    return p.bools.has("p") ? `${text}\n` : "";
  }

  private async listClients(p: ParsedArgs): Promise<string> {
    // herdr's UI is the one client: it "shows" the session whose pane it has focused.
    const snap = await this.snapshot();
    const focused = this.sessions(snap).find((s) => s.panes.some((x) => x.pane_id === snap.focused_pane_id));
    if (!focused) return "";
    return `${await this.render(flag(p, "F") ?? "#{client_name}: #{client_session}", { session: focused, pane: focused.root }, snap)}\n`;
  }

  private async switchClient(p: ParsedArgs): Promise<string> {
    const { session } = await this.resolve(flag(p, "t") ?? "", "session");
    await this.request("pane.focus", { pane_id: session.root.pane_id });
    return "";
  }

  // ---------------------------------------------------------------- input and output

  private async capturePane(p: ParsedArgs): Promise<string> {
    const snap = await this.snapshot();
    const { pane } = await this.resolve(flag(p, "t") ?? "", "pane", snap);
    const start = flag(p, "S");
    const rows = this.paneSize(snap, pane).height;
    let source = "visible";
    let lines: number | null = null;
    if (start !== undefined && start !== "0") {
      source = p.bools.has("J") ? "recent_unwrapped" : "recent";
      const history = start === "-" ? MAX_READ_LINES : Math.abs(Number.parseInt(start, 10)) || 0;
      lines = Math.min(MAX_READ_LINES, history + rows);
    }
    const result = await this.request("pane.read", {
      pane_id: pane.pane_id, source, ...(lines !== null ? { lines } : {}),
      format: p.bools.has("e") ? "ansi" : "text", strip_ansi: !p.bools.has("e"),
    });
    const text = String(((result["read"] ?? result) as { text?: unknown }).text ?? "");
    return text === "" || text.endsWith("\n") ? text : `${text}\n`;
  }

  private async sendKeys(p: ParsedArgs): Promise<string> {
    const { pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    if (p.flags.has("X")) return ""; // copy-mode commands: herdr panes have no tmux copy mode
    if (p.bools.has("l")) {
      await this.request("pane.send_text", { pane_id: pane.pane_id, text: p.positionals.join(" ") });
      return "";
    }
    for (const chunk of translateKeys(p.positionals)) {
      if (chunk.kind === "keys") await this.request("pane.send_keys", { pane_id: pane.pane_id, keys: chunk.keys });
      else await this.request("pane.send_text", { pane_id: pane.pane_id, text: chunk.text });
    }
    return "";
  }

  private async loadBuffer(p: ParsedArgs): Promise<string> {
    const path = p.positionals[0];
    if (!path) throw new MuxError("load-buffer: no file");
    this.buffers.set(flag(p, "b") ?? "buffer0", readFileSync(path, "utf8"));
    return "";
  }

  private async pasteBuffer(p: ParsedArgs): Promise<string> {
    const name = flag(p, "b") ?? "buffer0";
    const buffer = this.buffers.get(name);
    if (buffer === undefined) throw new MuxError(`no buffer ${name}`);
    const { pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    // Without -r tmux turns LF into CR (Enter).
    const text = p.bools.has("r") ? buffer : buffer.replace(/\n/g, "\r");
    // send_input frames the text as a bracketed paste exactly when the application enabled that mode, as -p does.
    if (p.bools.has("p")) await this.request("pane.send_input", { pane_id: pane.pane_id, text, keys: [] });
    else await this.request("pane.send_text", { pane_id: pane.pane_id, text });
    if (p.bools.has("d")) this.buffers.delete(name);
    return "";
  }

  // ---------------------------------------------------------------- environment and options

  private async setEnvironment(p: ParsedArgs): Promise<string> {
    const [key, value] = p.positionals;
    if (!key) throw new MuxError("set-environment: no variable");
    if (p.bools.has("g")) return "";
    const { session } = await this.resolve(flag(p, "t") ?? "", "session");
    session.state.env[key] = p.bools.has("u") || p.bools.has("r") ? null : value ?? "";
    this.saveState();
    return "";
  }

  private async showEnvironment(p: ParsedArgs): Promise<string> {
    // The herdr server's own environment is not observable; nothing is inherited from a tmux-style global table.
    if (p.bools.has("g")) return "";
    const { session } = await this.resolve(flag(p, "t") ?? "", "session");
    const key = p.positionals[0];
    const render = (k: string, v: string | null) => (v === null ? `-${k}\n` : `${k}=${v}\n`);
    if (key) {
      if (!(key in session.state.env)) throw new MuxError(`unknown variable: ${key}`);
      return render(key, session.state.env[key] ?? null);
    }
    return Object.entries(session.state.env).map(([k, v]) => render(k, v)).join("");
  }

  private async setOption(p: ParsedArgs): Promise<string> {
    const [option, value = ""] = p.positionals;
    if (!option) throw new MuxError("set-option: no option");
    const unset = p.bools.has("u");
    if (p.bools.has("s") || p.bools.has("g")) {
      if (unset) delete this.state.serverOptions[option]; else this.state.serverOptions[option] = value;
      this.saveState();
      return "";
    }
    const { session, pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    if (p.bools.has("p")) {
      const key = `${pane.terminal_id}:${option}`;
      if (unset) delete session.state.paneOptions[key]; else session.state.paneOptions[key] = value;
    } else if (p.bools.has("w")) {
      // Window options (window-size, …) shape tmux's own rendering; herdr sizes panes itself.
    } else if (unset) {
      delete session.state.options[option];
    } else {
      session.state.options[option] = value;
    }
    this.saveState();
    return "";
  }

  private async showOptions(p: ParsedArgs): Promise<string> {
    const option = p.positionals[0];
    const valueOnly = p.bools.has("v");
    const show = (k: string, v: string | undefined) => (v === undefined ? "" : valueOnly ? `${v}\n` : `${k} ${v}\n`);
    if (p.bools.has("s") || p.bools.has("g")) {
      if (option === "default-shell") return show(option, this.state.serverOptions[option] ?? process.env.SHELL ?? "/bin/sh");
      if (option) return show(option, this.state.serverOptions[option]);
      return Object.entries(this.state.serverOptions).map(([k, v]) => show(k, v)).join("");
    }
    const { session, pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    if (p.bools.has("p")) {
      const prefix = `${pane.terminal_id}:`;
      if (option) return show(option, session.state.paneOptions[prefix + option]);
      return Object.entries(session.state.paneOptions).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => show(k.slice(prefix.length), v)).join("");
    }
    if (option) return show(option, session.state.options[option]);
    return Object.entries(session.state.options).map(([k, v]) => show(k, v)).join("");
  }

  // ---------------------------------------------------------------- respawn, signals, pipes

  /** Type a staged script into the pane's shell: `/bin/sh` runs a command; `inShell` sources it (cd/exports). */
  private async typeScript(pane: HerdrPane, command: string, opts: { cwd?: string; env: Record<string, string | null>; inShell: boolean; shell?: string | null }): Promise<void> {
    const path = join(tmpdir(), `openrig-herdr-${randomUUID()}.sh`);
    const lines = [`/bin/rm -f -- ${shellQuote(path)} 2>/dev/null || true`];
    if (opts.cwd) lines.push(`cd ${shellQuote(opts.cwd)} || exit 1`);
    for (const [k, v] of Object.entries(opts.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      lines.push(v === null ? `unset ${k}` : `export ${k}=${shellQuote(v)}`);
    }
    if (command) lines.push(command);
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    const shell = (opts.shell ?? "").replace(/^-/, "");
    const invocation = !opts.inShell ? `/bin/sh ${shellQuote(path)}`
      : shell === "fish" ? `source ${shellQuote(path)}` : `. ${shellQuote(path)}`;
    try {
      await this.request("pane.send_keys", { pane_id: pane.pane_id, keys: ["ctrl+u"] });
      await this.request("pane.send_text", { pane_id: pane.pane_id, text: invocation });
      await this.request("pane.send_keys", { pane_id: pane.pane_id, keys: ["enter"] });
    } catch (err) {
      try { unlinkSync(path); } catch { /* the shell may already own it */ }
      throw err;
    }
  }

  private async respawnPane(p: ParsedArgs): Promise<string> {
    const { session, pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    const info = await this.processInfo(pane);
    if (!info) throw new MuxError(`respawn pane failed: can't read pane ${flag(p, "t")}`);
    if (!info.shellForeground) {
      if (!p.bools.has("k")) throw new MuxError(`respawn pane failed: pane ${flag(p, "t")} still active`);
      if (info.foregroundGroup && info.foregroundGroup !== info.shellPid) this.signal(-info.foregroundGroup, "SIGKILL");
      for (let i = 0; i < 40; i++) {
        await this.sleep(50);
        if ((await this.processInfo(pane))?.shellForeground) break;
      }
    }
    const env: Record<string, string | null> = { ...session.state.env };
    for (const pair of p.flags.get("e") ?? []) {
      const eq = pair.indexOf("=");
      if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const cwd = flag(p, "c");
    const command = p.positionals.join(" ");
    const defaultShell = this.state.serverOptions["default-shell"] ?? process.env.SHELL ?? "";
    const shellName = (s: string) => s.split("/").pop()?.replace(/^-/, "") ?? "";
    // A respawn into a blank shell: the pane's own shell already is one; carry the cwd and env into it.
    const blank = !command || shellName(command) === shellName(defaultShell) || shellName(command) === info.command;
    await this.typeScript(pane, blank ? "" : `exec /bin/sh -c ${shellQuote(command)}`, { cwd, env, inShell: blank, shell: info.command });
    return "";
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      (this.opts.signalProcess ?? ((p, s) => process.kill(p, s)))(pid, signal);
    } catch { /* already gone */ }
  }

  /**
   * A tmux pane held by remain-on-exit survives its root process: it goes dead with its scrollback. A herdr pane
   * closes when its shell exits, so a signal aimed at a held pane's shell goes to its foreground job instead.
   */
  private async redirectHeldShellSignal(pid: number, signal: NodeJS.Signals): Promise<boolean> {
    const terminal = this.shellPids.get(pid);
    if (!terminal) return false;
    let snap: HerdrSnapshot;
    try { snap = await this.snapshot(); } catch { return false; }
    const session = this.sessions(snap).find((s) => s.panes.some((x) => x.terminal_id === terminal));
    const pane = session?.panes.find((x) => x.terminal_id === terminal);
    if (!session || !pane || session.state.paneOptions[`${terminal}:remain-on-exit`] !== "on") return false;
    const info = await this.processInfo(pane);
    if (!info || info.shellPid !== pid) return false;
    if (!info.shellForeground && info.foregroundGroup) this.signal(-info.foregroundGroup, signal);
    return true;
  }

  private async pipePane(p: ParsedArgs): Promise<string> {
    const { pane } = await this.resolve(flag(p, "t") ?? "", "pane");
    this.stopPipe(pane.terminal_id);
    const sink = p.positionals.join(" ");
    if (!sink) return "";
    const words = splitShellWords(sink);
    if (words[0] !== "cat" || words[1] !== ">>" || !words[2] || words.length !== 3) throw new MuxError(`pipe-pane: the herdr backend only supports "cat >> <file>"`);
    const path = words[2];
    const argv = [this.opts.herdrBin ?? "herdr", ...(this.opts.herdrSession ? ["--session", this.opts.herdrSession] : []), "terminal", "session", "observe", pane.pane_id];
    const child = this.spawn(argv, false);
    this.pipes.set(pane.terminal_id, child);
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const frame = JSON.parse(line) as { type?: string; bytes?: string };
          if (frame.type === "terminal.frame" && frame.bytes) appendFileSync(path, Buffer.from(frame.bytes, "base64"));
        } catch { /* a non-frame line */ }
      });
    }
    child.on("exit", () => { if (this.pipes.get(pane.terminal_id) === child) this.pipes.delete(pane.terminal_id); });
    return "";
  }

  private stopPipe(terminalId: string): void {
    const child = this.pipes.get(terminalId);
    if (!child) return;
    this.pipes.delete(terminalId);
    child.kill("SIGTERM");
  }

  /** Stop every pipe this mux started (daemon shutdown). */
  close(): void {
    for (const id of [...this.pipes.keys()]) this.stopPipe(id);
  }

  // ---------------------------------------------------------------- state file

  private loadState(): MuxState {
    if (!this.opts.statePath) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.opts.statePath, "utf8")) as Partial<MuxState>;
      return { sessions: parsed.sessions ?? {}, serverOptions: parsed.serverOptions ?? {} };
    } catch {
      return emptyState();
    }
  }

  private saveState(): void {
    if (!this.opts.statePath) return;
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.opts.statePath);
    } catch { /* state is a cache of herdr's truth plus options; a failed write loses only options */ }
  }
}

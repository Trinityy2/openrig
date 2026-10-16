// The CLI's view of the terminal backend: which multiplexer runs the seats (tmux or herdr), and the few herdr
// operations the CLI performs directly instead of shelling out to tmux.
//
// The backend comes from the same `terminal.backend` / `terminal.herdr_session` settings the daemon resolves
// (env > config file > default), through the daemon's one resolver. With herdr, a seat is a herdr tab whose root
// pane carries the metadata token `openrig_session=<session name>` (see the daemon's herdr-mux.ts).

import { execFileSync, spawn } from "node:child_process";
import {
  herdrCliArgs,
  herdrCliEnv,
  resolveTerminalBackend,
  type TerminalBackend,
} from "@openrig/daemon/terminal-backend";
import { ConfigStore } from "./config-store.js";
import type { TmuxProbeResult } from "./tmux-health.js";

export type { TerminalBackend };

/** The pane token that names the seat (tmux session) a herdr tab stands for. */
export const HERDR_SESSION_TOKEN = "openrig_session";

interface BackendSettingsSource {
  resolve(): { terminal?: { backend?: unknown; herdrSession?: unknown } };
}

/**
 * The backend the CLI acts on, resolved like the daemon's: `terminal.backend` and `terminal.herdr_session` from
 * the settings (env overrides the config file), else the env alone when the config can't be read.
 */
export function cliTerminalBackend(store: BackendSettingsSource = new ConfigStore(), env: NodeJS.ProcessEnv = process.env): TerminalBackend {
  let terminal: { backend?: unknown; herdrSession?: unknown } | undefined;
  try {
    terminal = store.resolve().terminal;
  } catch {
    terminal = undefined;
  }
  return resolveTerminalBackend(env, terminal ? { backend: terminal.backend, herdrSession: terminal.herdrSession } : undefined);
}

/** Runs the herdr CLI with argv (after the backend's `--session`), returning stdout; throws on failure. */
export type HerdrExecFn = (args: string[]) => string;

export function defaultHerdrExec(backend: TerminalBackend, env: NodeJS.ProcessEnv = process.env): HerdrExecFn {
  return (args) => execFileSync("herdr", [...herdrCliArgs(backend), ...args], {
    encoding: "utf-8",
    env: herdrCliEnv(backend, env),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}

export interface HerdrPaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  tokens?: Record<string, string>;
}

function herdrResult(output: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as { result?: Record<string, unknown>; error?: unknown };
  if (parsed.error != null || !parsed.result) throw new Error(`herdr error: ${JSON.stringify(parsed.error ?? parsed)}`);
  return parsed.result;
}

/** Every pane herdr holds (`herdr pane list`). */
export function listHerdrPanes(exec: HerdrExecFn): HerdrPaneInfo[] {
  const panes = herdrResult(exec(["pane", "list"]))["panes"];
  return Array.isArray(panes) ? panes.filter((p): p is HerdrPaneInfo => !!p && typeof (p as HerdrPaneInfo).pane_id === "string") : [];
}

/** The root pane of the herdr tab that runs seat `session`, or null when herdr holds no such seat. */
export function findHerdrSeatPane(session: string, exec: HerdrExecFn): HerdrPaneInfo | null {
  return listHerdrPanes(exec).find((p) => p.tokens?.[HERDR_SESSION_TOKEN] === session) ?? null;
}

/** The seat a herdr pane belongs to: its own `openrig_session` token, else that of its tab's root pane. */
export function herdrSeatForPane(paneId: string, exec: HerdrExecFn): string | null {
  const panes = listHerdrPanes(exec);
  const pane = panes.find((p) => p.pane_id === paneId);
  if (!pane) return null;
  const own = pane.tokens?.[HERDR_SESSION_TOKEN];
  if (own) return own;
  return panes.find((p) => p.tab_id === pane.tab_id && p.tokens?.[HERDR_SESSION_TOKEN])?.tokens?.[HERDR_SESSION_TOKEN] ?? null;
}

/** Focus the seat's herdr tab in the herdr client. Returns the seat's root pane, or null when there is no such seat. */
export function focusHerdrSeat(session: string, exec: HerdrExecFn): HerdrPaneInfo | null {
  const pane = findHerdrSeatPane(session, exec);
  if (!pane) return null;
  exec(["tab", "focus", pane.tab_id]);
  return pane;
}

/** Close the seat's herdr tab (the herdr form of `tmux kill-session`). False when it can't be found or closed. */
export function closeHerdrSeat(session: string, exec: HerdrExecFn): boolean {
  try {
    const pane = findHerdrSeatPane(session, exec);
    if (!pane) return false;
    exec(["tab", "close", pane.tab_id]);
    return true;
  } catch {
    return false;
  }
}

export interface AttachHerdrSeatOptions {
  /** Attach the seat's terminal stream into this terminal (`herdr terminal attach`) instead of focusing it. */
  stream?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Whether this process has a terminal to hand to an interactive herdr client (default: stdin and stdout are TTYs). */
  interactive?: boolean;
  /** Runs an interactive herdr command with inherited stdio and resolves its exit code. */
  run?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  notice?: (message: string) => void;
}

function runInherited(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Bring the person to a seat running on herdr (the herdr form of `tmux attach -t <session>`): focus the seat's
 * herdr tab; outside herdr, then open the herdr client, which shows it. With `stream`, attach the seat's terminal
 * stream into this terminal instead (a viewer tile). Resolves the exit code; throws when herdr holds no such seat.
 */
export async function attachHerdrSeat(session: string, backend: TerminalBackend, exec: HerdrExecFn = defaultHerdrExec(backend), opts: AttachHerdrSeatOptions = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? runInherited;
  const childEnv = herdrCliEnv(backend, env);
  const missing = () => new Error(`herdr holds no pane for seat ${session}. Check rig ps --nodes; the seat may be stopped.`);
  if (opts.stream) {
    const pane = findHerdrSeatPane(session, exec);
    if (!pane) throw missing();
    return run("herdr", [...herdrCliArgs(backend), "terminal", "attach", pane.terminal_id], childEnv);
  }
  if (!focusHerdrSeat(session, exec)) throw missing();
  // Inside herdr, the client this shell sits in now shows the seat.
  if (env["HERDR_ENV"] === "1" && env["HERDR_PANE_ID"]) return 0;
  const interactive = opts.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const client = herdrShellCommand(backend, []);
  if (!interactive) {
    (opts.notice ?? ((m: string) => process.stderr.write(`${m}\n`)))(`Focused seat ${session} in herdr. Open herdr to see it: ${client}`);
    return 0;
  }
  return run("herdr", herdrCliArgs(backend), childEnv);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A shell command line running herdr against the backend's server (for string-exec callers such as doctor). */
export function herdrShellCommand(backend: TerminalBackend, args: string[]): string {
  const argv = ["herdr", ...herdrCliArgs(backend), ...args].map(shellQuote).join(" ");
  if (backend.kind !== "herdr") return argv;
  if (backend.socketPath) return `env HERDR_SOCKET_PATH=${shellQuote(backend.socketPath)} ${argv}`;
  if (backend.herdrSession) return `env -u HERDR_SOCKET_PATH -u HERDR_SESSION ${argv}`;
  return argv;
}

function errorMessage(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : stderr instanceof Buffer && stderr.length ? stderr.toString("utf8") : "";
  return (text || (err instanceof Error ? err.message : String(err))).trim();
}

/** herdr answers "no server" when its socket has no server behind it; the daemon starts one with the first seat. */
export function isHerdrNoServerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("server_not_running")
    || normalized.includes("no herdr server")
    || normalized.includes("econnrefused")
    || (normalized.includes("enoent") && normalized.includes("sock"));
}

export function buildHerdrControlFailure(message: string): { message: string; reason: string; fix: string } {
  return {
    message: "herdr installed, but its control socket is unhealthy.",
    reason: `With terminal.backend herdr, OpenRig runs every seat as a herdr pane and controls it through herdr's socket. The socket is returning: ${message}`,
    fix: "Check `herdr status server`; restart the herdr server (herdr server stop, then herdr) before retrying OpenRig.",
  };
}

function classify(version: string | null, listError: unknown | null, versionError: unknown | null): TmuxProbeResult {
  if (version === null) {
    return { installed: false, available: false, version: null, detail: errorMessage(versionError), code: "not_installed" };
  }
  if (listError === null) return { installed: true, available: true, version, detail: null, code: "available" };
  const detail = errorMessage(listError);
  return isHerdrNoServerMessage(detail)
    ? { installed: true, available: true, version, detail, code: "no_server" }
    : { installed: true, available: false, version, detail, code: "unhealthy" };
}

/** `herdr --version`, then whether the backend's socket answers (`herdr pane list`). Same shape as the tmux probe. */
export function probeHerdrControl(exec: (cmd: string) => string, backend: TerminalBackend): TmuxProbeResult {
  let version: string;
  try {
    version = exec("herdr --version").trim();
  } catch (err) {
    return classify(null, null, err);
  }
  try {
    exec(herdrShellCommand(backend, ["pane", "list"]));
    return classify(version, null, null);
  } catch (err) {
    return classify(version, err, null);
  }
}

export async function probeHerdrControlAsync(exec: (cmd: string) => Promise<string>, backend: TerminalBackend): Promise<TmuxProbeResult> {
  let version: string;
  try {
    version = (await exec("herdr --version")).trim();
  } catch (err) {
    return classify(null, null, err);
  }
  try {
    await exec(herdrShellCommand(backend, ["pane", "list"]));
    return classify(version, null, null);
  } catch (err) {
    return classify(version, err, null);
  }
}

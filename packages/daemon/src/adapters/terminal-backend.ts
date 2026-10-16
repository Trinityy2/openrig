import { resolveHerdrSocketPath } from "../domain/terminal/herdr-transport.js";

/** Which terminal multiplexer runs the daemon's seats. */
export type TerminalBackend =
  | { kind: "tmux" }
  | { kind: "herdr"; herdrSession?: string; socketPath?: string };

/** The resolved `terminal.backend` / `terminal.herdr_session` settings (env already applied by the settings store). */
export interface TerminalBackendSettings {
  backend?: unknown;
  herdrSession?: unknown;
}

/**
 * The backend that runs the seats: `tmux` (the default) or `herdr`.
 *
 * With `settings`, the resolved `terminal.backend` and `terminal.herdr_session` values decide (the settings store
 * already applies env > config file > default, so `OPENRIG_TERMINAL_BACKEND` / `OPENRIG_HERDR_SESSION` still
 * override). Without them, the env variables alone decide. `OPENRIG_HERDR_SOCKET` names a socket path; with no
 * session and no socket, herdr is reached where its own environment points (`HERDR_SOCKET_PATH`, `HERDR_SESSION`,
 * else the default socket). The daemon and the CLI both resolve through this one function.
 */
export function resolveTerminalBackend(env: NodeJS.ProcessEnv, settings?: TerminalBackendSettings): TerminalBackend {
  const fromSettings = settings?.backend !== undefined && settings.backend !== null;
  const value = fromSettings ? String(settings!.backend) : env.OPENRIG_TERMINAL_BACKEND ?? "";
  const raw = value.trim().toLowerCase();
  if (raw === "" || raw === "tmux") return { kind: "tmux" };
  if (raw !== "herdr") {
    const name = fromSettings ? "terminal.backend" : "OPENRIG_TERMINAL_BACKEND";
    throw new Error(`${name} must be "tmux" or "herdr", not "${value}".`);
  }
  const sessionValue = settings?.herdrSession !== undefined && settings.herdrSession !== null
    ? String(settings.herdrSession) : env.OPENRIG_HERDR_SESSION ?? "";
  const herdrSession = sessionValue.trim() || undefined;
  const socketPath = env.OPENRIG_HERDR_SOCKET?.trim() || undefined;
  return { kind: "herdr", ...(herdrSession ? { herdrSession } : {}), ...(socketPath ? { socketPath } : {}) };
}

/** `--session NAME` for a herdr CLI call when the backend names a herdr session; otherwise nothing. */
export function herdrCliArgs(backend: TerminalBackend): string[] {
  // An explicit socket wins: `--session` would derive a socket path of its own from HOME.
  return backend.kind === "herdr" && backend.herdrSession && !backend.socketPath ? ["--session", backend.herdrSession] : [];
}

/**
 * The environment for a herdr CLI child so it reaches the backend's server: an explicit socket is named by
 * `HERDR_SOCKET_PATH`; a named session drops inherited socket pointers so `--session` decides; otherwise the
 * caller's own herdr environment is kept.
 */
export function herdrCliEnv(backend: TerminalBackend, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (backend.kind !== "herdr") return env;
  if (backend.socketPath) return { ...env, HERDR_SOCKET_PATH: backend.socketPath };
  if (backend.herdrSession) {
    const out = { ...env };
    delete out.HERDR_SOCKET_PATH;
    delete out.HERDR_SESSION;
    return out;
  }
  return env;
}

/** The control socket the herdr backend uses (the same resolution HerdrMux applies). */
export function herdrBackendSocketPath(backend: Extract<TerminalBackend, { kind: "herdr" }>, env: NodeJS.ProcessEnv): string {
  if (backend.socketPath) return backend.socketPath;
  return resolveHerdrSocketPath(backend.herdrSession ? { ...env, HERDR_SOCKET_PATH: "", HERDR_SESSION: backend.herdrSession } : env);
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * The command that brings a person to a seat running on herdr: `rig attach <session>` focuses the seat's herdr
 * tab (and opens the herdr client when run outside herdr). `stream` attaches the seat's terminal stream into the
 * current terminal instead, for a viewer tile.
 */
export function herdrAttachCommand(session: string, opts: { stream?: boolean } = {}): string {
  return `rig attach ${shellWord(session)}${opts.stream ? " --stream" : ""}`;
}

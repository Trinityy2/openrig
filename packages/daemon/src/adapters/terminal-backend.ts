/** Which terminal multiplexer runs the daemon's seats. */
export type TerminalBackend =
  | { kind: "tmux" }
  | { kind: "herdr"; herdrSession?: string; socketPath?: string };

/**
 * The backend named by `OPENRIG_TERMINAL_BACKEND` (`tmux`, the default, or `herdr`). For herdr,
 * `OPENRIG_HERDR_SESSION` names a herdr session (`herdr --session NAME`) and `OPENRIG_HERDR_SOCKET` a socket path;
 * with neither, the daemon uses the herdr server its own environment points at (`HERDR_SOCKET_PATH`,
 * `HERDR_SESSION`, else the default socket).
 */
export function resolveTerminalBackend(env: NodeJS.ProcessEnv): TerminalBackend {
  const raw = (env.OPENRIG_TERMINAL_BACKEND ?? "").trim().toLowerCase();
  if (raw === "" || raw === "tmux") return { kind: "tmux" };
  if (raw !== "herdr") throw new Error(`OPENRIG_TERMINAL_BACKEND must be "tmux" or "herdr", not "${env.OPENRIG_TERMINAL_BACKEND}".`);
  const herdrSession = env.OPENRIG_HERDR_SESSION?.trim() || undefined;
  const socketPath = env.OPENRIG_HERDR_SOCKET?.trim() || undefined;
  return { kind: "herdr", ...(herdrSession ? { herdrSession } : {}), ...(socketPath ? { socketPath } : {}) };
}

// The terminal-backend resolver, for the CLI: one resolver decides tmux or herdr for the daemon and the CLI.
export {
  herdrAttachCommand,
  herdrBackendSocketPath,
  herdrCliArgs,
  herdrCliEnv,
  resolveTerminalBackend,
  type TerminalBackend,
  type TerminalBackendSettings,
} from "./adapters/terminal-backend.js";
export { herdrTerminalNumber, HERDR_SESSION_TOKEN } from "./adapters/herdr-mux.js";

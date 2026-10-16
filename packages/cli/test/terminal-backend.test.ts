// The CLI's terminal calls follow terminal.backend: with herdr no tmux is required, and every direct tmux call
// (identity, attach, destroy, chatroom, doctor/preflight/setup, the terminal window) acts on herdr instead.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  attachHerdrSeat,
  cliTerminalBackend,
  closeHerdrSeat,
  findHerdrSeatPane,
  focusHerdrSeat,
  herdrSeatForPane,
  herdrShellCommand,
  probeHerdrControl,
  probeHerdrControlAsync,
  type HerdrExecFn,
  type TerminalBackend,
} from "../src/terminal-backend.js";
import { ConfigStore } from "../src/config-store.js";
import { killTmuxSessionWithCli } from "../src/destroy-helpers.js";
import { attachCommand, attachToSeat, resolveAttachContext, resolveHerdrAttachContext } from "../src/commands/attach.js";
import { resolveIdentitySource } from "../src/commands/whoami.js";
import { startHerdrChatroomWatch } from "../src/commands/chatroom.js";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { runSetup, type SetupDeps } from "../src/commands/setup.js";
import { SystemPreflight } from "../src/system-preflight.js";
import { attachSharedTui } from "../src/shared-tui.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import type { DaemonClient } from "../src/client.js";

const HERDR: TerminalBackend = { kind: "herdr" };
const TMUX: TerminalBackend = { kind: "tmux" };

// Two seats: dev-impl@demo (a tab with a split) and dev-qa@demo, plus a person's own pane.
const PANES = [
  { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term_10", tokens: { openrig_session: "dev-impl@demo" } },
  { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term_1f" },
  { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", terminal_id: "term_20", tokens: { openrig_session: "dev-qa@demo" } },
  { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term_30" },
];

function fakeHerdr(panes = PANES): HerdrExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = ((args: string[]) => {
    calls.push(args);
    if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ id: "cli:pane:list", result: { panes, type: "pane_list" } });
    if (args[0] === "tab" && (args[1] === "focus" || args[1] === "close")) return JSON.stringify({ result: { type: "ok" } });
    if (args[0] === "workspace" && args[1] === "create") {
      return JSON.stringify({ result: { root_pane: { pane_id: "w9:p1" }, workspace: { workspace_id: "w9" } } });
    }
    return JSON.stringify({ result: { type: "ok" } });
  }) as HerdrExecFn & { calls: string[][] };
  exec.calls = calls;
  return exec;
}

const ENV_KEYS = ["TMUX_PANE", "HERDR_PANE_ID", "HERDR_ENV", "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "RIGGED_NODE_ID", "RIGGED_SESSION_NAME", "OPENRIG_TERMINAL_BACKEND"];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("cliTerminalBackend", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cli-terminal-backend-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves terminal.backend / terminal.herdr_session like the daemon (env > config file > default)", () => {
    const store = new ConfigStore(join(dir, "config.json"));
    expect(cliTerminalBackend(store, {})).toEqual(TMUX);
    store.set("terminal.backend", "herdr");
    store.set("terminal.herdr_session", "rigs");
    expect(cliTerminalBackend(store, {})).toEqual({ kind: "herdr", herdrSession: "rigs" });
    process.env["OPENRIG_TERMINAL_BACKEND"] = "tmux";
    expect(cliTerminalBackend(store, process.env)).toEqual(TMUX);
    expect(() => store.set("terminal.backend", "screen")).toThrow(/must be "tmux" or "herdr"/);
    // A store whose config can't be read falls back to the env alone.
    expect(cliTerminalBackend({ resolve: () => { throw new Error("bad config"); } }, { OPENRIG_TERMINAL_BACKEND: "herdr" })).toEqual(HERDR);
  });
});

describe("herdr seat operations", () => {
  it("finds a seat's root pane by its openrig_session token, and the seat a split pane belongs to", () => {
    const exec = fakeHerdr();
    expect(findHerdrSeatPane("dev-qa@demo", exec)?.pane_id).toBe("w1:p3");
    expect(findHerdrSeatPane("nope@demo", exec)).toBeNull();
    expect(herdrSeatForPane("w1:p1", exec)).toBe("dev-impl@demo");
    expect(herdrSeatForPane("w1:p2", exec)).toBe("dev-impl@demo");
    expect(herdrSeatForPane("w2:p1", exec)).toBeNull();
  });

  it("focuses and closes the seat's tab", () => {
    const exec = fakeHerdr();
    expect(focusHerdrSeat("dev-qa@demo", exec)?.tab_id).toBe("w1:t2");
    expect(exec.calls).toContainEqual(["tab", "focus", "w1:t2"]);
    expect(closeHerdrSeat("dev-impl@demo", exec)).toBe(true);
    expect(exec.calls).toContainEqual(["tab", "close", "w1:t1"]);
    expect(closeHerdrSeat("gone@demo", exec)).toBe(false);
    expect(closeHerdrSeat("dev-impl@demo", () => { throw new Error("server_not_running"); })).toBe(false);
  });

  it("builds herdr shell commands against the backend's server", () => {
    expect(herdrShellCommand(HERDR, ["pane", "list"])).toBe("herdr pane list");
    expect(herdrShellCommand({ kind: "herdr", herdrSession: "rigs" }, ["pane", "list"])).toBe("env -u HERDR_SOCKET_PATH -u HERDR_SESSION herdr --session rigs pane list");
    expect(herdrShellCommand({ kind: "herdr", socketPath: "/a b.sock" }, [])).toBe("env HERDR_SOCKET_PATH='/a b.sock' herdr");
  });

  it("probes herdr instead of tmux: missing, no server yet, healthy, unhealthy", async () => {
    const probe = (list: () => string, version = () => "herdr 0.9.3") => (cmd: string) => cmd === "herdr --version" ? version() : list();
    expect(probeHerdrControl(probe(() => "{}"), HERDR)).toMatchObject({ code: "available", available: true, version: "herdr 0.9.3" });
    expect(probeHerdrControl(probe(() => { throw new Error('{"error":{"code":"server_not_running"}}'); }), HERDR)).toMatchObject({ code: "no_server", available: true });
    expect(probeHerdrControl(probe(() => { throw new Error("protocol mismatch"); }), HERDR)).toMatchObject({ code: "unhealthy", available: false });
    expect(probeHerdrControl(probe(() => "", () => { throw new Error("command not found: herdr"); }), HERDR)).toMatchObject({ code: "not_installed" });
    expect(await probeHerdrControlAsync(async (cmd) => cmd === "herdr --version" ? "herdr 0.9.3" : "{}", HERDR)).toMatchObject({ code: "available" });
  });

  it("attaches by focusing the tab; outside herdr it opens the herdr client; --stream attaches the terminal stream", async () => {
    const run = vi.fn(async () => 0);
    const inside = fakeHerdr();
    expect(await attachHerdrSeat("dev-qa@demo", HERDR, inside, { env: { HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1" }, run })).toBe(0);
    expect(inside.calls).toContainEqual(["tab", "focus", "w1:t2"]);
    expect(run).not.toHaveBeenCalled();

    expect(await attachHerdrSeat("dev-qa@demo", { kind: "herdr", herdrSession: "rigs" }, fakeHerdr(), { env: {}, interactive: true, run })).toBe(0);
    expect(run).toHaveBeenLastCalledWith("herdr", ["--session", "rigs"], expect.any(Object));

    const notice = vi.fn();
    await attachHerdrSeat("dev-qa@demo", HERDR, fakeHerdr(), { env: {}, interactive: false, run, notice });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("Focused seat dev-qa@demo in herdr"));

    await attachHerdrSeat("dev-qa@demo", HERDR, fakeHerdr(), { env: {}, stream: true, run });
    expect(run).toHaveBeenLastCalledWith("herdr", ["terminal", "attach", "term_20"], expect.any(Object));
    await expect(attachHerdrSeat("gone@demo", HERDR, fakeHerdr(), { env: {}, run })).rejects.toThrow(/no pane for seat gone@demo/);
  });
});

describe("destroy closes a seat's herdr tab", () => {
  it("closes the tab with the herdr backend instead of tmux kill-session", () => {
    const exec = fakeHerdr();
    expect(killTmuxSessionWithCli("dev-impl@demo", HERDR, exec)).toBe(true);
    expect(exec.calls).toContainEqual(["tab", "close", "w1:t1"]);
    expect(killTmuxSessionWithCli("missing@demo", HERDR, fakeHerdr())).toBe(false);
  });
});

describe("rig attach <session>", () => {
  it("tmux attaches with the tmux backend and focuses herdr with the herdr backend", async () => {
    const tmuxAttach = vi.fn(async () => 0);
    expect(await attachToSeat("dev-qa@demo", {}, { backend: () => TMUX, tmuxAttach })).toBe(0);
    expect(tmuxAttach).toHaveBeenCalledWith("dev-qa@demo");
    const exec = fakeHerdr();
    const run = vi.fn(async () => 0);
    expect(await attachToSeat("dev-qa@demo", {}, { backend: () => HERDR, herdrExec: exec, herdr: { env: { HERDR_ENV: "1", HERDR_PANE_ID: "x" }, run } })).toBe(0);
    expect(exec.calls).toContainEqual(["tab", "focus", "w1:t2"]);
    expect(tmuxAttach).toHaveBeenCalledTimes(1);
  });

  it("parses a session positional without --self/--rig, and still requires them otherwise", async () => {
    const tmuxAttach = vi.fn(async () => 0);
    const prog = new Command();
    prog.exitOverride();
    const cmd = attachCommand(undefined, { backend: () => TMUX, tmuxAttach });
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    prog.addCommand(cmd);
    await prog.parseAsync(["node", "rig", "attach", "dev-qa@demo"]);
    expect(tmuxAttach).toHaveBeenCalledWith("dev-qa@demo");
    await expect(prog.parseAsync(["node", "rig", "attach", "--rig", "r1", "--node", "a.b"])).rejects.toThrow(/required option '--self'/);
  });

  it("binds a shell inside a seat's herdr tab with the daemon's tmux-shaped ids", () => {
    expect(resolveHerdrAttachContext("w1:p2", fakeHerdr())).toEqual({
      attachmentType: "tmux", tmuxSession: "dev-impl@demo", tmuxWindow: "@16", tmuxPane: "%31",
    });
    expect(resolveHerdrAttachContext("w2:p1", fakeHerdr())).toEqual({ attachmentType: "external_cli" });
    expect(resolveHerdrAttachContext(undefined, fakeHerdr())).toEqual({ attachmentType: "external_cli" });
    process.env["HERDR_PANE_ID"] = "w1:p3";
    expect(resolveAttachContext(() => "", HERDR, fakeHerdr())).toMatchObject({ tmuxSession: "dev-qa@demo", tmuxPane: "%32" });
    expect(resolveAttachContext(() => "", TMUX, fakeHerdr())).toEqual({ attachmentType: "external_cli" });
  });
});

describe("whoami inside a herdr pane", () => {
  it("identifies the seat from HERDR_PANE_ID with the herdr backend only", () => {
    process.env["HERDR_PANE_ID"] = "w1:p2";
    expect(resolveIdentitySource({}, () => "", HERDR, fakeHerdr())).toEqual({ sessionName: "dev-impl@demo" });
    expect(resolveIdentitySource({}, () => "", TMUX, fakeHerdr())).toBeNull();
    process.env["OPENRIG_NODE_ID"] = "node-7";
    expect(resolveIdentitySource({}, () => "", HERDR, fakeHerdr())).toEqual({ nodeId: "node-7" });
  });
});

describe("chatroom watch --tmux with the herdr backend", () => {
  it("runs the watch in a new herdr workspace", () => {
    const exec = fakeHerdr();
    expect(startHerdrChatroomWatch("demo", HERDR, exec)).toEqual([
      "Started watch in herdr workspace: chatroom@demo",
      "Show it with: herdr workspace focus w9",
    ]);
    expect(exec.calls).toContainEqual(["workspace", "create", "--label", "chatroom@demo", "--no-focus"]);
    expect(exec.calls).toContainEqual(["pane", "run", "w9:p1", 'rig chatroom watch "demo"']);
  });
});

describe("doctor, preflight and setup need herdr, not tmux, with the herdr backend", () => {
  const exec = (cmd: string): string => {
    if (cmd === "herdr --version") return "herdr 0.9.3\n";
    if (cmd.includes("tmux")) throw new Error(`tmux must not be called: ${cmd}`);
    if (cmd === "herdr pane list") return "{}";
    if (cmd === "brew --version") return "Homebrew 4.0\n";
    if (cmd === "claude --version") return "2.1.101 (Claude Code)\n";
    if (cmd === "claude auth status") return "Authenticated\n";
    if (cmd === "codex --version") return "codex-cli 0.118.0\n";
    if (cmd === "codex login status") return "Logged in\n";
    return "";
  };

  it("doctor reports herdr and no tmux checks", () => {
    const deps: DoctorDeps = {
      exists: () => true, baseDir: "/install/cli/dist", readFile: () => null, exec, checkPort: async () => true,
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/x.sqlite" }, transcripts: { enabled: false, path: "/tmp/t" } }) } as never,
      platform: "darwin", mkdirp: () => {}, checkWritable: () => {}, terminalBackend: HERDR,
    };
    const { checks } = runDoctorChecks(deps, []);
    expect(checks.find((c) => c.name === "herdr")).toMatchObject({ status: "pass", message: "herdr 0.9.3" });
    expect(checks.some((c) => c.name === "tmux" || c.name === "tmux_mouse")).toBe(false);
    const missing = runDoctorChecks({ ...deps, exec: (cmd) => { if (cmd.startsWith("herdr")) throw new Error("not found"); return exec(cmd); } }, []);
    expect(missing.checks.find((c) => c.name === "herdr")).toMatchObject({ status: "fail", message: "herdr not found." });
  });

  it("preflight checks herdr when terminal.backend is herdr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-preflight-herdr-"));
    try {
      const store = new ConfigStore(join(dir, "config.json"));
      store.set("terminal.backend", "herdr");
      mkdirSync(join(dir, ".openrig"), { recursive: true });
      const pf = new SystemPreflight({ exec: async (cmd) => exec(cmd), configStore: store, getDaemonStatus: async () => ({ state: "stopped" as const }), riggedHome: join(dir, ".openrig") });
      const result = await pf.run({ port: 0 });
      expect(result.checks.find((c) => c.name === "herdr")).toEqual({ name: "herdr", ok: true });
      expect(result.checks.some((c) => c.name === "tmux")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("setup skips tmux and its config, and requires herdr", async () => {
    const writeFile = vi.fn();
    const deps: SetupDeps = { exec, readFile: () => null, writeFile, exists: () => false, platform: "darwin", mkdirp: vi.fn(), terminalBackend: HERDR };
    const result = await runSetup(deps, {});
    expect(result.steps.find((s) => s.id === "tmux_install")).toMatchObject({ status: "skipped" });
    expect(result.steps.find((s) => s.id === "tmux_config")).toMatchObject({ status: "skipped" });
    expect(result.steps.find((s) => s.id === "herdr_install")).toMatchObject({ status: "pass" });
    expect(writeFile).not.toHaveBeenCalledWith(expect.stringContaining(".tmux.conf"), expect.anything());
    const declined = await runSetup(deps, { herdr: false });
    expect(declined.steps.find((s) => s.id === "herdr_install")).toMatchObject({ status: "fail" });
  });
});

describe("shared TUI and the terminal window with the herdr backend", () => {
  it("rig tui --shared focuses the shared terminal's herdr pane", async () => {
    const exec = fakeHerdr();
    process.env["HERDR_ENV"] = "1";
    process.env["HERDR_PANE_ID"] = "w2:p1";
    expect(await attachSharedTui("dev-impl@demo", HERDR, exec)).toBe(0);
    expect(exec.calls).toContainEqual(["tab", "focus", "w1:t1"]);
  });

  it("focuses the view's first seat instead of composing tmux attachments", async () => {
    const opened = [{ seat: "dev-impl@demo", label: "impl", paneCommand: "x" }, { seat: "dev-qa@demo", label: "qa", paneCommand: "y" }];
    const preview = { planId: "p1", composed: { id: "rig:demo", opened, pages: [opened], absent: [], degraded: [] }, status: {} };
    const get = vi.fn(async () => ({ status: 200, data: preview }));
    const post = vi.fn();
    const client = { baseUrl: "http://localhost:7433", get, post } as unknown as DaemonClient;
    const herdrExec = fakeHerdr();
    const exec = vi.fn(async () => { throw new Error("no window tooling in this test"); });
    const deps: WindowDeps = {
      platform: "darwin", env: { HOME: "/fixture", HERDR_ENV: "1", HERDR_PANE_ID: "w2:p1", HERDR_SOCKET_PATH: "/h.sock" }, exists: () => false,
      exec, launch: vi.fn(), sleep: vi.fn(async () => {}), id: () => "id", herdrConfig: vi.fn(() => ""), backend: HERDR, herdrExec,
    };
    const result = await openTerminalWindow(client, "rig:demo", undefined, deps);
    expect(result).toMatchObject({ ok: true, provider: "herdr", opened: ["dev-impl@demo", "dev-qa@demo"] });
    expect(herdrExec.calls).toContainEqual(["tab", "focus", "w1:t1"]);
    expect(post).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([file]) => String(file).includes("tmux"))).toBe(false);
    const refused = await openTerminalWindow(client, "rig:demo", "tmux", deps);
    expect(refused).toMatchObject({ ok: false });
  });
});

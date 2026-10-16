// The terminal backend (tmux | herdr): one resolver for the daemon and the CLI, the settings keys that feed it,
// and the attach strings, view tiles, runtime check and health field that follow it.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  herdrAttachCommand,
  herdrBackendSocketPath,
  herdrCliArgs,
  herdrCliEnv,
  resolveTerminalBackend,
} from "../src/adapters/terminal-backend.js";
import { daemonTerminalBackend, setDaemonTerminalBackend, tmuxAttachCommand } from "../src/adapters/tmux-server.js";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("resolveTerminalBackend", () => {
  it("defaults to tmux and reads OPENRIG_TERMINAL_BACKEND without settings", () => {
    expect(resolveTerminalBackend({})).toEqual({ kind: "tmux" });
    expect(resolveTerminalBackend({ OPENRIG_TERMINAL_BACKEND: " TMUX " })).toEqual({ kind: "tmux" });
    expect(resolveTerminalBackend({ OPENRIG_TERMINAL_BACKEND: "herdr", OPENRIG_HERDR_SESSION: "rigs", OPENRIG_HERDR_SOCKET: "/s.sock" }))
      .toEqual({ kind: "herdr", herdrSession: "rigs", socketPath: "/s.sock" });
    expect(() => resolveTerminalBackend({ OPENRIG_TERMINAL_BACKEND: "screen" })).toThrow(/OPENRIG_TERMINAL_BACKEND must be "tmux" or "herdr"/);
  });

  it("takes the resolved settings over the raw env (the store already applied env > file > default)", () => {
    expect(resolveTerminalBackend({ OPENRIG_TERMINAL_BACKEND: "herdr" }, { backend: "tmux", herdrSession: "" })).toEqual({ kind: "tmux" });
    expect(resolveTerminalBackend({}, { backend: "herdr", herdrSession: "" })).toEqual({ kind: "herdr" });
    expect(resolveTerminalBackend({ OPENRIG_HERDR_SOCKET: "/x.sock" }, { backend: "herdr", herdrSession: "rigs" }))
      .toEqual({ kind: "herdr", herdrSession: "rigs", socketPath: "/x.sock" });
    expect(() => resolveTerminalBackend({}, { backend: "zellij" })).toThrow(/terminal\.backend must be/);
  });

  it("builds herdr CLI argv/env that reach the backend's server", () => {
    expect(herdrCliArgs({ kind: "tmux" })).toEqual([]);
    expect(herdrCliArgs({ kind: "herdr" })).toEqual([]);
    expect(herdrCliArgs({ kind: "herdr", herdrSession: "rigs" })).toEqual(["--session", "rigs"]);
    const env = { HERDR_SOCKET_PATH: "/mine.sock", HERDR_SESSION: "mine", PATH: "/bin" };
    expect(herdrCliEnv({ kind: "herdr" }, env)).toBe(env);
    expect(herdrCliEnv({ kind: "herdr", socketPath: "/rigs.sock" }, env)).toMatchObject({ HERDR_SOCKET_PATH: "/rigs.sock", PATH: "/bin" });
    const named = herdrCliEnv({ kind: "herdr", herdrSession: "rigs" }, env);
    expect(named.HERDR_SOCKET_PATH).toBeUndefined();
    expect(named.HERDR_SESSION).toBeUndefined();
    expect(herdrBackendSocketPath({ kind: "herdr", socketPath: "/a.sock" }, env)).toBe("/a.sock");
    expect(herdrBackendSocketPath({ kind: "herdr", herdrSession: "rigs" }, env)).toMatch(/sessions\/rigs\/herdr\.sock$/);
    expect(herdrBackendSocketPath({ kind: "herdr" }, env)).toBe("/mine.sock");
  });
});

describe("attach strings follow the backend", () => {
  afterEach(() => setDaemonTerminalBackend("tmux"));

  it("keeps tmux attach for tmux and gives rig attach for herdr (field names unchanged, values only)", () => {
    expect(daemonTerminalBackend()).toBe("tmux");
    expect(tmuxAttachCommand("dev-impl@demo")).toBe("tmux attach -t dev-impl@demo");
    setDaemonTerminalBackend("herdr");
    expect(tmuxAttachCommand("dev-impl@demo")).toBe("rig attach dev-impl@demo");
    expect(tmuxAttachCommand("odd name@demo")).toBe("rig attach 'odd name@demo'");
    expect(herdrAttachCommand("dev-impl@demo", { stream: true })).toBe("rig attach dev-impl@demo --stream");
  });

  it("composes a herdr-backend local tile from localAttachCommand, never an ssh remote one", () => {
    const local: ViewMemberInput = { seat: "a@r", label: "a", tmuxSession: "a@r", host: null, readOnly: false, alive: true };
    const remote: ViewMemberInput = { seat: "b@r", label: "b", tmuxSession: "b@r", host: "box", readOnly: false, alive: true };
    const ctx = {
      resolveHost: () => ({ id: "box", transport: "ssh" as const, target: "box.local" }),
      localAttachCommand: (session: string) => herdrAttachCommand(session, { stream: true }),
    };
    const view = composeView("v", [local, remote], ctx as never);
    expect(view.opened[0]!.paneCommand).toBe("rig attach a@r --stream");
    expect(view.opened[1]!.paneCommand).toContain("tmux attach -t");
    // Without the override the local tile is today's tmux attach.
    expect(composeView("v", [local], { resolveHost: () => null }).opened[0]!.paneCommand).toBe("tmux attach -t 'a@r'");
  });
});

describe("terminal.backend / terminal.herdr_session settings", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-terminal-backend-"));
    configPath = join(dir, "config.json");
    writeFileSync(configPath, "{}\n");
  });
  afterEach(() => {
    delete process.env["OPENRIG_TERMINAL_BACKEND"];
    delete process.env["OPENRIG_HERDR_SESSION"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to tmux and an empty herdr session, with env > file precedence and closed-set validation", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("terminal.backend")).toMatchObject({ value: "tmux", source: "default" });
    expect(store.resolveOne("terminal.herdr_session")).toMatchObject({ value: "", source: "default" });
    store.set("terminal.backend", "herdr");
    store.set("terminal.herdr_session", "rigs");
    expect(store.resolveOne("terminal.backend")).toMatchObject({ value: "herdr", source: "file" });
    expect(store.resolveOne("terminal.herdr_session")).toMatchObject({ value: "rigs", source: "file" });
    process.env["OPENRIG_TERMINAL_BACKEND"] = "tmux";
    expect(store.resolveOne("terminal.backend")).toMatchObject({ value: "tmux", source: "env" });
    expect(() => store.set("terminal.backend", "screen")).toThrow(/must be "tmux" or "herdr"/);
  });
});

describe("RuntimeVerifier with the herdr backend", () => {
  function exec(responses: Record<string, string>): ExecFn {
    return vi.fn(async (cmd: string) => {
      for (const [pattern, out] of Object.entries(responses)) if (cmd.includes(pattern)) return out;
      throw new Error("command not found");
    }) as unknown as ExecFn;
  }

  it("verifies herdr instead of tmux for the terminal requirement; an unanswered socket is degraded", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const run = exec({ "herdr --version": "herdr 0.9.3" });
    const ok = new RuntimeVerifier({ exec: run, db, terminalBackend: "herdr", probeHerdrSocket: async () => true });
    const [verified] = await ok.verifyAll(["tmux"]);
    expect(verified).toMatchObject({ runtime: "herdr", status: "verified", version: "0.9.3" });
    expect(run).not.toHaveBeenCalledWith("tmux -V");
    const down = new RuntimeVerifier({ exec: run, db, terminalBackend: "herdr", probeHerdrSocket: async () => false });
    expect((await down.verifyAll(["tmux"]))[0]).toMatchObject({ runtime: "herdr", status: "degraded" });
    const missing = new RuntimeVerifier({ exec: exec({}), db, terminalBackend: "herdr" });
    expect((await missing.verifyAll(["tmux"]))[0]).toMatchObject({ runtime: "herdr", status: "not_found" });
    // The tmux backend still checks tmux.
    const tmux = new RuntimeVerifier({ exec: exec({ "tmux -V": "tmux 3.4" }), db });
    expect((await tmux.verifyAll(["tmux"]))[0]).toMatchObject({ runtime: "tmux", status: "verified" });
    db.close();
  });
});

describe("/healthz terminal backend", () => {
  it("reports the backend when the daemon wires it, and keeps the legacy body otherwise", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db, { appDeps: { terminalBackend: { kind: "herdr", herdrSession: "rigs" } } } as never);
    expect(await (await app.request("/healthz")).json()).toEqual({ status: "ok", pid: process.pid, terminalBackend: { kind: "herdr", herdrSession: "rigs" } });
    const legacy = createTestApp(db);
    expect(await (await legacy.app.request("/healthz")).json()).toEqual({ status: "ok", pid: process.pid });
    db.close();
  });
});

// HerdrMux: TmuxAdapter's exec seam on herdr's socket API. Tests drive the REAL TmuxAdapter wired to the mux (what
// every consumer sees) against an in-memory herdr server, plus a few direct argv calls for parsing edge cases.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERDR_SESSION_TOKEN,
  HerdrMux,
  herdrTerminalNumber,
  herdrWorkspaceLabel,
  splitShellWords,
  translateKeys,
  type HerdrMuxOptions,
} from "../src/adapters/herdr-mux.js";
import { TmuxAdapter, type ExecFn, type TmuxResult } from "../src/adapters/tmux.js";
import type { HerdrResult, HerdrSocketRpc } from "../src/domain/terminal/herdr-transport.js";

// ------------------------------------------------------------------ in-memory herdr server

interface FakeJob { pid: number; name: string }
interface FakePane {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  cwd: string | null;
  revision: number;
  tokens?: Record<string, string>;
  shellPid: number;
  shellName: string;
  /** A foreground job; null means the shell itself is in the foreground. */
  job: FakeJob | null;
  history: string;
  screen: string;
}
interface FakeTab { tab_id: string; workspace_id: string; label: string }
interface FakeWorkspace { workspace_id: string; label: string }
interface Call { method: string; params: Record<string, unknown> }

class FakeHerdr {
  up = true;
  calls: Call[] = [];
  panes: FakePane[] = [];
  tabs: FakeTab[] = [];
  workspaces: FakeWorkspace[] = [];
  focused: string | null = null;
  /** Pane size reported in layouts; null leaves layouts empty (the mux falls back to defaults). */
  rect: { width: number; height: number } | null = { width: 100, height: 30 };
  /** Tab labels whose creation also opens a second pane in the tab. */
  twoPaneTabs = new Set<string>();
  failures = new Map<string, Error>();
  onSendText: ((text: string, pane: FakePane) => void) | null = null;
  private nextTerminal = 0x1a;
  private nextWorkspace = 1;
  private nextPid = 4242;

  callsOf(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  inputCalls(): Call[] {
    return this.calls.filter((c) => ["pane.send_text", "pane.send_keys", "pane.send_input"].includes(c.method));
  }

  paneOf(session: string): FakePane {
    const pane = this.panes.find((p) => p.tokens?.[HERDR_SESSION_TOKEN] === session);
    if (!pane) throw new Error(`no fake pane for ${session}`);
    return pane;
  }

  private newPane(workspaceId: string, tabId: string, cwd: string | null): FakePane {
    const index = this.panes.filter((p) => p.workspace_id === workspaceId).length + 1;
    const pane: FakePane = {
      pane_id: `${workspaceId}:p${index}`,
      tab_id: tabId,
      workspace_id: workspaceId,
      terminal_id: `term_${(this.nextTerminal++).toString(16)}`,
      cwd,
      revision: 0,
      shellPid: this.nextPid++,
      shellName: "-zsh",
      job: null,
      history: "",
      screen: "",
    };
    this.panes.push(pane);
    return pane;
  }

  /** A second pane in the tab, as a user split would make. */
  split(tabId: string): FakePane {
    const tab = this.tabs.find((t) => t.tab_id === tabId)!;
    return this.newPane(tab.workspace_id, tabId, "/split");
  }

  private pane(params: Record<string, unknown>): FakePane {
    const id = String(params["pane_id"]);
    const pane = this.panes.find((p) => p.pane_id === id);
    if (!pane) throw new Error(`herdr error: {"code":"pane_not_found","message":"pane ${id} not found"}`);
    return pane;
  }

  private openTab(workspaceId: string, label: string, cwd: string | null): { tab: FakeTab; root: FakePane } {
    const tab: FakeTab = { tab_id: `${workspaceId}:t${this.tabs.filter((t) => t.workspace_id === workspaceId).length + 1}`, workspace_id: workspaceId, label };
    this.tabs.push(tab);
    const root = this.newPane(workspaceId, tab.tab_id, cwd);
    return { tab, root };
  }

  private paneView(p: FakePane): Record<string, unknown> {
    return { pane_id: p.pane_id, tab_id: p.tab_id, workspace_id: p.workspace_id, terminal_id: p.terminal_id, cwd: p.cwd, focused: p.pane_id === this.focused, revision: p.revision, ...(p.tokens ? { tokens: { ...p.tokens } } : {}) };
  }

  rpc: HerdrSocketRpc = async (req) => {
    if (!this.up) throw Object.assign(new Error(`connect ENOENT /tmp/herdr.sock`), { code: "ENOENT" });
    const params = (req.params ?? {}) as Record<string, unknown>;
    this.calls.push({ method: req.method, params });
    const failure = this.failures.get(req.method);
    if (failure) throw failure;
    return this.handle(req.method, params);
  };

  private handle(method: string, params: Record<string, unknown>): HerdrResult {
    switch (method) {
      case "ping": return { type: "pong", version: "0.5.0" };
      case "session.snapshot":
        return {
          type: "session_snapshot",
          snapshot: {
            panes: this.panes.map((p) => this.paneView(p)),
            tabs: this.tabs.map((t) => ({ ...t, pane_count: this.panes.filter((p) => p.tab_id === t.tab_id).length })),
            workspaces: this.workspaces.map((w) => ({ ...w })),
            layouts: this.rect ? this.tabs.map((t) => ({ tab_id: t.tab_id, panes: this.panes.filter((p) => p.tab_id === t.tab_id).map((p) => ({ pane_id: p.pane_id, rect: { ...this.rect! } })) })) : [],
            focused_pane_id: this.focused,
          },
        };
      case "workspace.create": {
        const workspace: FakeWorkspace = { workspace_id: `w${this.nextWorkspace++}`, label: String(params["label"]) };
        this.workspaces.push(workspace);
        const { tab, root } = this.openTab(workspace.workspace_id, "1", (params["cwd"] as string | null) ?? null);
        return { type: "workspace_created", workspace, tab: { ...tab }, root_pane: this.paneView(root) };
      }
      case "tab.create": {
        const workspaceId = String(params["workspace_id"]);
        if (!this.workspaces.some((w) => w.workspace_id === workspaceId)) throw new Error(`herdr error: {"code":"workspace_not_found","message":"workspace ${workspaceId} not found"}`);
        const label = String(params["label"]);
        const { tab, root } = this.openTab(workspaceId, label, (params["cwd"] as string | null) ?? null);
        if (this.twoPaneTabs.has(label)) this.split(tab.tab_id);
        return { type: "tab_created", tab: { ...tab }, root_pane: this.paneView(root) };
      }
      case "tab.rename": {
        const tab = this.tabs.find((t) => t.tab_id === params["tab_id"]);
        if (!tab) throw new Error(`herdr error: {"code":"tab_not_found","message":"tab not found"}`);
        tab.label = String(params["label"]);
        if (this.twoPaneTabs.has(tab.label)) this.split(tab.tab_id);
        return { type: "ok" };
      }
      case "tab.close": {
        const id = String(params["tab_id"]);
        if (!this.tabs.some((t) => t.tab_id === id)) throw new Error(`herdr error: {"code":"tab_not_found","message":"tab not found"}`);
        this.tabs = this.tabs.filter((t) => t.tab_id !== id);
        this.panes = this.panes.filter((p) => p.tab_id !== id);
        return { type: "ok" };
      }
      case "pane.close": {
        const pane = this.pane(params);
        this.panes = this.panes.filter((p) => p !== pane);
        return { type: "ok" };
      }
      case "pane.report_metadata": this.pane(params).tokens = { ...(params["tokens"] as Record<string, string>) }; return { type: "ok" };
      case "pane.process_info": {
        const pane = this.pane(params);
        const fg = pane.job ?? { pid: pane.shellPid, name: pane.shellName };
        return { type: "process_info", process_info: { shell_pid: pane.shellPid, foreground_process_group_id: fg.pid, foreground_processes: [{ pid: fg.pid, name: fg.name }] } };
      }
      case "pane.read": {
        const pane = this.pane(params);
        return { type: "pane_read", read: { text: params["source"] === "visible" ? pane.screen : pane.history, revision: pane.revision } };
      }
      case "pane.send_text": {
        const pane = this.pane(params);
        this.onSendText?.(String(params["text"]), pane);
        return { type: "ok" };
      }
      case "pane.send_keys": case "pane.send_input": this.pane(params); return { type: "ok" };
      case "pane.focus": this.focused = this.pane(params).pane_id; return { type: "ok" };
      default: throw new Error(`herdr error: {"code":"unknown_method","message":"unknown method ${method}"}`);
    }
  }
}

// ------------------------------------------------------------------ harness

interface Harness {
  fake: FakeHerdr;
  mux: HerdrMux;
  adapter: TmuxAdapter;
  fallback: string[];
  signals: Array<[number, NodeJS.Signals]>;
  spawned: Array<{ argv: string[]; detached: boolean; child: FakeChild }>;
  clock: { ms: number };
}

class FakeChild extends EventEmitter {
  stdout: PassThrough | null;
  killed: NodeJS.Signals[] = [];
  unrefed = false;
  constructor(withStdout: boolean) { super(); this.stdout = withStdout ? new PassThrough() : null; }
  unref(): void { this.unrefed = true; }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean { this.killed.push(signal); return true; }
}

function harness(opts: Partial<HerdrMuxOptions> & { fake?: FakeHerdr; onSpawn?: (argv: string[]) => void } = {}): Harness {
  const fake = opts.fake ?? new FakeHerdr();
  const fallback: string[] = [];
  const signals: Array<[number, NodeJS.Signals]> = [];
  const spawned: Harness["spawned"] = [];
  const clock = { ms: 1_700_000_000_000 };
  const fallbackExec: ExecFn = async (cmd) => { fallback.push(cmd); return ""; };
  const mux = new HerdrMux({
    rpc: fake.rpc,
    socketPath: "/tmp/herdr-test.sock",
    herdrSession: "testsess",
    fallbackExec,
    now: () => clock.ms,
    sleep: async () => {},
    signalProcess: (pid, signal) => { signals.push([pid, signal]); },
    spawnProcess: (argv, detached) => {
      const child = new FakeChild(!detached);
      spawned.push({ argv, detached, child });
      opts.onSpawn?.(argv);
      return child as unknown as ChildProcess;
    },
    ...opts,
  });
  const adapter = new TmuxAdapter(mux.exec, undefined, mux.argvExec);
  return { fake, mux, adapter, fallback, signals, spawned, clock };
}

const PANE_ID = (terminalId: string): string => `%${herdrTerminalNumber(terminalId)}`;

let h: Harness;
let scratch: string;
beforeEach(() => {
  h = harness();
  scratch = mkdtempSync(join(tmpdir(), "herdr-mux-test-"));
});
afterEach(() => {
  h.mux.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function create(name: string, cwd?: string, env?: Record<string, string>): Promise<FakePane> {
  const result = await h.adapter.createSession(name, cwd, env);
  expect(result).toEqual({ ok: true });
  return h.fake.paneOf(name);
}

// ------------------------------------------------------------------ pure functions

describe("pure helpers", () => {
  it("herdrTerminalNumber is the decimal of the terminal id's hex", () => {
    expect(herdrTerminalNumber("term_1a")).toBe("26");
    expect(herdrTerminalNumber("term_FF")).toBe("255");
    expect(herdrTerminalNumber("term_ffffffffffffffffffff")).toBe(BigInt("0xffffffffffffffffffff").toString());
    expect(herdrTerminalNumber("1a")).toBe("26");
  });

  it("herdrTerminalNumber hashes a non-hex id to a stable decimal", () => {
    const n = herdrTerminalNumber("term_xyz");
    expect(n).toMatch(/^\d+$/);
    expect(herdrTerminalNumber("term_xyz")).toBe(n);
    expect(herdrTerminalNumber("term_xyw")).not.toBe(n);
  });

  it("herdrWorkspaceLabel is the rig after the last @, else openrig", () => {
    expect(herdrWorkspaceLabel("dev-impl@my-rig")).toBe("my-rig");
    expect(herdrWorkspaceLabel("a@b@c")).toBe("c");
    expect(herdrWorkspaceLabel("plain")).toBe("openrig");
    expect(herdrWorkspaceLabel("trailing@")).toBe("openrig");
    expect(herdrWorkspaceLabel("@rig")).toBe("rig");
  });

  it("splitShellWords handles quotes and backslashes without expansion", () => {
    expect(splitShellWords("a b  c")).toEqual(["a", "b", "c"]);
    expect(splitShellWords(`tmux new -s 'x y' "a\\"b" c\\ d`)).toEqual(["tmux", "new", "-s", "x y", 'a"b', "c d"]);
    expect(splitShellWords(`'it'"'"'s'`)).toEqual(["it's"]);
    expect(splitShellWords(`'' ""`)).toEqual(["", ""]);
    expect(splitShellWords(`"$HOME \\x"`)).toEqual(["$HOME \\x"]);
    expect(splitShellWords("  ")).toEqual([]);
    expect(splitShellWords("a\\")).toEqual(["a\\"]);
    expect(() => splitShellWords("'open")).toThrow(/unterminated single quote/);
    expect(() => splitShellWords('"open')).toThrow(/unterminated double quote/);
  });

  it("translateKeys maps tmux key names, merges runs, and keeps order", () => {
    expect(translateKeys(["Enter"])).toEqual([{ kind: "keys", keys: ["enter"] }]);
    expect(translateKeys(["C-c", "Escape", "BSpace", "C-m", "BTab", "F5", "M-x", "C-C"])).toEqual([
      { kind: "keys", keys: ["ctrl+c", "esc", "backspace", "enter", "shift+tab", "F5", "alt+x", "ctrl+c"] },
    ]);
    expect(translateKeys(["PageUp", "Home", "DC"])).toEqual([{ kind: "text", text: "\x1b[5~\x1b[H\x1b[3~" }]);
    expect(translateKeys(["3", "hello", "Enter", "x"])).toEqual([
      { kind: "text", text: "3hello" }, { kind: "keys", keys: ["enter"] }, { kind: "text", text: "x" },
    ]);
    expect(translateKeys(["F13"])).toEqual([{ kind: "text", text: "F13" }]);
  });
});

// ------------------------------------------------------------------ session lifecycle

describe("createSession", () => {
  it("makes a workspace per rig; a second seat of the rig is a tab in it; another rig gets its own", async () => {
    const first = await create("dev-impl@rigA", "/work", { OPENRIG_NODE_ID: "n1" });
    expect(h.fake.workspaces).toEqual([{ workspace_id: "w1", label: "rigA" }]);
    expect(h.fake.callsOf("workspace.create")[0]).toMatchObject({
      cwd: "/work", label: "rigA", focus: false,
      env: { OPENRIG_NODE_ID: "n1", OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "" },
    });
    expect(first.tokens).toEqual({ [HERDR_SESSION_TOKEN]: "dev-impl@rigA" });
    expect(h.fake.callsOf("pane.report_metadata")[0]).toMatchObject({ pane_id: first.pane_id, source: "openrig" });
    // The workspace's first tab is renamed to the session.
    expect(h.fake.callsOf("tab.rename")).toEqual([{ tab_id: first.tab_id, label: "dev-impl@rigA" }]);
    expect(h.fake.tabs.find((t) => t.tab_id === first.tab_id)?.label).toBe("dev-impl@rigA");

    const second = await create("dev-qa@rigA");
    expect(h.fake.workspaces).toHaveLength(1);
    expect(second.workspace_id).toBe("w1");
    expect(second.tab_id).not.toBe(first.tab_id);
    expect(h.fake.callsOf("tab.create")).toEqual([{ workspace_id: "w1", cwd: null, env: expect.any(Object), label: "dev-qa@rigA", focus: false }]);
    expect(h.fake.callsOf("tab.rename")).toHaveLength(1);

    const other = await create("orch@rigB");
    expect(other.workspace_id).toBe("w2");
    expect(h.fake.workspaces.map((w) => w.label)).toEqual(["rigA", "rigB"]);
  });

  it("a session without @ lives in the openrig workspace", async () => {
    await create("plain");
    expect(h.fake.workspaces.map((w) => w.label)).toEqual(["openrig"]);
  });

  it("concurrent seats of one rig share one workspace (creation is serialized)", async () => {
    const results = await Promise.all([
      h.adapter.createSession("a@rigC"), h.adapter.createSession("b@rigC"), h.adapter.createSession("c@rigC"),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(h.fake.workspaces).toHaveLength(1);
    expect(h.fake.tabs).toHaveLength(3);
  });

  it("a duplicate name classifies as duplicate_session and creates nothing", async () => {
    await create("dup@r");
    const panes = h.fake.panes.length;
    const result = await h.adapter.createSession("dup@r");
    expect(result).toMatchObject({ ok: false, code: "duplicate_session" });
    expect(h.fake.panes).toHaveLength(panes);
  });

  it("concurrent creates of one name: exactly one wins", async () => {
    const results = await Promise.all([h.adapter.createSession("x@r"), h.adapter.createSession("x@r")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ code: "duplicate_session" });
  });

  it("rejects names with : or .", async () => {
    expect(await h.adapter.createSession("a:b")).toMatchObject({ ok: false, message: expect.stringContaining("invalid session name") });
    expect(await h.adapter.createSession("a.b")).toMatchObject({ ok: false, message: expect.stringContaining("invalid session name") });
    expect(h.fake.panes).toHaveLength(0);
  });

  it("a server that is down classifies as session_not_found (no server running)", async () => {
    h.fake.up = false;
    expect(await h.adapter.createSession("s@r")).toMatchObject({ ok: false, code: "session_not_found", message: expect.stringContaining("no server running") });
  });

  // BUG: when pane.report_metadata (or the tab.rename) fails after workspace.create/tab.create succeeded, newSession
  // throws but leaves the new herdr tab open without its openrig_session token. OpenRig can never see or clean it up
  // (sessions() only knows tokened panes), and a retry opens another tab.
  it.fails("a create that fails after herdr made the tab closes that tab (BUG: untagged tab leaks)", async () => {
    h.fake.failures.set("pane.report_metadata", new Error(`herdr error: {"code":"internal","message":"boom"}`));
    const result = await h.adapter.createSession("leak@r");
    expect(result.ok).toBe(false);
    expect(h.fake.tabs).toHaveLength(0);
  });

  it("new-session with a command types it as a staged /bin/sh script; -P prints the format", async () => {
    const scripts: string[] = [];
    h.fake.onSendText = (text) => { const m = /^\/bin\/sh '(.+)'$/.exec(text); if (m) { scripts.push(readFileSync(m[1]!, "utf8")); unlinkSync(m[1]!); } };
    const out = await h.mux.argvExec(["tmux", "new-session", "-d", "-s", "cmd@r", "-c", "/w", "-P", "-F", "#{session_name}|#{pane_id}", "echo", "hi"]);
    const pane = h.fake.paneOf("cmd@r");
    expect(out).toBe(`cmd@r|${PANE_ID(pane.terminal_id)}\n`);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("cd '/w' || exit 1\n");
    expect(scripts[0]!.trimEnd().split("\n").at(-1)).toBe("echo hi");
  });
});

describe("probeSession / hasSession", () => {
  it("present, absent and transport_unavailable", async () => {
    await create("p@r");
    expect(await h.adapter.probeSession("p@r")).toEqual({ state: "present" });
    expect(await h.adapter.hasSession("p@r")).toBe(true);
    expect(await h.adapter.probeSession("nope@r")).toEqual({ state: "absent" });
    // has-session is exact: a prefix is not the session
    expect(await h.adapter.probeSession("p@")).toEqual({ state: "absent" });
    h.fake.up = false;
    const probe = await h.adapter.probeSession("p@r");
    expect(probe.state).toBe("transport_unavailable");
    expect(probe).toMatchObject({ cause: expect.stringContaining("no server running on /tmp/herdr-test.sock") });
    expect(await h.adapter.hasSession("p@r")).toBe(false);
  });

  it("socket timeouts and early closes are transport failures too", async () => {
    await create("p@r");
    h.fake.failures.set("session.snapshot", new Error("herdr socket timeout after 5000ms (/tmp/x)"));
    expect((await h.adapter.probeSession("p@r")).state).toBe("transport_unavailable");
    h.fake.failures.set("session.snapshot", new Error("herdr socket closed before a response"));
    expect((await h.adapter.probeSession("p@r")).state).toBe("transport_unavailable");
  });
});

describe("listings", () => {
  it("listSessions reports name, one window, creation time and attachment", async () => {
    await create("a@r");
    h.clock.ms += 5000;
    await create("b@r");
    const sessions = await h.adapter.listSessions();
    expect(sessions).toEqual([
      { name: "a@r", windows: 1, created: "1700000000", attached: false },
      { name: "b@r", windows: 1, created: "1700000005", attached: false },
    ]);
    h.fake.focused = h.fake.paneOf("b@r").pane_id;
    expect((await h.adapter.listSessions()).map((s) => s.attached)).toEqual([false, true]);
  });

  it("listSessions ignores herdr panes without the token, and is [] with no server", async () => {
    await create("a@r");
    h.fake.split(h.fake.paneOf("a@r").tab_id); // untokened pane in the same tab
    expect((await h.adapter.listSessions()).map((s) => s.name)).toEqual(["a@r"]);
    h.fake.up = false;
    expect(await h.adapter.listSessions()).toEqual([]);
  });

  it("listPanes and listWindows shapes", async () => {
    const pane = await create("lp@r", "/work");
    expect(await h.adapter.listPanes("lp@r")).toEqual([{ id: PANE_ID(pane.terminal_id), index: 0, cwd: "/work", width: 100, height: 30, active: true }]);
    expect(await h.adapter.listWindows("lp@r")).toEqual([{ index: 0, name: "lp@r", panes: 1, active: true }]);
    // No layout: the default 120x40.
    h.fake.rect = null;
    expect(await h.adapter.listPanes("lp@r")).toMatchObject([{ width: 120, height: 40 }]);
    // A split adds a second pane in order, root first.
    const second = h.fake.split(pane.tab_id);
    const panes = await h.adapter.listPanes("lp@r");
    expect(panes.map((p) => [p.id, p.index, p.cwd])).toEqual([[PANE_ID(pane.terminal_id), 0, "/work"], [PANE_ID(second.terminal_id), 1, "/split"]]);
    expect(await h.adapter.listWindows("lp@r")).toMatchObject([{ panes: 2 }]);
  });

  // BUG: render() sets pane_active for the root pane unconditionally (`r.pane === r.session.root || r.pane.focused`),
  // so when the user focuses a split pane both panes report active; tmux reports exactly one active pane per window.
  it.fails("only the focused pane is active when a split is focused (BUG: root is always active)", async () => {
    const pane = await create("act@r");
    const second = h.fake.split(pane.tab_id);
    h.fake.focused = second.pane_id;
    const panes = await h.adapter.listPanes("act@r");
    expect(panes.map((p) => p.active)).toEqual([false, true]);
  });

  it("missing sessions: listPanes/listWindows throw can't find session; no server gives []", async () => {
    await expect(h.adapter.listPanes("gone@r")).rejects.toThrow(/can't find session: gone@r/);
    await expect(h.adapter.listWindows("gone@r")).rejects.toThrow(/can't find session/);
    h.fake.up = false;
    expect(await h.adapter.listPanes("gone@r")).toEqual([]);
    expect(await h.adapter.listWindows("gone@r")).toEqual([]);
  });

  it("readAllPaneProcesses, readAllSessionWindowActivity, readAllSessionWindows", async () => {
    const a = await create("a@r");
    const b = await create("b@r");
    b.job = { pid: 9000, name: "claude" };
    const procs = await h.adapter.readAllPaneProcesses();
    expect(procs).toEqual(new Map([
      [PANE_ID(a.terminal_id), { pid: a.shellPid, command: "zsh" }],
      [PANE_ID(b.terminal_id), { pid: b.shellPid, command: "claude" }],
    ]));
    expect(await h.adapter.readAllSessionWindowActivity()).toEqual(new Map([["a@r", 1700000000], ["b@r", 1700000000]]));
    const windows = await h.adapter.readAllSessionWindows();
    expect(windows?.get("a@r")).toEqual({ activity: 1700000000, size: `100x30:${PANE_ID(a.terminal_id)}:${a.shellPid}:100x30:0:0:,` });
  });

  it("window activity moves when herdr's pane revision changes", async () => {
    const pane = await create("act@r");
    expect(await h.adapter.readPaneLastActivity("act@r")).toBe(1700000000);
    h.clock.ms += 60_000;
    expect(await h.adapter.readPaneLastActivity("act@r")).toBe(1700000000); // no new output
    pane.revision = 7;
    expect(await h.adapter.readPaneLastActivity("act@r")).toBe(1700000060);
    h.clock.ms += 60_000;
    expect(await h.adapter.readPaneLastActivity("act@r")).toBe(1700000060);
  });
});

describe("target resolution and pane ids", () => {
  it("pane ids are %<decimal of the terminal hex>; %N, $N, @N, =name, =name:, name:0.0 all resolve", async () => {
    const pane = await create("res@r");
    expect(pane.terminal_id).toBe("term_1a");
    const n = "26";
    const show = (t: string) => h.mux.argvExec(["tmux", "display-message", "-p", "-t", t, "#{session_name}|#{pane_id}|#{session_id}|#{window_id}"]);
    const expected = `res@r|%${n}|$${n}|@${n}\n`;
    for (const t of [`%${n}`, `$${n}`, `@${n}`, "=res@r", "=res@r:", "res@r", "res@r:0", "res@r:0.0"]) expect(await show(t)).toBe(expected);
  });

  it("a split pane resolves by its own %N and by name:0.1; misses name the target", async () => {
    const pane = await create("res@r");
    const second = h.fake.split(pane.tab_id);
    const id = (t: string) => h.mux.argvExec(["tmux", "display-message", "-p", "-t", t, "#{pane_id} #{pane_index}"]);
    expect(await id(PANE_ID(second.terminal_id))).toBe(`${PANE_ID(second.terminal_id)} 1\n`);
    expect(await id("res@r:0.1")).toBe(`${PANE_ID(second.terminal_id)} 1\n`);
    // Unqualified targets prefer the focused pane, as tmux's active pane.
    h.fake.focused = second.pane_id;
    expect(await id("=res@r:")).toBe(`${PANE_ID(second.terminal_id)} 1\n`);
    await expect(id("res@r:0.5")).rejects.toThrow("can't find pane: 5");
    await expect(id("%999")).rejects.toThrow("can't find pane: %999");
    await expect(id("$999")).rejects.toThrow("can't find session: $999");
    await expect(id("@999")).rejects.toThrow("can't find window: @999");
    await expect(id("=nope")).rejects.toThrow("can't find session: nope");
  });

  it("display-message without -t has no current client; without -p prints nothing", async () => {
    await create("dm@r");
    await expect(h.mux.argvExec(["tmux", "display-message", "-p", "x"])).rejects.toThrow("no current client");
    expect(await h.mux.argvExec(["tmux", "display-message", "-t", "dm@r", "x"])).toBe("");
  });

  it("getPanePid / getPaneCommand read herdr's process info", async () => {
    const pane = await create("pid@r");
    const id = PANE_ID(pane.terminal_id);
    expect(await h.adapter.getPanePid(id)).toBe(pane.shellPid);
    expect(await h.adapter.getPanePid("pid@r")).toBe(pane.shellPid);
    expect(await h.adapter.getPaneCommand(id)).toBe("zsh"); // login shell's leading - stripped
    pane.job = { pid: 7000, name: "claude" };
    expect(await h.adapter.getPaneCommand("pid@r")).toBe("claude");
    expect(await h.adapter.getPanePid(id)).toBe(pane.shellPid); // pane_pid is the shell, as tmux's root process
    expect(await h.adapter.getPanePid("%999")).toBeNull();
    expect(await h.adapter.getPaneCommand("gone@r")).toBeNull();
    // process_info failing: values are blank, not an error
    h.fake.failures.set("pane.process_info", new Error(`herdr error: {"code":"unknown_method","message":"nope"}`));
    expect(await h.adapter.getPanePid(id)).toBeNull();
    expect(await h.adapter.getPaneCommand(id)).toBeNull();
  });

  it("cursor position is unavailable (herdr reports none)", async () => {
    await create("cur@r");
    expect(await h.adapter.getPaneCursorPosition("cur@r")).toBeNull();
    expect(await h.adapter.isPaneInMode("cur@r")).toBe(false);
  });
});

// ------------------------------------------------------------------ input

describe("sendText", () => {
  it("bracketed (default) goes through pane.send_input with LF preserved", async () => {
    const pane = await create("st@r");
    expect(h.adapter.deliveryGuard).toBeUndefined();
    expect(await h.adapter.sendText("st@r", "line1\nline2; tmux ;")).toEqual({ ok: true });
    expect(h.fake.inputCalls()).toEqual([{ method: "pane.send_input", params: { pane_id: pane.pane_id, text: "line1\nline2; tmux ;", keys: [] } }]);
  });

  it("bracketed:false types the bytes with pane.send_text, LF still preserved (-r)", async () => {
    const pane = await create("st@r");
    expect(await h.adapter.sendText(PANE_ID(pane.terminal_id), "1\n2", undefined, { bracketed: false })).toEqual({ ok: true });
    expect(h.fake.inputCalls()).toEqual([{ method: "pane.send_text", params: { pane_id: pane.pane_id, text: "1\n2" } }]);
  });

  it("a missing target fails as session_not_found and drops the loaded buffer", async () => {
    const result = await h.adapter.sendText("gone@r", "x");
    expect(result).toMatchObject({ ok: false, code: "session_not_found" });
    expect(h.fake.inputCalls()).toEqual([]);
  });

  it("paste-buffer without -r turns LF into CR; -d drops the buffer; missing buffers error", async () => {
    const pane = await create("pb@r");
    const file = join(scratch, "buf.txt");
    writeFileSync(file, "a\nb\n");
    await h.mux.argvExec(["tmux", "load-buffer", "-b", "B1", file]);
    await h.mux.argvExec(["tmux", "paste-buffer", "-t", "pb@r", "-b", "B1"]);
    expect(h.fake.inputCalls().at(-1)).toEqual({ method: "pane.send_text", params: { pane_id: pane.pane_id, text: "a\rb\r" } });
    await h.mux.argvExec(["tmux", "paste-buffer", "-t", "pb@r", "-b", "B1", "-d", "-p"]);
    expect(h.fake.inputCalls().at(-1)).toEqual({ method: "pane.send_input", params: { pane_id: pane.pane_id, text: "a\rb\r", keys: [] } });
    await expect(h.mux.argvExec(["tmux", "paste-buffer", "-t", "pb@r", "-b", "B1"])).rejects.toThrow("no buffer B1");
    await expect(h.mux.argvExec(["tmux", "load-buffer", "-b", "B2"])).rejects.toThrow("load-buffer: no file");
  });

  it("sendShellCommand stages the launch and types /bin/sh '<script>' then Enter", async () => {
    const pane = await create("ssc@r");
    let script = "";
    h.fake.onSendText = () => {};
    expect(await h.adapter.sendShellCommand("ssc@r", "echo launched")).toEqual({ ok: true });
    const calls = h.fake.inputCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("pane.send_input");
    const m = /^\/bin\/sh '(.+)'$/.exec(String(calls[0]!.params["text"]));
    expect(m).not.toBeNull();
    script = readFileSync(m![1]!, "utf8");
    unlinkSync(m![1]!);
    expect(script).toContain("echo launched");
    expect(calls[1]).toEqual({ method: "pane.send_keys", params: { pane_id: pane.pane_id, keys: ["enter"] } });
  });
});

describe("sendKeys", () => {
  it("maps tmux key names onto herdr keys and text, in order", async () => {
    const pane = await create("sk@r");
    const id = pane.pane_id;
    const send = async (keys: string[]) => { h.fake.calls = []; expect(await h.adapter.sendKeys("sk@r", keys)).toEqual({ ok: true }); return h.fake.inputCalls(); };
    expect(await send(["Enter"])).toEqual([{ method: "pane.send_keys", params: { pane_id: id, keys: ["enter"] } }]);
    expect(await send(["C-c"])).toEqual([{ method: "pane.send_keys", params: { pane_id: id, keys: ["ctrl+c"] } }]);
    expect(await send(["Escape"])).toEqual([{ method: "pane.send_keys", params: { pane_id: id, keys: ["esc"] } }]);
    expect(await send(["BSpace"])).toEqual([{ method: "pane.send_keys", params: { pane_id: id, keys: ["backspace"] } }]);
    expect(await send(["PageUp"])).toEqual([{ method: "pane.send_text", params: { pane_id: id, text: "\x1b[5~" } }]);
    expect(await send(["3"])).toEqual([{ method: "pane.send_text", params: { pane_id: id, text: "3" } }]);
    expect(await send(["3", "Enter"])).toEqual([
      { method: "pane.send_text", params: { pane_id: id, text: "3" } },
      { method: "pane.send_keys", params: { pane_id: id, keys: ["enter"] } },
    ]);
  });

  it("-l sends literal text; -X cancel is a no-op on an existing pane", async () => {
    const pane = await create("sk@r");
    await h.mux.argvExec(["tmux", "send-keys", "-t", "sk@r", "-l", "Enter", "C-c"]);
    expect(h.fake.inputCalls()).toEqual([{ method: "pane.send_text", params: { pane_id: pane.pane_id, text: "Enter C-c" } }]);
    h.fake.calls = [];
    expect(await h.adapter.cancelPaneMode("sk@r")).toEqual({ ok: true });
    expect(h.fake.inputCalls()).toEqual([]);
    expect(await h.adapter.cancelPaneMode("gone@r")).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("a missing target and a herdr error classify", async () => {
    expect(await h.adapter.sendKeys("gone@r", ["Enter"])).toMatchObject({ ok: false, code: "session_not_found" });
    expect(await h.adapter.sendKeys("%999", ["Enter"])).toMatchObject({ ok: false, code: "unknown", message: "can't find pane: %999" });
    await create("sk@r");
    h.fake.failures.set("pane.send_keys", new Error(`herdr error: {"code":"internal","message":"key \\"q\\" refused"}`));
    expect(await h.adapter.sendKeys("sk@r", ["Enter"])).toEqual({ ok: false, code: "unknown", message: `herdr pane.send_keys: key \\"q\\" refused` });
  });

  it("a pane that herdr closed after the snapshot reports can't find pane", async () => {
    const pane = await create("sk@r");
    h.fake.failures.set("pane.send_keys", new Error(`herdr error: {"code":"pane_not_found","message":"pane ${pane.pane_id} not found"}`));
    expect(await h.adapter.sendKeys("sk@r", ["Enter"])).toMatchObject({ ok: false, message: `can't find pane: ${pane.pane_id}` });
  });
});

// ------------------------------------------------------------------ capture

describe("capture", () => {
  it("capturePaneContent reads recent history with lines = N + rows, capped at 1000", async () => {
    const pane = await create("cap@r");
    pane.history = "one\ntwo";
    expect(await h.adapter.capturePaneContent("cap@r", 50)).toBe("one\ntwo\n");
    expect(h.fake.callsOf("pane.read").at(-1)).toEqual({ pane_id: pane.pane_id, source: "recent", lines: 80, format: "text", strip_ansi: true });
    await h.adapter.capturePaneContent(PANE_ID(pane.terminal_id), 5000);
    expect(h.fake.callsOf("pane.read").at(-1)).toMatchObject({ lines: 1000 });
    h.fake.rect = null; // 40 default rows
    await h.adapter.capturePaneContent("cap@r");
    expect(h.fake.callsOf("pane.read").at(-1)).toMatchObject({ lines: 60 });
  });

  it("escapeSequences reads ansi; joinWrappedLines reads unwrapped", async () => {
    const pane = await create("cap@r");
    pane.history = "\x1b[2mfaint\x1b[0m\n";
    expect(await h.adapter.capturePaneContent("cap@r", 10, { escapeSequences: true })).toBe("\x1b[2mfaint\x1b[0m\n");
    expect(h.fake.callsOf("pane.read").at(-1)).toMatchObject({ source: "recent", format: "ansi", strip_ansi: false });
    await h.adapter.capturePaneContent("cap@r", 10, { joinWrappedLines: true });
    expect(h.fake.callsOf("pane.read").at(-1)).toMatchObject({ source: "recent_unwrapped", format: "text" });
  });

  it("capturePaneScreen reads the visible screen; capturePaneHistory reads all it can", async () => {
    const pane = await create("cap@r");
    pane.screen = "screen\n";
    pane.history = "hist\n";
    expect(await h.adapter.capturePaneScreen("cap@r")).toBe("screen\n");
    const read = h.fake.callsOf("pane.read").at(-1)!;
    expect(read).toMatchObject({ source: "visible", format: "text" });
    expect(read).not.toHaveProperty("lines");
    expect(await h.adapter.capturePaneHistory("cap@r")).toBe("hist\n");
    expect(h.fake.callsOf("pane.read").at(-1)).toMatchObject({ source: "recent_unwrapped", lines: 1000 });
  });

  it("empty and missing captures are null", async () => {
    await create("cap@r");
    expect(await h.adapter.capturePaneContent("cap@r")).toBeNull();
    expect(await h.adapter.capturePaneContent("gone@r")).toBeNull();
    expect(await h.adapter.capturePaneScreen("%999")).toBeNull();
  });

  it("capturePanesContent batches, matches per-target text, and marks a missing session", async () => {
    const a = await create("a@r");
    const b = await create("b@r");
    a.history = "alpha\n\nlast";
    b.history = "beta\n";
    const at = new Date("2026-01-01T00:00:00Z");
    const out = await h.adapter.capturePanesContent(["a@r", "missing@r", "b@r", "a@r"], 10, () => at);
    expect(out).not.toBeNull();
    expect(out!.get("a@r")).toEqual({ text: await h.adapter.capturePaneContent("a@r", 10), capturedAt: at });
    expect(out!.get("a@r")!.text).toBe("alpha\n\nlast\n");
    expect(out!.get("b@r")).toEqual({ text: "beta\n", capturedAt: at });
    expect(out!.get("missing@r")).toEqual({ text: null, capturedAt: at, missing: true });
    expect(out!.size).toBe(3);
  });

  it("capturePanesContent: an empty pane is null; no server gives null", async () => {
    await create("e@r");
    const out = await h.adapter.capturePanesContent(["e@r"]);
    expect(out!.get("e@r")).toMatchObject({ text: null });
    h.fake.up = false;
    expect(await h.adapter.capturePanesContent(["e@r"])).toBeNull();
  });

  it("a failing chain keeps the earlier commands' stdout and the error as execStderr", async () => {
    await create("c@r");
    const err = await h.mux.argvExec(["tmux", "display-message", "-p", "-t", "c@r", "A", ";", "display-message", "-p", "-t", "=nope:", "B"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { stdout: string }).stdout).toBe("A\n");
    expect((err as { execStderr: string }).execStderr).toBe("can't find session: nope");
  });
});

// ------------------------------------------------------------------ env and options

describe("session environment", () => {
  it("set / get / has / unset", async () => {
    await create("env@r", undefined, { OPENRIG_NODE_ID: "n1" });
    expect(await h.adapter.getSessionEnv("env@r", "OPENRIG_NODE_ID")).toBe("n1");
    expect(await h.adapter.getSessionEnv("env@r", "NEVER_SET")).toBeUndefined();
    await h.adapter.setSessionEnv("env@r", "FOO", "bar baz");
    expect(await h.adapter.getSessionEnv("env@r", "FOO")).toBe("bar baz");
    expect(await h.adapter.hasSessionEnv("env@r", "FOO")).toBe(true);
    expect(await h.adapter.hasSessionEnv("env@r", "OPENRIG_TRANSCRIPTS_LINES")).toBe(false); // blank
    expect(await h.adapter.hasSessionEnv("env@r", "NOPE")).toBe(false);
    await h.adapter.unsetSessionEnv("env@r", "FOO");
    expect(await h.adapter.getSessionEnv("env@r", "FOO")).toBeUndefined();
    expect(await h.adapter.hasSessionEnv("env@r", "FOO")).toBe(false);
    expect(await h.mux.argvExec(["tmux", "show-environment", "-t", "=env@r", "FOO"])).toBe("-FOO\n");
  });

  it("missing session: get throws, has is null; the global environment is empty", async () => {
    await expect(h.adapter.getSessionEnv("gone@r", "FOO")).rejects.toThrow("Cannot read the session's launch environment.");
    expect(await h.adapter.hasSessionEnv("gone@r", "FOO")).toBeNull();
    await expect(h.adapter.setSessionEnv("gone@r", "FOO", "x")).rejects.toThrow(/can't find session/);
    expect(await h.mux.argvExec(["tmux", "show-environment", "-g"])).toBe("");
    expect(await h.mux.argvExec(["tmux", "set-environment", "-g", "X", "1"])).toBe("");
  });
});

describe("options", () => {
  it("session, server, window and pane-local options", async () => {
    await create("opt@r");
    expect(await h.adapter.setSessionOption("opt@r", "@openrig_node", "n1")).toEqual({ ok: true });
    expect(await h.adapter.getSessionOption("opt@r", "@openrig_node")).toBe("n1");
    expect(await h.adapter.getSessionOption("opt@r", "@unset")).toBeNull();
    expect(await h.adapter.setSessionOption("gone@r", "k", "v")).toMatchObject({ ok: false, code: "session_not_found" });

    expect(await h.adapter.setServerOption("set-clipboard", "on")).toEqual({ ok: true });
    expect(await h.adapter.showServerOption("set-clipboard")).toBe("on");
    expect(await h.adapter.showServerOption("nope")).toBeNull();
    await h.adapter.setServerOption("default-shell", "/bin/fish");
    expect(await h.adapter.getDefaultShell()).toBe("/bin/fish");

    expect(await h.adapter.setWindowOption("opt@r", "window-size", "manual")).toEqual({ ok: true });
    expect(await h.adapter.resizeWindow("opt@r", 80, 24)).toEqual({ ok: true });

    expect(await h.adapter.getPaneLocalOption("opt@r", "remain-on-exit")).toBeNull();
    await h.adapter.restorePaneOption("opt@r", "remain-on-exit", "on");
    expect(await h.adapter.getPaneLocalOption("opt@r", "remain-on-exit")).toBe("on");
    await h.adapter.restorePaneOption("opt@r", "remain-on-exit", null);
    expect(await h.adapter.getPaneLocalOption("opt@r", "remain-on-exit")).toBeNull();
    expect(await h.adapter.getPaneLocalOption("gone@r", "remain-on-exit")).toBeUndefined();
  });

  it("getDefaultShell falls back to $SHELL", async () => {
    const shell = process.env.SHELL;
    process.env.SHELL = "/bin/testsh";
    try { expect(await h.adapter.getDefaultShell()).toBe("/bin/testsh"); } finally { if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell; }
  });
});

// ------------------------------------------------------------------ held panes, signals, respawn

describe("remain-on-exit, isPaneDead and signals", () => {
  it("dead only when remain-on-exit is on and the shell is in the foreground", async () => {
    const pane = await create("dead@r");
    const id = PANE_ID(pane.terminal_id);
    pane.job = { pid: 5000, name: "claude" };
    expect(await h.adapter.isPaneDead(id)).toBe(false);
    expect(await h.adapter.setRemainOnExit(id, true)).toEqual({ ok: true });
    expect(await h.adapter.isPaneDead(id)).toBe(false); // the runtime still runs
    pane.job = null;
    expect(await h.adapter.isPaneDead(id)).toBe(true);
    await h.adapter.setRemainOnExit(id, false);
    expect(await h.adapter.isPaneDead(id)).toBe(false); // a shell prompt, not a held pane
    expect(await h.adapter.isPaneDead("%999")).toBe(true); // a known-missing pane proves cutover
  });

  it("a held pane's shell signal goes to its foreground job, not the shell", async () => {
    const pane = await create("held@r");
    const id = PANE_ID(pane.terminal_id);
    pane.job = { pid: 5000, name: "claude" };
    await h.adapter.setRemainOnExit(id, true);
    expect(await h.adapter.signalPaneProcess(id, "TERM")).toEqual({ ok: true });
    expect(h.signals).toEqual([[-5000, "SIGTERM"]]);
    expect(h.fallback).toEqual([]);
    // The job gone: the shell is held, nothing to signal, the pane survives.
    pane.job = null;
    expect(await h.adapter.signalPaneProcess(id, "KILL")).toEqual({ ok: true });
    expect(h.signals).toHaveLength(1);
    expect(h.fallback).toEqual([]);
    // signalPid on the shell's pid takes the same path.
    pane.job = { pid: 5001, name: "codex" };
    expect(await h.adapter.signalPid(pane.shellPid, "KILL")).toEqual({ ok: true });
    expect(h.signals.at(-1)).toEqual([-5001, "SIGKILL"]);
  });

  it("without remain-on-exit (or for another pid) the kill passes through to fallbackExec", async () => {
    const pane = await create("free@r");
    pane.job = { pid: 5000, name: "claude" };
    expect(await h.adapter.signalPaneProcess("free@r", "TERM")).toEqual({ ok: true });
    expect(h.fallback).toEqual([`kill -TERM ${pane.shellPid}`]);
    expect(h.signals).toEqual([]);
    await h.adapter.signalPid(31337, "KILL");
    expect(h.fallback.at(-1)).toBe("kill -KILL 31337");
    expect(await h.adapter.signalPaneProcess("gone@r", "TERM")).toMatchObject({ ok: false, code: "pane_pid_unavailable" });
  });

  it("non-tmux argv goes to fallbackExec shell-quoted", async () => {
    await h.mux.argvExec(["kill", "-0", "it's"]);
    expect(h.fallback).toEqual([`'kill' '-0' 'it'"'"'s'`]);
    await h.mux.exec("echo hi");
    expect(h.fallback.at(-1)).toBe("echo hi");
  });
});

describe("respawnPane", () => {
  let scripts: Array<{ invocation: string; content: string }>;
  beforeEach(() => {
    scripts = [];
    h.fake.onSendText = (text) => {
      const m = /^(?:\/bin\/sh|\.|source) '(.+openrig-herdr-.+\.sh)'$/.exec(text);
      if (!m) return;
      scripts.push({ invocation: text, content: readFileSync(m[1]!, "utf8") });
      unlinkSync(m[1]!); // the fake shell never runs it
    };
  });

  it("refuses a live pane without -k", async () => {
    const pane = await create("rp@r");
    pane.job = { pid: 5000, name: "claude" };
    const result = await h.adapter.respawnPane(PANE_ID(pane.terminal_id), "claude");
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("still active") });
    expect(h.fake.inputCalls()).toEqual([]);
  });

  it("types a staged /bin/sh script for a command, with cd and exports", async () => {
    const pane = await create("rp@r", "/old", { OPENRIG_NODE_ID: "n1" });
    await h.adapter.setSessionEnv("rp@r", "KEEP", "k'v");
    const result = await h.adapter.respawnPane(PANE_ID(pane.terminal_id), "claude --resume 'abc'", { cwd: "/new dir", env: { OPENRIG_NODE_ID: "n2" } });
    expect(result).toEqual({ ok: true });
    const calls = h.fake.inputCalls();
    expect(calls.map((c) => c.method)).toEqual(["pane.send_keys", "pane.send_text", "pane.send_keys"]);
    expect(calls[0]!.params).toEqual({ pane_id: pane.pane_id, keys: ["ctrl+u"] });
    expect(calls[2]!.params).toEqual({ pane_id: pane.pane_id, keys: ["enter"] });
    expect(scripts).toHaveLength(1);
    const { invocation, content } = scripts[0]!;
    expect(invocation).toMatch(/^\/bin\/sh '.+'$/);
    const lines = content.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\/bin\/rm -f -- '.+openrig-herdr-.+\.sh' 2>\/dev\/null \|\| true$/);
    expect(lines).toContain("cd '/new dir' || exit 1");
    expect(lines).toContain("export OPENRIG_NODE_ID='n2'");
    expect(lines).toContain(`export KEEP='k'"'"'v'`);
    expect(lines.at(-1)).toBe(`exec /bin/sh -c 'claude --resume '"'"'abc'"'"''`);
  });

  it("sources the script for a blank shell, carrying unset variables", async () => {
    const pane = await create("rp@r");
    await h.adapter.setSessionEnv("rp@r", "GONE", "x");
    await h.adapter.unsetSessionEnv("rp@r", "GONE");
    expect(await h.adapter.respawnPane(PANE_ID(pane.terminal_id), undefined, { cwd: "/w" })).toEqual({ ok: true });
    expect(scripts[0]!.invocation).toMatch(/^\. '.+'$/);
    expect(scripts[0]!.content).toContain("cd '/w' || exit 1\n");
    expect(scripts[0]!.content).toContain("unset GONE\n");
    expect(scripts[0]!.content).not.toContain("exec ");
  });

  it("the default shell, or the pane's own shell, is a blank respawn; fish uses source", async () => {
    const pane = await create("rp@r");
    await h.adapter.setServerOption("default-shell", "/usr/local/bin/bash");
    await h.adapter.respawnPane("rp@r", "/usr/local/bin/bash");
    expect(scripts.at(-1)!.invocation).toMatch(/^\. /);
    await h.adapter.respawnPane("rp@r", "zsh"); // the pane's foreground command
    expect(scripts.at(-1)!.invocation).toMatch(/^\. /);
    pane.shellName = "fish";
    await h.adapter.respawnPane("rp@r", "");
    expect(scripts.at(-1)!.invocation).toMatch(/^source '.+'$/);
  });

  // BUG: respawnPane decides "blank shell" with `command.split("/").pop()`, i.e. the text after the LAST slash of the
  // whole command line, not its executable. A command whose last path argument ends in the shell's name is taken for
  // a blank respawn and silently dropped: only cd/exports are sourced and `tail` never runs.
  it.fails("a command whose last argument path ends in the shell name still runs (BUG: treated as blank)", async () => {
    await create("rp@r");
    await h.adapter.setServerOption("default-shell", "/bin/zsh");
    await h.adapter.respawnPane("rp@r", "tail -f /var/log/zsh");
    expect(scripts.at(-1)!.content).toContain("tail -f /var/log/zsh");
  });

  function killingMux(pane: FakePane, signals: Array<[number, NodeJS.Signals]>): HerdrMux {
    return new HerdrMux({ rpc: h.fake.rpc, fallbackExec: async () => "", sleep: async () => {}, signalProcess: (pid, sig) => { signals.push([pid, sig]); pane.job = null; } });
  }

  it("-k kills the foreground job's group, waits for the shell, then types", async () => {
    const pane = await create("rp@r");
    pane.job = { pid: 5000, name: "codex" };
    const signals: Array<[number, NodeJS.Signals]> = [];
    await killingMux(pane, signals).argvExec(["tmux", "respawn-pane", "-k", "-t", PANE_ID(pane.terminal_id), "claude"]);
    expect(signals).toEqual([[-5000, "SIGKILL"]]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.content).toContain("exec /bin/sh -c 'claude'");
  });

  // BUG: with -k, the "blank shell" check compares the command against info.command read BEFORE the kill, i.e. the
  // job being killed. `respawn-pane -k -t %N claude` while claude runs kills claude and then only sources cd/exports:
  // the new claude never starts.
  it.fails("-k respawning the command that is running restarts it (BUG: taken for a blank shell)", async () => {
    const pane = await create("rp@r");
    pane.job = { pid: 5000, name: "claude" };
    const signals: Array<[number, NodeJS.Signals]> = [];
    await killingMux(pane, signals).argvExec(["tmux", "respawn-pane", "-k", "-t", PANE_ID(pane.terminal_id), "claude"]);
    expect(signals).toEqual([[-5000, "SIGKILL"]]);
    expect(scripts[0]!.content).toContain("exec /bin/sh -c 'claude'");
  });

  it("an unreadable pane fails the respawn", async () => {
    await create("rp@r");
    h.fake.failures.set("pane.process_info", new Error("herdr error: {\"code\":\"x\",\"message\":\"y\"}"));
    expect(await h.adapter.respawnPane("rp@r", "claude")).toMatchObject({ ok: false, message: expect.stringContaining("can't read pane") });
  });
});

// ------------------------------------------------------------------ kill and probe sessions

describe("killSession and probe sessions", () => {
  it("killSession closes the tab and the session disappears", async () => {
    const pane = await create("k@r");
    await create("other@r");
    expect(await h.adapter.killSession("k@r")).toEqual({ ok: true });
    expect(h.fake.callsOf("tab.close")).toEqual([{ tab_id: pane.tab_id }]);
    expect(await h.adapter.probeSession("k@r")).toEqual({ state: "absent" });
    expect((await h.adapter.listSessions()).map((s) => s.name)).toEqual(["other@r"]);
    expect(await h.adapter.killSession("k@r")).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("createProbeSession with one pane is ready for input", async () => {
    expect(await h.adapter.createProbeSession("probe-1", "/tmp")).toEqual({ ok: true });
    expect(await h.adapter.probeSession("probe-1")).toEqual({ state: "present" });
    expect(h.fake.callsOf("workspace.create")[0]).toMatchObject({ label: "openrig", cwd: "/tmp" });
  });

  it("createProbeSession removes an unusable (two-pane) helper through if-shell", async () => {
    await create("seed@openrig"); // so the probe's tab comes from tab.create
    h.fake.twoPaneTabs.add("probe-2");
    const result = await h.adapter.createProbeSession("probe-2");
    expect(result).toEqual({ ok: false, code: "guard_target_unknown", message: "New probe pane could not be established; no input written." });
    expect(h.fake.callsOf("tab.close")).toHaveLength(1);
    expect(await h.adapter.probeSession("probe-2")).toEqual({ state: "absent" });
    expect(await h.adapter.probeSession("seed@openrig")).toEqual({ state: "present" });
  });

  it("new-session -P -F reports the session id and creation time removeCreatedSession checks", async () => {
    const out = await h.mux.exec(`tmux new-session -d -P -F '#{session_id} #{session_created}' -s 'idt'`);
    const pane = h.fake.paneOf("idt");
    expect(out).toBe(`$${herdrTerminalNumber(pane.terminal_id)} 1700000000\n`);
  });

  type Remover = { removeCreatedSession(name: string, created: { id: string; at: string }): Promise<TmuxResult> };

  it("removeCreatedSession kills when name and creation time still match", async () => {
    const pane = await create("rm@r");
    const id = `$${herdrTerminalNumber(pane.terminal_id)}`;
    const result = await (h.adapter as unknown as Remover).removeCreatedSession("rm@r", { id, at: "1700000000" });
    expect(result).toEqual({ ok: true });
    expect(await h.adapter.probeSession("rm@r")).toEqual({ state: "absent" });
  });

  // BUG: ifShell runs the else-branch `display-message -p kept` with no -t, and displayMessage throws
  // "no current client" without a target. tmux prints "kept" (the if-shell target is the command's context), so the
  // adapter returns guard_target_changed; through herdr it gets { code: "unknown", message: "no current client" }.
  it.fails("removeCreatedSession keeps a session whose creation time changed (BUG: else-branch throws)", async () => {
    const pane = await create("rm@r");
    const id = `$${herdrTerminalNumber(pane.terminal_id)}`;
    const result = await (h.adapter as unknown as Remover).removeCreatedSession("rm@r", { id, at: "1" });
    expect(await h.adapter.probeSession("rm@r")).toEqual({ state: "present" });
    expect(result).toMatchObject({ ok: false, code: "guard_target_changed" });
  });

  // BUG (same root cause): when the id names no session, tmux's if-shell -t fails with "can't find session"
  // (session_not_found, which createProbeSession accepts silently); the mux swallows the resolve error, takes the
  // else-branch, and fails with "no current client" (code unknown), so createProbeSession appends
  // "The helper session was not removed: no current client".
  it.fails("removeCreatedSession on a gone id is session_not_found (BUG: no current client)", async () => {
    const result = await (h.adapter as unknown as Remover).removeCreatedSession("x", { id: "$424242", at: "1" });
    expect(result).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("if-shell rejects conditions it cannot evaluate", async () => {
    await create("if@r");
    await expect(h.mux.argvExec(["tmux", "if-shell", "-t", "if@r", "true", "kill-session -t if@r"])).rejects.toThrow("unsupported condition");
    expect(await h.adapter.probeSession("if@r")).toEqual({ state: "present" });
  });
});

// ------------------------------------------------------------------ server, clients, pipes

describe("server start", () => {
  it("startServer spawns `herdr --session X server` when ping fails, then waits for it", async () => {
    const local = harness({ onSpawn: () => { local.fake.up = true; } });
    local.fake.up = false;
    expect(await local.adapter.startServer()).toEqual({ ok: true });
    expect(local.spawned).toHaveLength(1);
    expect(local.spawned[0]!.argv).toEqual(["herdr", "--session", "testsess", "server"]);
    expect(local.spawned[0]!.detached).toBe(true);
    expect(local.spawned[0]!.child.unrefed).toBe(true);
  });

  it("startServer does nothing when herdr already answers", async () => {
    expect(await h.adapter.startServer()).toEqual({ ok: true });
    expect(h.spawned).toEqual([]);
  });

  it("a server that never comes up, or autoStart:false, is tmux_unavailable", async () => {
    h.fake.up = false;
    expect(await h.adapter.startServer()).toMatchObject({ ok: false, code: "tmux_unavailable", message: expect.stringContaining("herdr server did not start") });
    const noAuto = harness({ autoStart: false, herdrBin: "/opt/herdr" });
    noAuto.fake.up = false;
    expect(await noAuto.adapter.startServer()).toMatchObject({ ok: false, code: "tmux_unavailable" });
    expect(noAuto.spawned).toEqual([]);
  });

  it("tmux -V reports the herdr backend version; unknown commands error", async () => {
    expect(await h.mux.argvExec(["tmux", "-L", "x", "-V"])).toBe("tmux herdr-backend (herdr 0.5.0)\n");
    h.fake.up = false;
    expect(await h.mux.argvExec(["tmux", "-V"])).toBe("tmux herdr-backend (herdr)\n");
    await expect(h.mux.argvExec(["tmux", "split-window"])).rejects.toThrow("unknown command: split-window");
  });
});

describe("clients", () => {
  it("listClients reports the focused session; switchClient focuses the root pane", async () => {
    await create("a@r");
    const b = await create("b@r");
    expect(await h.adapter.listClients()).toEqual([]);
    expect(await h.adapter.switchClient("herdr", "b@r")).toEqual({ ok: true });
    expect(h.fake.callsOf("pane.focus")).toEqual([{ pane_id: b.pane_id }]);
    expect(await h.adapter.listClients()).toEqual([{ name: "herdr", session: "b@r" }]);
    expect(await h.adapter.switchClient("herdr", "gone@r")).toMatchObject({ ok: false, code: "session_not_found" });
    h.fake.up = false;
    expect(await h.adapter.listClients()).toEqual([]);
  });
});

describe("pipe-pane", () => {
  it("streams observe frames into the sink and stops on stopPipePane", async () => {
    const pane = await create("pp@r");
    const sink = join(scratch, "out's.log");
    expect(await h.adapter.startPipePane("pp@r", sink)).toEqual({ ok: true });
    expect(h.spawned).toHaveLength(1);
    const { argv, detached, child } = h.spawned[0]!;
    expect(argv).toEqual(["herdr", "--session", "testsess", "terminal", "session", "observe", pane.pane_id]);
    expect(detached).toBe(false);
    child.stdout!.write(`${JSON.stringify({ type: "terminal.frame", bytes: Buffer.from("hello ").toString("base64") })}\n`);
    child.stdout!.write("not json\n");
    child.stdout!.write(`${JSON.stringify({ type: "other", bytes: "eA==" })}\n`);
    child.stdout!.write(`${JSON.stringify({ type: "terminal.frame", bytes: Buffer.from("world").toString("base64") })}\n`);
    await new Promise((r) => setImmediate(r));
    expect(readFileSync(sink, "utf8")).toBe("hello world");
    expect(await h.adapter.stopPipePane("pp@r")).toEqual({ ok: true });
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  it("killSession stops the pipe; unsupported sinks error", async () => {
    await create("pp@r");
    await h.adapter.startPipePane("pp@r", join(scratch, "a.log"));
    await h.adapter.killSession("pp@r");
    expect(h.spawned[0]!.child.killed).toEqual(["SIGTERM"]);
    await create("pq@r");
    await expect(h.mux.argvExec(["tmux", "pipe-pane", "-t", "pq@r", "tee /tmp/x"])).rejects.toThrow(/only supports "cat >> <file>"/);
  });
});

// ------------------------------------------------------------------ state file

describe("state file", () => {
  it("environment, options and creation time survive a new HerdrMux on the same file", async () => {
    const statePath = join(scratch, "state", "herdr-mux.json");
    const fake = new FakeHerdr();
    const one = harness({ fake, statePath });
    expect(await one.adapter.createSession("s@r", undefined, { OPENRIG_NODE_ID: "n1" })).toEqual({ ok: true });
    await one.adapter.setSessionEnv("s@r", "FOO", "bar");
    await one.adapter.setSessionOption("s@r", "@seat", "x");
    await one.adapter.setServerOption("set-clipboard", "on");
    await one.adapter.setRemainOnExit("s@r", true);
    expect(existsSync(statePath)).toBe(true);

    const two = harness({ fake, statePath });
    two.clock.ms += 3_600_000; // the restart happens later
    expect(await two.adapter.getSessionEnv("s@r", "FOO")).toBe("bar");
    expect(await two.adapter.getSessionEnv("s@r", "OPENRIG_NODE_ID")).toBe("n1");
    expect(await two.adapter.getSessionOption("s@r", "@seat")).toBe("x");
    expect(await two.adapter.showServerOption("set-clipboard")).toBe("on");
    expect(await two.adapter.getPaneLocalOption("s@r", "remain-on-exit")).toBe("on");
    expect((await two.adapter.listSessions())[0]!.created).toBe("1700000000");
  });

  it("forgets sessions whose terminals herdr no longer holds", async () => {
    const statePath = join(scratch, "mux.json");
    const fake = new FakeHerdr();
    const one = harness({ fake, statePath });
    await one.adapter.createSession("a@r");
    await one.adapter.createSession("b@r");
    const a = fake.paneOf("a@r");
    fake.panes = fake.panes.filter((p) => p !== a); // closed outside OpenRig
    const two = harness({ fake, statePath });
    expect((await two.adapter.listSessions()).map((s) => s.name)).toEqual(["b@r"]);
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as { sessions: Record<string, { name: string }> };
    expect(Object.values(saved.sessions).map((s) => s.name)).toEqual(["b@r"]);
  });

  it("an unreadable state file starts empty and is rewritten", async () => {
    const statePath = join(scratch, "bad.json");
    writeFileSync(statePath, "{not json");
    const bad = harness({ statePath });
    expect(await bad.adapter.createSession("s@r")).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ serverOptions: {} });
  });

  it("a session herdr holds but the state file lacks gets a fresh record", async () => {
    const fake = new FakeHerdr();
    const one = harness({ fake });
    await one.adapter.createSession("s@r");
    await one.adapter.setSessionEnv("s@r", "FOO", "bar");
    const two = harness({ fake }); // in-memory state only: a restart loses it
    two.clock.ms += 10_000;
    expect(await two.adapter.getSessionEnv("s@r", "FOO")).toBeUndefined();
    expect((await two.adapter.listSessions())[0]!.created).toBe("1700000010");
  });
});

describe("delivery guard unset", () => {
  it("writes go straight to the session's pane with no guard wired", async () => {
    const pane = await create("ng@r", undefined, { OPENRIG_NODE_ID: "n1" });
    expect(h.adapter.deliveryGuard).toBeUndefined();
    expect(await h.adapter.sendText("ng@r", "hi")).toEqual({ ok: true });
    expect(await h.adapter.sendKeys("ng@r", ["Enter"])).toEqual({ ok: true });
    expect(h.fake.inputCalls().map((c) => [c.method, c.params["pane_id"]])).toEqual([["pane.send_input", pane.pane_id], ["pane.send_keys", pane.pane_id]]);
    expect(await h.adapter.killSession("ng@r")).toEqual({ ok: true });
  });
});

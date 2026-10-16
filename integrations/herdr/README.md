# OpenRig for herdr

Runs OpenRig's agent seats as herdr panes instead of tmux sessions. No tmux is needed.

## How it fits

- The OpenRig daemon still owns rigs, the queue, delivery and recovery.
- With `OPENRIG_TERMINAL_BACKEND=herdr`, the daemon creates and drives seats through herdr's control socket.
- Each rig is a herdr workspace named after the rig. Each seat is a tab in it, named after its session (`pod-member@rig`).
- herdr's own agent detection shows each seat's state (working, idle, blocked) in the sidebar.

The plugin is a thin layer on top. It starts the daemon on this herdr server and adds entry points:

| Entry point | What it does |
|---|---|
| startup | Starts `rig daemon start` with the herdr backend if no daemon is running. An already-running daemon is left alone, whatever its backend. |
| OpenRig: open dashboard | Opens the OpenRig TUI (`rig tui`) in a tab. |
| OpenRig: open web UI | Opens the daemon's web UI in your browser. |
| OpenRig: start daemon on herdr / stop daemon | Starts or stops the daemon. |

## Install

The `rig` CLI must be on PATH.

```sh
herdr plugin install Trinityy2/openrig/integrations/herdr --ref herdr-recreate
# or, from a checkout:
herdr plugin link "$PWD/integrations/herdr"
```

To turn off autostart, add `autostart=off` to `$(herdr plugin config-dir openrig.herdr)/config`.

## Running the daemon on herdr without the plugin

```sh
OPENRIG_TERMINAL_BACKEND=herdr rig daemon start
```

The daemon uses the herdr server its environment points at:

1. `OPENRIG_HERDR_SOCKET`
2. `OPENRIG_HERDR_SESSION` (a named `herdr --session NAME` server)
3. `HERDR_SOCKET_PATH`
4. `HERDR_SESSION`
5. Otherwise, the default `~/.config/herdr/herdr.sock`

If no server answers, the daemon starts one.

## Differences from tmux

- **No tmux attach.** To reach a seat, focus its tab in herdr (`rig attach` does this).
- **Shell-backed seats.** herdr panes always start your login shell, and the runtime is typed into it, so every seat is shell-backed. Seat restart and handover keep the pane and its scrollback.
- **Scrollback reads.** A history read returns at most about 1000 lines.
- **No inherited server environment.** The herdr server's own environment can't be read. A seat starts from the daemon's environment, without the launching session's identity.
- **The UI live terminal** streams herdr's rendered frames (`herdr terminal session observe`), not raw PTY bytes.

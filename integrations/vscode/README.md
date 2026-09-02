# Mercury for VS Code

A thin bridge to Mercury. It launches `mercury acp --stdio` (the
`mercury.path` setting) and never runs an agent loop of its own; every fact
it shows comes from Mercury. It works in both directions:

**Editor → Mercury (the Agent Client Protocol)**

- **Sessions / Attention / Agents & Worktrees / Artifacts & Reviews** views
  in the Mercury activity bar — Mercury's own projections, live.
- **Mercury: Open Chat** (`Ctrl/Cmd+Alt+M`) — a chat panel with streamed
  replies, the model's thoughts (collapsed), tool calls with the file they
  touch, plan and mode updates; context occupancy and session cost in the
  status bar.
- **Live editor context** — the active file, selection, open files, the
  active file's diagnostics and the workspace folders are pushed to the
  session as they change and ride the next prompt (`mercury.liveContext`).
- **Ask About Selection** (`Ctrl/Cmd+Alt+A`) — the selection, with its line
  range, as embedded context for one question.
- **Edit Selection (preview before apply)** (`Ctrl/Cmd+Alt+E`) — Mercury's
  permission ask carries the diff, which opens in the editor's own diff view
  before anything touches disk; Allow, Always Allow (when offered) or Deny.
- **Review Last Turn** — native diffs against git HEAD for the files the
  turn's edit tools changed.
- **Resume Session** — the transcript replays into the chat; nothing
  re-runs.
- **Set Session Mode** — the modes the session reports (default, implement,
  strategy, flow).
- **Open Artifact / Show Review Comments** — artifact bodies as markdown;
  anchored diff-line comments decorate open editors (outdated anchors say
  so).

**Mercury → editor (the terminal bridge)**

- **Open in Mercury Terminal** — the full TUI in a VS Code terminal. Every
  terminal in the window carries `MERCURY_IDE_PORT`, so a Mercury started
  there attaches to this editor (`/ide` lists it); the status bar shows
  the attachment.
- While attached: your selection reaches the session as you make it;
  `Ctrl/Cmd+Alt+K` sends the selection as an `@file#L1-L2` mention; the
  session reads diagnostics and opens files; its edits open as native diffs
  you accept (save) or reject (close). `mercury.terminalBridge` turns the
  bridge off.

Multi-root workspaces: the first folder is the session's working
directory; every folder rides the live editor context and the bridge's
advertisement.

Install with `mercury editor install` (uses the `code` CLI — or the
`code-insiders`, `cursor`, `codium` or `windsurf` CLI when that is what is
installed; prints manual steps otherwise). `mercury editor status` shows
what is installed. The extension version is stamped from the Mercury build
it ships with; a different major version of either side is named in a
warning, and an ACP protocol the extension does not speak stops with the
exact next step. **Mercury: Show Log** opens the bridge's log, including
everything Mercury wrote to stderr.

No per-keystroke completion.

Licence inventory: no third-party code is bundled in this extension.

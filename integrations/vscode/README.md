# Mercury for VS Code

A thin bridge to Mercury over the Agent Client Protocol. It launches
`mercury acp --stdio` (configurable via `mercury.path`) and never runs an
agent loop of its own.

- **Sessions / Agents & Worktrees / Artifacts & Reviews** views (Mercury
  activity bar) — everything comes from Mercury's own projection and
  review-artifact owners.
- **Mercury: Open Chat** — prompt panel with streamed responses + tool
  progress.
- **Ask About Selection** — sends the selection as embedded context.
- **Edit Selection (preview before apply)** — the permission dialog shows
  the exact tool input before anything touches disk; the follow-up diff
  opens native VS Code diffs against git HEAD.
- **Review Last Turn** — native diffs for the files Mercury changed.
- **Open Artifact / Show Review Comments** — artifact bodies as markdown;
  anchored diff-line comments decorate open editors (OUTDATED anchors say
  so).
- **Open in Mercury Terminal** — the full TUI in a VS Code terminal.

Install with `mercury editor install` (uses the `code` CLI when present;
prints manual steps otherwise). Multi-root workspaces aggregate as
references — the first folder is the session cwd.

No per-keystroke completion — deliberate.

Licence inventory: no third-party code is bundled in this extension.

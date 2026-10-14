# Windows glyph field check

What to look at on Windows after updating, and what to report if a mark
looks wrong. Ten minutes, no setup beyond a working install.

## Why this check exists

Windows Terminal renders any Unicode character carrying the Emoji property with
its colour emoji font. Mercury draws every status mark using geometric text
glyphs (`✻ ✓ ✕ ▲ ○ ◐ ● ⊛ › ⌄ ← → ⇄ ↳`) that stay monochrome text across macOS,
Linux and Windows. If any mark inside Mercury renders as a colour picture,
blank box or question mark, report it using the steps below.

## Before you start

1. Update to the current release (`mercury update` on a release or npm install,
   or `git pull && bun run build.ts` on a source build).
2. Confirm `mercury --version` in Windows Terminal (PowerShell 7 with the
   default font), and optionally in a standalone PowerShell 7 console window.

## The rows to check

1. **The Boot face.** Start `mercury` with no arguments. Check each row's
   leading text glyph: New Session `✶`, Continue Last Session `↳`, Boot Menu
   `⊞`, MCPs & Skills `⊛`, Agents `◈`, Health Check `✓`, Saturn Scheduler `◷`,
   Logins `⚿`, Sessions · Projects `↺`.
2. **The thinking row.** Open a session and send a prompt that triggers
   reasoning. While the model thinks, the status row reads `✻ thinking…` in
   grey italics. When the provider returns reasoning text, the folded block
   above the reply shows `✻ thinking…` with `⌄`; when the provider withholds
   thinking text (private thinking), no thinking row draws by default, and
   clicking the turn's answer or opening `ctrl+o` shows the withheld-thinking
   line once for the turn.
3. **The warning row.** Warnings use the plain triangle `▲` (in `/sandbox`
   when a dependency is missing, `/accounts` when a usage window is capped,
   unanswered Apollo interview questions, and `/memory`'s degraded maintenance
   row).
4. **Check marks.** Completed tasks, answered interview questions and selected
   picker rows use the thin check `✓`.
5. **Remote resource marks.** Remote MCP resource suggestions under the
   composer use `⊛`.
6. **Pickers and trees.** Session trees fold with `›` and open with `⌄`; task
   rows use `○` (pending), `◐` (in progress) and `✓` (done); `/effort` shows
   `Faster ← effort → Smarter`.
7. **The health check.** Run `mercury health` and `/health` and confirm every
   status mark (`✓ ✕ ▲ ○`) renders as monochrome text.
8. **The daemon.** Run `mercury daemon status`; a degraded worker line uses
   `daemon: ▲ DEGRADED …`.

## What to report

For a quick report, run `/bug --short <what you tried>` inside Mercury or open
[mercury-cli.ai/report](https://mercury-cli.ai/report) (asks for your OS, what
you tried and what broke). For a full issue report, run `/bug` or open the bug
template with:

- `mercury --version`, your Windows version, terminal host and font;
- which row above failed, the copied text, and a screenshot showing whether the
  glyph drew as a colour picture, blank box or question mark;
- `mercury health --json`.

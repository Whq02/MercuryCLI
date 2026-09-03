# Windows glyph field check

What to look at on Windows after updating, and what to report if a mark
looks wrong. Ten minutes, no setup beyond a working install.

## Why this check exists

Windows Terminal draws any character that Unicode lists as emoji-eligible
with its colour emoji font, including the ones that are plain text symbols
on every other host (a warning triangle, an asterisk, a check mark, an
information sign, a small triangle). macOS draws those as text, so a screen
that reads as plain text on a Mac can read as a row of colour pictures on
Windows. Mercury now paints none of those characters: every mark is a
geometric text glyph (`✻ ✓ ✕ ▲ ○ ◐ ● ⊛ › ⌄ ← → ⇄ ↳`). If you see a colour
picture anywhere inside Mercury, that is a bug; report it with the steps
below.

## Before you start

1. Update to the current main (`mercury update` on a release install, or
   pull and rebuild from source as the Windows install guide describes).
2. Confirm the version:

   ```powershell
   mercury --version
   ```

3. Use Windows Terminal with its default font, then repeat the same rows in
   PowerShell 7's own window if you have time. Note which one you used.

## The rows to eyeball

Each row names the screen, how to reach it, and what it must look like.

1. **The Boot face.** Start `mercury` with no arguments. Every row of the
   card leads with a text glyph: New Session `✶`, Continue Last Session
   `↳`, Boot Menu `⊞`, MCPs & Skills `⊛`, Agents `◈`, Doctor / Health
   Check `✓`, Saturn Scheduler `◷`, Logins `⚿`, Sessions · Projects `↺`.
   The Continue row's arrow is a plain hooked arrow, not a blue arrow tile.
2. **The thinking row.** Open a session and ask something that makes the
   model reason for a moment. While it thinks, the status row reads
   `✻ thinking…` in grey italics; after the answer, the folded reasoning
   block above the reply carries the same `✻ thinking…` header with a `⌄`
   fold cue. No green star, no square tile.
3. **The warning row.** A warning is a plain triangle `▲`, never a yellow
   sign. Places that show one: `/sandbox` when a sandbox dependency is
   missing, the notice when a retired model is selected, the account pane
   (`/accounts`) when a family's usage window is capped, the "Not every
   question is answered" line of the interview card (Apollo mode), and the
   memory centre's degraded maintenance row.
4. **The check marks.** Answered questions and the Submit tab of the
   interview card, completed tasks in the task list, and selected rows in
   pickers all carry a thin `✓`, never a heavy green check. Unanswered
   interview questions carry the `▲` triangle.
5. **The cloud / remote rows.** Anything that marks a remote or hosted
   resource (the MCP resource suggestions under the composer, for one) uses
   the circled asterisk `⊛`, never a cloud picture.
6. **Pickers and trees.** The resume picker's session tree folds with `›`
   and opens with `⌄`; task rows use `○` (pending), `◐` (in progress) and
   `✓` (done); the effort slider (`/effort`) reads
   `Faster ← effort → Smarter`.
7. **The doctor.** Run both forms and read every status mark as text
   (`✓ ✕ ▲ ○`):

   ```powershell
   mercury doctor
   ```

   and `/health` inside a session.
8. **The daemon.** If a background worker has been degraded, the status
   line reads `supervisor: ▲ DEGRADED …`:

   ```powershell
   mercury daemon status
   ```

## What to report

Open an issue through the bug template with:

- the `mercury --version` line, the Windows version, the terminal
  (Windows Terminal or PowerShell 7's window) and its font;
- which row above you were on, and the exact text of the row (copy it out
  of the terminal, and attach a screenshot as well; a picture shows the
  colour glyph the copied text hides);
- whether the mark drew as a colour picture, as a blank box, or as a
  question mark (a blank box or question mark means the font lacks the
  glyph, which is a different problem from the colour picture);
- the output of `mercury doctor --json`.

A row that reads as plain text everywhere in this list is the expected
result; there is nothing to report for it.

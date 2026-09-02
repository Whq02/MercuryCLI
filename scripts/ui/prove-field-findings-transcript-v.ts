#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-field-findings-transcript-v.ts
//  TASK-017 SUPPLEMENT 3 fixes — the transcript's `v` (open in editor)
// (w32-02 + ctr-6: one owner, two findings).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-field-findings-transcript-v.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    failures += 0
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── §1 · w32-02 + ctr-6: `v` opens through the one editor door ─────────────
// Findings w32-02 + ctr-6 (moderate ×2, one owner): the transcript's v spawned
// `spawn(editor, [path], { shell: true })` — with shell:true Node joins an
// UNQUOTED cmd line, so a program-files editor path ran its first
// space-separated segment with the error swallowed — then set "opened …"
// unconditionally (a claim with no evidence) and taught the POSIX $EDITOR
// spelling on every platform. utils/editor.ts already owns the win32-safe
// launch (every token quoted, an error listener attached) — the handler now
// rides it.
console.log('§1 w32-02 + ctr-6 — the v opener rides utils/editor')
{
  const repl = read('src/screens/REPL.tsx')
  check('POISON: the raw shell:true spawn is gone from the v handler', !repl.includes("spawn(editor, [path], { stdio: 'ignore', detached: true, shell: true }).unref()"))
  check('the handler asks the one door and reports what it can know', repl.includes("const { openFileInExternalEditor } = await import('../utils/editor.js');") && repl.includes('if (openFileInExternalEditor(path)) {') && repl.includes('setEditorStatus(`opening ${path}`);'))
  check("POISON: the unconditional 'opened …' claim is gone", !repl.includes('setEditorStatus(`opened ${path}`);'))
  check('the no-editor advice speaks the platform (no $EDITOR on cmd/PowerShell)', repl.includes('set EDITOR (or VISUAL) to open it') && repl.includes('set $EDITOR to open it') && repl.includes("process.platform === 'win32'"))
  const editor = read('src/utils/editor.ts')
  check('the door quotes every win32 token and listens for the launch error', editor.includes('quoteForWindowsShell(executable)') && editor.includes("child.on('error'"))
  check('the door answers whether an editor is configured (false ⇒ the honest written-to line)', editor.includes('export function openFileInExternalEditor(filePath: string, line?: number): boolean') && editor.includes('if (!editor) return false'))
}
// NEEDS-REAL-BOX: VISUAL set to an unquoted Program Files path, ctrl+o, v —
// the editor opens; unset both and v paints the written-to line with the
// Windows spelling.

process.exit(failures === 0 ? 0 : 1)

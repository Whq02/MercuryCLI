#!/usr/bin/env bun
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

process.exit(failures === 0 ? 0 : 1)

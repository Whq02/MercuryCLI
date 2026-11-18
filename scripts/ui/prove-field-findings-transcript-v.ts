#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from '../lib/settingsPopupHarness.ts'
import { openTranscriptPart } from './chatScenarios.ts'

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

const spawned: string[] = []
mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: (...args: Parameters<typeof childProcess.spawn>) => {
    spawned.push(String(args[0]))
    return childProcess.spawn(...args)
  },
}))

console.log('§1 w32-02 + ctr-6 — the v opener rides utils/editor')
{
  const t = await openTranscriptPart('field-findings-transcript-v')
  await t.setRows(t.rowsOf(3))
  await t.act(() => {
    t.part.value().handleEnterTranscript()
    t.part.value().setScreen('transcript')
  })
  const status = (): string => t.part.value().editorStatus ?? ''
  t.editor.answer = true
  await t.press('v')
  await waitFor(() => status().startsWith('opening '), 8000)
  const opening = status()
  const path = opening.replace(/^opening /, '')
  t.editor.answer = false
  await t.press('v')
  await waitFor(() => status().startsWith('written to '), 8000)
  const unix = status()
  t.editor.platform = 'win32'
  await t.press('v')
  await waitFor(() => status().includes('EDITOR (or VISUAL)'), 8000)
  const windows = status()
  check('POISON: the raw shell:true spawn is gone from the v handler', spawned.length === 0, `spawned: ${spawned.join(', ')}`)
  check('the handler asks the one door and reports what it can know', t.editor.asked.length === 3 && t.editor.asked[0] === path && existsSync(path) && opening === `opening ${path}`, `${opening} · asked ${t.editor.asked.join(', ')}`)
  check("POISON: the unconditional 'opened …' claim is gone", !opening.startsWith('opened') && !unix.startsWith('open') && !windows.startsWith('open'), `${opening} · ${unix} · ${windows}`)
  check('the no-editor advice speaks the platform (no $EDITOR on cmd/PowerShell)', /^written to .* — set \$EDITOR to open it$/.test(unix) && /^written to .* — set EDITOR \(or VISUAL\) to open it$/.test(windows), `${unix} · ${windows}`)
  await t.close()
  const editor = read('src/utils/editor.ts')
  check('the door quotes every win32 token and listens for the launch error', editor.includes('quoteForWindowsShell(executable)') && editor.includes("child.on('error'"))
  check('the door answers whether an editor is configured and usable (false ⇒ the honest written-to line; a no-op or missing value is refused before any spawn)', editor.includes('export function openFileInExternalEditor(filePath: string, line?: number): boolean') && /const resolved = resolveExternalEditor\(\)\s*\n\s*if \(!resolved\.ok\) \{[\s\S]{0,200}return false/.test(editor))
}

process.exit(failures === 0 ? 0 : 1)

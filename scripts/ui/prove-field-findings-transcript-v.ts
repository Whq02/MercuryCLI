#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from '../lib/settingsPopupHarness.ts'
import { openTranscriptPart } from './chatScenarios.ts'


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
  const told = async (asked: number, before: string): Promise<string> => {
    await waitFor(() => t.editor.asked.length === asked && status() !== '' && status() !== before && !status().startsWith('rendering'), 8000)
    return status()
  }
  t.editor.answer = true
  await t.press('v')
  const opening = await told(1, '')
  const path = t.editor.asked[0] ?? ''
  t.editor.answer = false
  await t.press('v')
  const unix = await told(2, opening)
  t.editor.platform = 'win32'
  await t.press('v')
  const windows = await told(3, unix)
  check('POISON: the raw shell:true spawn is gone from the v handler', spawned.length === 0, `spawned: ${spawned.join(', ')}; the v handler in src/screen/chat/useChatSearch.tsx must open the file through utils/editor, not spawn a shell itself`)
  check('the handler asks the one door and reports what it can know', t.editor.asked.length === 3 && path !== '' && existsSync(path) && opening === `opening ${path}`, `${opening} · asked ${t.editor.asked.join(', ')}; the v handler in src/screen/chat/useChatSearch.tsx must ask the editor door once per press, write the transcript file and set the status opening <path>`)
  check("POISON: the unconditional 'opened …' claim is gone: each status is read when the door has answered, before its timer clears it", opening !== '' && unix !== '' && windows !== '' && !opening.startsWith('opened') && !unix.startsWith('open') && !windows.startsWith('open'), `${opening} · ${unix} · ${windows}; the v handler in src/screen/chat/useChatSearch.tsx must set each status from the door's answer, never a fixed opened claim`)
  check('the no-editor advice speaks the platform (no $EDITOR on cmd/PowerShell)', /^written to .* — set \$EDITOR to open it$/.test(unix) && /^written to .* — set EDITOR \(or VISUAL\) to open it$/.test(windows), `${unix} · ${windows}; fix the no-editor wording in src/platform/host-os/words.ts`)
  await t.close()
}

process.exit(failures === 0 ? 0 : 1)

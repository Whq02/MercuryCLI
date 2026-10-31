#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'title-cut-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'title-cut-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(join(HOME, 'daemon'), { recursive: true })
process.chdir(PROJ)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const lastUnit = (text: string): string => (text.codePointAt(text.length - 1) ?? 0).toString(16)
const FAMILY = '👨‍👩‍👧‍👦'

const { extractFirstPromptFromHead } = await import('../../src/utils/sessionStoragePortable.ts')
const { promptLabel } = await import('../../src/utils/sessionStorage/sessionIndex.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { sessionsListCli } = await import('../../src/cli/sessionsVerb.ts')

try {
  section('§1 the first-prompt title cut at 200 code units lands between graphemes, never inside an emoji')
  {
    const text = 'a'.repeat(199) + '😀' + ' and the words that follow'
    const line = JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: [{ kind: 'text', text }] } })
    const title: string = extractFirstPromptFromHead(line + '\n')
    check('the title is well-formed UTF-16 (no lone surrogate before the ellipsis)', title.isWellFormed(), `length ${title.length} last unit ${lastUnit(title.slice(0, -1))}`)
    check('the title ends with the ellipsis and stays within the cut', title.endsWith('…') && title.length <= 201, `${title.length}`)
    const family = 'b'.repeat(198) + FAMILY + ' tail'
    const familyLine = JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: family } })
    const familyTitle: string = extractFirstPromptFromHead(familyLine + '\n')
    check('a joined emoji sequence straddling the cut is kept whole or left out, never split', familyTitle.isWellFormed() && (familyTitle.includes(FAMILY) || !familyTitle.includes('\u200d')), `${familyTitle.length} ${lastUnit(familyTitle.slice(0, -1))}`)
    const short: string = extractFirstPromptFromHead(JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: 'short 😀 prompt' } }) + '\n')
    check('a short prompt is untouched', short === 'short 😀 prompt', short)
  }

  section('§2 the resume-list label takes the same cut')
  {
    const label: string = promptLabel('c'.repeat(199) + '😀' + ' tail')
    check('the label is well-formed and ends with the ellipsis', label.isWellFormed() && label.endsWith('…'), `length ${label.length} last unit ${lastUnit(label.slice(0, -1))}`)
    check('a short label is untouched', promptLabel('short 😀 label') === 'short 😀 label')
  }

  section('§3 `mercury sessions list` cuts a long title at 80 without splitting an emoji')
  {
    const store = getProjectDir(PROJ)
    mkdirSync(store, { recursive: true })
    const id = '44444444-4444-4444-8444-444444444444'
    const title = 'd'.repeat(76) + '😀' + ' and more words past eighty'
    writeFileSync(join(store, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, uuid: `${id}-u1`, timestamp: '2026-10-01T00:00:00.000Z', cwd: PROJ, message: { role: 'user', content: 'hello' } }) + '\n' + JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n')
    const out: string[] = []
    const code = await sessionsListCli({}, { out: (l: string) => out.push(l), err: () => {}, interactive: false, ask: async () => false })
    const row = out.find(l => l.includes(id)) ?? ''
    check('the listing printed the session', code === 0 && row !== '', out.join(' | ').slice(0, 300))
    check('the printed row is well-formed UTF-16: the emoji at the cut is whole or gone, never a replacement character', row.isWellFormed() && !row.includes('\ufffd'), JSON.stringify(row.slice(-40)))
    check('the title is cut with the ellipsis', row.includes('…'), row.slice(-60))
  }
} finally {
  removeScratch(PROJ)
  removeScratch(HOME)
}
console.log(failures === 0 ? '\nprove-title-cut-keeps-graphemes: all green' : `\nprove-title-cut-keeps-graphemes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

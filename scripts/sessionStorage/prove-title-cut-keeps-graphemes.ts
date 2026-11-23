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

const { extractFirstPromptFromHead } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { promptLabel } = await import('../../src/sessions/transcripts/sessionIndex.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { sessionsListCli } = await import('../../src/commands/verbs/sessionsVerb.ts')

try {
  section('§1 the first-prompt title cut at 200 code units lands between graphemes, never inside an emoji')
  {
    const text = 'a'.repeat(199) + '😀' + ' and the words that follow'
    const line = JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: [{ kind: 'text', text }] } })
    const title: string = extractFirstPromptFromHead(line + '\n')
    check('the title is well-formed UTF-16 (no lone surrogate before the ellipsis)', title.isWellFormed(), `cut at a grapheme with sliceHeadAtGrapheme (src/platform/text/textSegments.ts) in extractFirstPromptFromHead (src/sessions/transcripts/sessionStoragePortable.ts); length ${title.length} last unit ${lastUnit(title.slice(0, -1))}`)
    check('the title ends with the ellipsis and stays within the cut', title.endsWith('…') && title.length <= 201, `title length ${title.length}; the FIRST_PROMPT_MAX cut plus ellipsis in extractFirstPromptFromHead (src/sessions/transcripts/sessionStoragePortable.ts) must stay within 201 units`)
    const family = 'b'.repeat(198) + FAMILY + ' tail'
    const familyLine = JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: family } })
    const familyTitle: string = extractFirstPromptFromHead(familyLine + '\n')
    check('a joined emoji sequence straddling the cut is kept whole or left out, never split', familyTitle.isWellFormed() && (familyTitle.includes(FAMILY) || !familyTitle.includes('\u200d')), `sliceHeadAtGrapheme (src/platform/text/textSegments.ts) must not split a joined emoji; length ${familyTitle.length} last unit ${lastUnit(familyTitle.slice(0, -1))}`)
    const short: string = extractFirstPromptFromHead(JSON.stringify({ schemaVersion: 1, payload: { kind: 'input', content: 'short 😀 prompt' } }) + '\n')
    check('a short prompt is untouched', short === 'short 😀 prompt', `got ${JSON.stringify(short)}; extractFirstPromptFromHead (src/sessions/transcripts/sessionStoragePortable.ts) must return a prompt under the cut unchanged`)
  }

  section('§2 the resume-list label takes the same cut')
  {
    const label: string = promptLabel('c'.repeat(199) + '😀' + ' tail')
    check('the label is well-formed and ends with the ellipsis', label.isWellFormed() && label.endsWith('…'), `clippedPrompt in src/sessions/transcripts/sessionIndex.ts must cut with sliceHeadAtGrapheme; length ${label.length} last unit ${lastUnit(label.slice(0, -1))}`)
    check('a short label is untouched', promptLabel('short 😀 label') === 'short 😀 label', `got ${JSON.stringify(promptLabel('short 😀 label'))}; promptLabel in src/sessions/transcripts/sessionIndex.ts must return a short label unchanged`)
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
    check('the listing printed the session', code === 0 && row !== '', `exit ${code}; sessionsListCli in src/commands/verbs/sessionsVerb.ts must print one row per saved session; output: ${out.join(' | ').slice(0, 250)}`)
    check('the printed row is well-formed UTF-16: the emoji at the cut is whole or gone, never a replacement character', row.isWellFormed() && !row.includes('\ufffd'), `the row cut in sessionsListCli (src/commands/verbs/sessionsVerb.ts) must use sliceHeadAtGrapheme; row tail ${JSON.stringify(row.slice(-40))}`)
    check('the title is cut with the ellipsis', row.includes('…'), `sessionsListCli (src/commands/verbs/sessionsVerb.ts) must end a title over 80 units with an ellipsis; row tail ${row.slice(-60)}`)
  }
} finally {
  removeScratch(PROJ)
  removeScratch(HOME)
}
console.log(failures === 0 ? '\nprove-title-cut-keeps-graphemes: all green' : `\nprove-title-cut-keeps-graphemes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

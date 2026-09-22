#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'source-row-plain-text-home-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/
const { sourceWhereWords, plainRowText } = await import('../../src/components/extensions/rowWords.ts')
const lastError = 'remote: \u001b[31mpre-receive hook declined\u001b[0m\u0007 \u001b]0;title\u0007\r\nfatal: \u0085the remote hung up'
const base = {
  label: 'team-tools',
  record: { kind: 'git', where: 'https://git.example.invalid/team/tools.git', ref: null, addedAt: '2026-01-01T00:00:00.000Z', checkedAt: null, commit: null, lastError },
  state: 'unreachable',
  reason: null,
  offered: 0,
  installed: 0,
  updates: 0,
  catalogue: null,
  catalogueError: null,
}

console.log('[1] the source row never carries a refresh failure\'s terminal control bytes')
{
  const words = sourceWhereWords(base as never)
  console.log(`  row words: ${JSON.stringify(words)}`)
  check('no C0, C1 or DEL byte reaches the row', !CONTROL.test(words), JSON.stringify(words))
  check('the failure\'s own words stay', words.includes('pre-receive hook declined') && words.includes('the remote hung up'), words)
  check('a line break inside the failure folds into the one-line row', !words.includes('\n'), JSON.stringify(words))
  check('the address and the retry key still follow the reason', words.includes('u retries') && words.includes(base.record.where), words)
}

console.log('[2] a catalogue error on a reachable row is stripped the same way')
{
  const row = { ...base, state: 'ok', record: { ...base.record, lastError: null }, catalogueError: 'catalogue.json: \u001b[33munexpected token\u001b[0m at line 3\u0007' }
  const words = sourceWhereWords(row as never)
  console.log(`  row words: ${JSON.stringify(words)}`)
  check('no control byte reaches the row from the catalogue error', !CONTROL.test(words), JSON.stringify(words))
  check('the catalogue error\'s words stay', words.includes('unexpected token at line 3'), words)
}

console.log('[3] the helper keeps ordinary text byte for byte')
{
  const plain = 'clone failed: could not resolve host git.example.invalid — é ü 漢字'
  check('plain text is untouched', plainRowText(plain) === plain)
  check('a tab folds to one space', plainRowText('a\tb') === 'a b')
}

console.log('[4] every render site of the two fields reads through the helper')
{
  const board = readFileSync(join(ROOT, 'src/components/extensions/ExtensionsBoard.tsx'), 'utf8')
  const view = readFileSync(join(ROOT, 'src/components/extensions/SourceView.tsx'), 'utf8')
  const words = readFileSync(join(ROOT, 'src/components/extensions/rowWords.ts'), 'utf8')
  const sidePaneError = /v: plainRowText\(row\.record\.lastError\)/.test(board)
  const sidePaneOffers = /row\.catalogueError \? plainRowText\(row\.catalogueError\)/.test(board)
  const viewHint = /catalogue unreadable: \$\{plainRowText\(source\.catalogueError\)\}/.test(view)
  const whereError = /plainRowText\(row\.record\.lastError\)/.test(words)
  const whereCatalogue = /plainRowText\(row\.catalogueError\)/.test(words)
  check('the side pane\'s error line is stripped', sidePaneError)
  check('the side pane\'s offers line is stripped', sidePaneOffers)
  check('the source view\'s catalogue hint is stripped', viewHint)
  check('the where column strips both fields', whereError && whereCatalogue)
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)

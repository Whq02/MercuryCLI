#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MnemeTopicDoc } from '../../src/mneme/mnemeTopicDocs.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'mneme-crlf-home-'))
const WORK = mkdtempSync(join(tmpdir(), 'mneme-crlf-work-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { parseTopicDoc, serializeTopicDoc } = await import('../../src/mneme/mnemeTopicDocs.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const crlf = (text: string): string => text.replaceAll('\n', '\r\n')
const copies: Array<[string, (text: string) => string]> = [
  ['CRLF', crlf],
  ['BOM+LF', text => `\uFEFF${text}`],
  ['BOM+CRLF', text => `\uFEFF${crlf(text)}`],
]
const every: Array<[string, (text: string) => string]> = [['LF', text => text], ...copies]

console.log('============================================================')
console.log(' memory page reader — CRLF and BOM copies read like LF')
console.log('============================================================')

section('§1 parseTopicDoc reads a CRLF or BOM copy of the topic doc Mercury writes')
{
  const doc: MnemeTopicDoc = {
    id: 'topic-build',
    slug: 'build',
    summary: 'how the build runs',
    tokenCount: 0,
    created: '2000-01-01T00:00:00.000Z',
    updated: '2000-01-02T00:00:00.000Z',
    updateLog: ['2000-01-02T00:00:00.000Z consolidated 2 rows'],
    sections: [
      {
        heading: 'notes',
        entries: [
          { text: 'the build uses bun', seq: 2, time: '2000-01-02T00:00:00.000Z', source: 'operator' },
          { text: 'dist is one mjs file', seq: 3, time: '2000-01-02T00:00:00.000Z', source: 'build output', supersedes: '1' },
        ],
      },
    ],
    history: [{ text: 'the build used npm', seq: 1, time: '2000-01-01T00:00:00.000Z', source: 'operator', supersededBy: 3 }],
  }
  const lf = serializeTopicDoc(doc)
  const want = parseTopicDoc(lf)
  check(
    'LF (control): the doc parses back with its id, entries, history and update log',
    want !== null &&
      want.id === 'topic-build' &&
      want.sections[0]?.entries.length === 2 &&
      want.history[0]?.supersededBy === 3 &&
      want.updateLog.length === 1,
    JSON.stringify(want),
  )
  for (const [label, shape] of copies) {
    const got = parseTopicDoc(shape(lf))
    check(`${label}: parseTopicDoc returns the LF reading`, got !== null && JSON.stringify(got) === JSON.stringify(want), got === null ? 'null' : JSON.stringify(got).slice(0, 160))
  }
}

for (const dir of [WORK, HOME]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}
console.log(failures === 0 ? `\nALL ${checks} MNEME LINE-ENDING CHECKS PASS` : `\n${failures} OF ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

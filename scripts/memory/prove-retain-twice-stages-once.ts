#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'retain-twice-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const V = await import('../../src/mneme/memoryVerbs.js')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const dir = mnemeLibraryDir()

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail.slice(0, 500)}`}`); if (!ok) failures++ }

const ONE_LINE = 'the release notes are written from the fold notes'
const TWO_LINES = 'the gate runs in Docker on this machine\nand the hosted gate stays off until the owner says so'
const staged = (words: string): number => pendingRows(dir).filter(row => row.text.includes(words)).length
try {
  const first = V.retainItems([{ content: ONE_LINE, topic: 'release' }, { content: TWO_LINES, topic: 'release' }], { session: 'twice-session' })
  check('the scene: a one-line fact and a two-line fact are stored, one row each', first.every(item => item.status === 'stored') && staged('release notes') === 1 && staged('gate runs in Docker') === 1, JSON.stringify(first.map(item => item.status)))
  const again = V.retainItems([{ content: ONE_LINE, topic: 'release' }, { content: TWO_LINES, topic: 'release' }], { session: 'twice-session' })
  check('control: the one-line fact retained again in the session is already staged, under the first row\'s id', again[0]?.status === 'already-staged' && (again[0] as { id?: string }).id === (first[0] as { id?: string }).id && staged('release notes') === 1, JSON.stringify(again[0]))
  check('the two-line fact retained again is already staged too, under the first row\'s id', again[1]?.status === 'already-staged' && (again[1] as { id?: string }).id === (first[1] as { id?: string }).id, JSON.stringify(again[1]))
  check('…and the buffer still holds it once', staged('gate runs in Docker') === 1, `${staged('gate runs in Docker')} row(s)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} retain-twice-stages-once: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)

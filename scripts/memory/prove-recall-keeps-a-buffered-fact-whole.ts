#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'recall-buffered-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const V = await import('../../src/mneme/memoryVerbs.js')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const dir = mnemeLibraryDir()

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail.slice(0, 500)}`}`); if (!ok) failures++ }

const TAILED = 'the buffer row ends with a bracket [unconsolidated, fake, fake]'
const QUOTED = 'a note that quotes [unconsolidated, then goes on to its real point about the quartz ledger'
const PLAIN = 'the plain fact about the copper ledger stays as it was'
try {
  const stored = V.retainItems([TAILED, QUOTED, PLAIN].map(content => ({ content, topic: 'checks' })), { session: 'buffered-session' })
  check('the scene: three facts are stored and still in the buffer', stored.length === 3 && stored.every(item => item.status === 'stored'), JSON.stringify(stored.map(item => item.status)))
  const pending = (query: string): Array<{ preview: string; signature?: string; label?: string }> => V.recallQuery(query, { dir }).hits.filter(hit => hit.label === 'pending')
  const of = (hits: Array<{ preview: string }>, head: string): string[] => hits.filter(hit => hit.preview.startsWith(head)).map(hit => hit.preview)
  const tailed = pending('buffer row ends with a bracket')
  check("a buffered fact that ends with the buffer's own bracket words is recalled whole", of(tailed, 'the buffer row').length > 0 && of(tailed, 'the buffer row').every(preview => preview === TAILED), JSON.stringify(tailed.map(hit => hit.preview)))
  const quoted = pending('quartz ledger')
  check('a buffered fact that quotes those words in its middle is recalled whole', of(quoted, 'a note that quotes').length > 0 && of(quoted, 'a note that quotes').every(preview => preview === QUOTED), JSON.stringify(quoted.map(hit => hit.preview)))
  const plain = pending('copper ledger')
  check("control: a plain buffered fact is recalled as it was, without the row's own suffix", of(plain, 'the plain fact').length > 0 && of(plain, 'the plain fact').every(preview => preview === PLAIN), JSON.stringify(plain.map(hit => hit.preview)))
  check('each line still names when the fact was saved and where it came from', [...tailed, ...quoted, ...plain].every(hit => /^time=.+, source=.+$/.test(hit.signature ?? '')), JSON.stringify([...tailed, ...quoted, ...plain].map(hit => hit.signature)))
  check('the buffer consolidates', maybeConsolidate({ dir, force: true }).consolidated === true)
  const after = V.recallQuery('buffer row ends with a bracket', { dir }).hits
  check('control: after consolidation the same fact reads back whole', after.some(hit => hit.label !== 'pending' && hit.preview.includes(TAILED)), JSON.stringify(after.map(hit => [hit.label, hit.preview])))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} recall-keeps-a-buffered-fact-whole: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)

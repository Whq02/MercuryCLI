#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'memory-ask-words-'))
process.env.MERCURY_CONFIG_DIR = scratch
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const WHEN_RULE = 'Memory is written only when the user asks for something to be remembered'
try {
  const { RETAIN_PROMPT, RETAIN_DESCRIPTION } = await import('../../src/tools/MemoryTools/prompt.ts')
  const { MEMORY_WRITE_VERBS_SENTENCE, emptyMemoryPage, forReader, renderFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')
  const { MEMORY_EVIDENCE_CONTRACT } = await import('../../src/mneme/memoryEvidence.ts')

  console.log('── the Retain tool: when memory is written ──')
  const whenLine = RETAIN_PROMPT.split('\n').find(line => line.startsWith('- Only when the user asks')) ?? ''
  check('the prompt opens its last bullet with the when-rule', whenLine.startsWith('- Only when the user asks for something to be remembered: a preference about how to work, a constraint they state, a fact they name — in their words.'), RETAIN_PROMPT.split('\n').at(-1))
  check('the same bullet forbids a write on the model\'s own judgement and sends decisions and outcomes to the project\'s records', whenLine.includes('Never on your own judgement; a decision or an outcome belongs in the project\'s records, not in memory.'), whenLine)
  check('the old invitation to write unasked is gone', !RETAIN_PROMPT.includes('Use for: decisions made') && !RETAIN_PROMPT.includes('outcomes worth keeping across sessions'), RETAIN_PROMPT)
  check('the secret refusal and the not-for list stand in the same bullet', whenLine.includes('Not for: secrets, transcripts, or anything the repo already records.') && whenLine.includes('A fact that looks like a key, a token or a password is refused by the tool itself, whoever asked: memory is a plain-text record on disk.'), whenLine)
  check('the pin bullet is unchanged', RETAIN_PROMPT.includes('store their words as said with pin: true') && RETAIN_PROMPT.includes('Never pin on your own judgement.'))
  check('the one-line description is unchanged', RETAIN_DESCRIPTION.startsWith('Store durable facts into project memory; a rule the user asks Mercury to remember'))

  console.log('── the memory page every session reads ──')
  check('the write sentence is the when-rule and the Correct road', MEMORY_WRITE_VERBS_SENTENCE === `${WHEN_RULE}; Correct supersedes a wrong record and keeps the old one as history.`, MEMORY_WRITE_VERBS_SENTENCE)
  check('the old verb sentence is gone', !MEMORY_WRITE_VERBS_SENTENCE.includes('Retain saves'))
  const empty = emptyMemoryPage('/library')
  check('the empty page follows the same rule', empty.includes(`nothing saved yet. ${WHEN_RULE}; Recall searches the pages once there are any.`), empty)
  check('a reader without the write verbs gets the empty page without the rule', forReader(empty, 'read') === '# Memory\nWhat Mercury remembers about this project lives in topic pages under /library: nothing saved yet. Recall searches the pages once there are any.', forReader(empty, 'read'))
  const page = renderFrontPage({ dir: '/library', topics: [], archives: [], pins: [{ seq: 1, at: '2026-10-18T20:00:00.000Z' }], usage: {}, now: new Date('2026-10-18T20:00:00.000Z') }).text
  check('a page with pins and no topics carries the rule in its opening paragraph and under the index', page.includes(` ${MEMORY_WRITE_VERBS_SENTENCE} `) && page.includes(`\n## Index\n(nothing saved yet — memory is written only when the user asks for something to be remembered)\n`), page)
  check('the evidence contract stands on the page once', page.split(MEMORY_EVIDENCE_CONTRACT).length === 2, page)
  check('the reader\'s page drops the rule and the index line names no verb', !forReader(page, 'read').includes(WHEN_RULE) && forReader(page, 'read').includes('\n## Index\n(nothing saved yet)\n'), forReader(page, 'read'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? '✅ memory is written only when the user asks: the words hold' : `❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

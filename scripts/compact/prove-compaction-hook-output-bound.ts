#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const home = mkdtempSync(join(tmpdir(), 'compaction-hook-bound-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_TMPDIR = home
process.env.NODE_ENV = 'test'
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`) }

const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { HOOK_CONTEXT_CAP_CHARS } = await import(`${root}/src/utils/hooks/contextBound.ts`)
const cap: number = HOOK_CONTEXT_CAP_CHARS
const big = 'a'.repeat(9 * 1024 * 1024)
const fired: string[] = []
const fireModule = sourceArg < 0 ? '../../src/utils/hooks/fire.ts' : join(root, 'src', 'utils', 'hooks', 'fire.ts')
const hooks = await import(fireModule)
mock.module(fireModule, () => ({
  ...hooks,
  fireHooks: async (event: string) => {
    fired.push(event)
    return { event, outcomes: [], answer: { contexts: event === 'compaction.after' ? [big, 'a short note'] : [], notices: [], conflicts: [], ...(event === 'compaction.before' ? { instructions: big } : {}) } }
  },
}))
const compact = await import(`${root}/src/services/compact/compact.ts`)

try {
  console.log('§1 compaction.after: a hook answer re-added to the context after the fold is bounded like every other hook word')
  const rows = await compact.compactionAfterHooks({ abortController: new AbortController(), agentId: undefined } as never, { method: 'summary', trigger: 'auto', tokensBefore: 180_000, tokensAfter: 20_000 })
  const texts = rows.map(row => { const content = (row as { message: { content: unknown } }).message.content; return typeof content === 'string' ? content : JSON.stringify(content) })
  const bounded = texts[0] ?? ''
  check('the after hook fired once and its two contexts became two meta rows', fired.filter(e => e === 'compaction.after').length === 1 && texts.length === 2, `${fired.join(',')} rows=${texts.length}`)
  check(`a 9 MiB context lands bounded (at most ${cap} characters plus the omission line), not whole`, bounded.length < cap + 400 && bounded.length < big.length, `${bounded.length} characters`)
  check('the bounded row says how much was omitted and where the whole output is saved', /characters omitted/.test(bounded) && /is saved at .+ — read it in chunks if it matters|could not be saved/.test(bounded), bounded.slice(cap * 0.7 - 20, cap * 0.7 + 260))
  check('a short context is kept whole', texts[1] === 'a short note', JSON.stringify(texts[1]))

  console.log('§2 compaction.before: hook instructions merged into the summariser guidance are bounded the same way')
  const merged: string = compact.mergeHookInstructions('keep the names', big) ?? ''
  check(`9 MiB of hook instructions merge to at most ${cap} characters plus the omission line, the operator words first`, merged.startsWith('keep the names\n\n') && merged.length < cap + 400 && /characters omitted/.test(merged), `${merged.length} characters`)
  check('short hook instructions merge whole', compact.mergeHookInstructions('keep the names', 'and the dates') === 'keep the names\n\nand the dates' && compact.mergeHookInstructions(undefined, 'only hook') === 'only hook' && compact.mergeHookInstructions('only user', undefined) === 'only user')
  check('the manual /compact road reads the before answer through the same bound', typeof compact.boundedHookInstructions === 'function' && (compact.boundedHookInstructions(big) ?? '').length < cap + 400 && compact.boundedHookInstructions('   ') === undefined)
} finally {
  removeScratch(home)
}
console.log(failures === 0 ? '\nprove-compaction-hook-output-bound: all green' : `\nprove-compaction-hook-output-bound: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

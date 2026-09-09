#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fail = 0
const ok = (l: string) => console.log(`  ✓ ${l}`)
const bad = (l: string) => {
  console.log(`  ✗ ${l}`)
  fail = 1
}
const assert = (cond: unknown, l: string) => (cond ? ok(l) : bad(l))

const dir = mkdtempSync(join(tmpdir(), 'mercury-cooccur-'))
const tablePath = join(dir, 'cooccur.json')
process.env.MERCURY_TOOLSEARCH_COOCCUR_PATH = tablePath

const prior = await import('../../src/tools/ToolSearchTool/cooccurPrior.ts')
const { searchToolsWithKeywords } = await import(
  '../../src/tools/ToolSearchTool/ToolSearchTool.ts'
)

const mkTool = (name: string, desc: string) => ({
  name,
  isMcp: true,
  prompt: async () => desc,
})
const alpha = mkTool('mcp__srv__alpha_zip', 'compress an archive')
const beta = mkTool('mcp__srv__beta_tar', 'extract an archive')
const gamma = mkTool('mcp__srv__gamma_mail', 'send electronic letters')
const fixtures = [alpha, beta, gamma] as never[]

console.log('[1] OFF ⇒ byte-identical, zero io')
delete process.env.MERCURY_TOOLSEARCH_COOCCUR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-proof' }
prior.__resetCooccurForTest()
assert(prior.toolSearchCooccurEnabled() === false, 'gate needs the env opt-in even under the stamp')
prior.recordToolDiscovery(['mcp__srv__alpha_zip'])
prior.recordToolDiscovery(['mcp__srv__beta_tar'])
assert(!existsSync(tablePath), 'OFF: recordToolDiscovery writes nothing')
assert(prior.cooccurBoostFor('mcp__srv__beta_tar') === 0, 'OFF: boost is 0')
const offOrder = await searchToolsWithKeywords('archive', fixtures, fixtures, 5)
assert(
  offOrder.length === 2 && offOrder[0] === 'mcp__srv__alpha_zip' && offOrder[1] === 'mcp__srv__beta_tar',
  `OFF: tie keeps stable insertion order (got ${offOrder.join(', ')})`,
)
assert(!offOrder.includes('mcp__srv__gamma_mail'), 'OFF: zero-match tool absent')

console.log('[2] ON ⇒ chain boost breaks the tie on the real scorer')
process.env.MERCURY_TOOLSEARCH_COOCCUR = '1'
prior.__resetCooccurForTest()
assert(prior.toolSearchCooccurEnabled() === true, 'gate on with the env opt-in under the stamp')
prior.recordToolDiscovery(['mcp__srv__partner_search'])
prior.recordToolDiscovery(['mcp__srv__beta_tar'])
prior.recordToolDiscovery(['mcp__srv__beta_tar'])
assert(existsSync(tablePath), 'ON: table persisted')
const table1 = JSON.parse(readFileSync(tablePath, 'utf8')) as Record<string, number>
const pairKeys = Object.keys(table1)
assert(pairKeys.length === 1 && table1[pairKeys[0]!] === 1, `exactly one pair with count 1 (got ${JSON.stringify(table1)})`)

prior.__resetCooccurForTest()
prior.recordToolDiscovery(['mcp__srv__partner_search'])
const b = prior.cooccurBoostFor('mcp__srv__beta_tar')
assert(b === 1, `boost = log2(1+1) = 1 (got ${b})`)
assert(prior.cooccurBoostFor('mcp__srv__alpha_zip') === 0, 'no pair history ⇒ no boost')
const onOrder = await searchToolsWithKeywords('archive', fixtures, fixtures, 5)
assert(
  onOrder[0] === 'mcp__srv__beta_tar' && onOrder[1] === 'mcp__srv__alpha_zip',
  `ON: beta outranks alpha via the chain prior (got ${onOrder.join(', ')})`,
)
assert(!onOrder.includes('mcp__srv__gamma_mail'), 'ON: prior NEVER surfaces a zero-lexical-match tool')

writeFileSync(tablePath, JSON.stringify({ ['mcp__srv__beta_tar\u001fmcp__srv__partner_search']: 100000 }))
prior.__resetCooccurForTest()
prior.recordToolDiscovery(['mcp__srv__partner_search'])
const clamped = prior.cooccurBoostFor('mcp__srv__beta_tar')
assert(clamped === 3, `boost clamped at 3 (got ${clamped})`)

console.log('[3] table io: cap + garbage tolerance')
const big: Record<string, number> = {}
for (let i = 0; i < 450; i++) big[`a${i}-b${i}`] = i + 1
writeFileSync(tablePath, JSON.stringify(big))
prior.__resetCooccurForTest()
prior.recordToolDiscovery(['tool-x'])
prior.recordToolDiscovery(['tool-y'])
const pruned = JSON.parse(readFileSync(tablePath, 'utf8')) as Record<string, number>
const count = Object.keys(pruned).length
assert(count <= 400, `pruned to ≤400 pairs (got ${count})`)
assert(Object.values(pruned).every(v => v >= 51), 'prune kept the HIGHEST counts')

writeFileSync(tablePath, 'NOT JSON {{{')
prior.__resetCooccurForTest()
prior.recordToolDiscovery(['tool-x'])
let threw = false
try {
  prior.cooccurBoostFor('tool-y')
  prior.recordToolDiscovery(['tool-y'])
} catch {
  threw = true
}
assert(!threw, 'garbage table never throws (treated as empty)')

rmSync(dir, { recursive: true, force: true })
console.log(fail ? '\n❌ toolsearch-cooccur proof FAILED' : '\n✅ toolsearch-cooccur proof PASS')
process.exit(fail)

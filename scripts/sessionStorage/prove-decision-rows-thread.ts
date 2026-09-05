#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { buildConversationChain } = await import('../../src/utils/sessionStorage/chain.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Row = { uuid: string; parentUuid: string | null; type: string; message: { id: string; role: string; content: unknown[] } }
const row = (uuid: string, parentUuid: string | null, type: string): Row => ({ uuid, parentUuid, type, message: { id: `msg-${uuid}`, role: type === 'assistant' ? 'assistant' : 'user', content: [] } })
const chainTypes = (rows: Row[], leaf: string): string[] => {
  const map = new Map(rows.map(r => [r.uuid, r] as [never, never]))
  return buildConversationChain(map as never, rows.find(r => r.uuid === leaf) as never).map(r => (r as unknown as Row).type)
}

section('§1 the chain walk')
{
  const call = row('a', null, 'assistant')
  const between = row('b', 'a', 'attachment')
  const result = row('c', 'a', 'user')
  check('a row recorded between the call and its result is a side branch the walk never reaches', chainTypes([call, between, result], 'c').join('>') === 'assistant>user')
  const after = row('d', 'c', 'attachment')
  check('a row recorded after the result threads onto the chain', chainTypes([call, result, after], 'd').join('>') === 'assistant>user>attachment')
}

section('§2 the source: both decision rows land after the result')
{
  const src = readFileSync(join(ROOT, 'src/services/tools/toolExecution.ts'), 'utf8')
  const built = src.indexOf('const hookDecisionRow =')
  const pushed = src.indexOf('if (executed && hookDecisionRow !== null) push({ message: hookDecisionRow })')
  const allowance = src.indexOf('if (executed && allowanceRow !== null) push({ message: allowanceRow })')
  check('the hook-decision row is built at the decision and pushed at the terminal step', built !== -1 && pushed !== -1 && built < pushed)
  check('…beside the allowance row, both after the result', allowance !== -1 && pushed < allowance)
  check('no hook-decision row is pushed in the slot between the call and its result', !/push\(\{\s*message: createAttachmentMessage\(\{\s*type: 'hook_permission_decision'/.test(src))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

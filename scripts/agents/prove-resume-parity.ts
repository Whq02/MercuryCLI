#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

for (const k of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const) delete process.env[k]
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-resume-parity-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

const storage = (await import('../../src/utils/sessionStorage.js')) as typeof import('../../src/utils/sessionStorage.js')
const agent = (await import('../../src/utils/model/agent.js')) as typeof import('../../src/utils/model/agent.js')

console.log('============================================================')
console.log(' Launch parity across resume — proof')
console.log('============================================================')

section('§1 the metadata carrier (round-trip, hermetic home)')
{
  const id = 'resume-parity-proof-agent'
  await storage.writeAgentMetadata(id as Parameters<typeof storage.writeAgentMetadata>[0], {
    agentType: 'general-purpose',
    description: 'proof',
    model: 'glm-5.2',
    effortOverride: 'high',
  })
  const back = await storage.readAgentMetadata(id as Parameters<typeof storage.readAgentMetadata>[0])
  check('model round-trips', back?.model === 'glm-5.2', JSON.stringify(back))
  check('effortOverride round-trips', back?.effortOverride === 'high')
  check('agentType/description intact', back?.agentType === 'general-purpose' && back?.description === 'proof')
}

section('§2 the restore chain (getAgentModel is id-stable; the floor holds)')
{
  const parent = 'claude-opus-4-8[1m]'
  check(
    "restored 'claude-sonnet-5' dispatches claude-sonnet-5 (not the parent)",
    agent.getAgentModel('inherit', parent, 'claude-sonnet-5' as never) === 'claude-sonnet-5',
    agent.getAgentModel('inherit', parent, 'claude-sonnet-5' as never),
  )
  check(
    "restored 'glm-5.2' dispatches glm-5.2 (the zai transport — no silent provider switch)",
    agent.getAgentModel('inherit', parent, 'glm-5.2' as never) === 'glm-5.2',
    agent.getAgentModel('inherit', parent, 'glm-5.2' as never),
  )
  const flooredRestore = agent.getAgentModel('inherit', parent, 'haiku' as never)
  check('a restored haiku alias is FLOORED, never dispatched', !/haiku/i.test(flooredRestore), flooredRestore)
  check(
    'absent persisted model ⇒ legacy re-resolution (inherit → parent)',
    agent.getAgentModel('inherit', parent, undefined) === parent,
  )
}

section('§3 seam ratchets — the consumers actually carry the field')
{
  const runAgentSrc = src('tools', 'AgentTool', 'runAgent.ts')
  const resumeSrc = src('tools', 'AgentTool', 'resumeAgent.ts')
  const toolSrc = src('tools', 'AgentTool', 'AgentTool.tsx')
  const pathsSrc = src('utils', 'sessionStorage', 'paths.ts')
  check(
    'AgentMetadata declares the model + effortOverride carriers',
    /model\?: string/.test(pathsSrc) && /effortOverride\?: string/.test(pathsSrc),
  )
  check(
    'the spawn write persists the DISPATCHED model (runAgent)',
    /writeAgentMetadata\(agentId, \{[\s\S]{0,400}?model: resolvedAgentModel/.test(runAgentSrc),
  )
  check(
    'the spawn write persists the effort override when present (runAgent)',
    /effortOverride !== undefined && \{ effortOverride \}/.test(runAgentSrc),
  )
  check(
    'the worktree clear-write PRESERVES the model (AgentTool — every backend is in-process)',
    /void writeAgentMetadata\(asAgentId\(earlyAgentId\), \{[\s\S]{0,200}?model: plan\.model/.test(toolSrc),
  )
  check(
    'resume THREADS the persisted model into runAgent (resumeAgent)',
    /restoredModel = meta\?\.model/.test(resumeSrc) && /model: restoredModel/.test(resumeSrc),
  )
  check(
    'resume threads the persisted effort override (resumeAgent)',
    /effortOverride: meta\?\.effortOverride/.test(resumeSrc),
  )
  check(
    'the model:undefined resume hard-pin is GONE (the refuted seam)',
    !/model: undefined,\s*\n\s*\/\/ Fork resume/.test(resumeSrc),
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ resume-parity: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ resume-parity: launch parity survives the resume boundary')

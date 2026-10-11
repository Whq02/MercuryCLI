#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'workflow-type-refusal-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/services/providers/callModelRouter.ts')
await import('../../src/utils/messages.ts')
await import('../../src/Tool.ts')
const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const names of [[], ['reader', 'builder'], ['builder', 'reader']]) {
  let spawns = 0
  const hooks = makeWorkflowHooks({
    toolUseContext: {
      abortController: new AbortController(),
      getAppState: () => ({}),
      options: { agentDefinitions: { activeAgents: names.map(agentType => ({ agentType })) }, engineModel: 'fixture-model' },
    },
    canUseTool: async () => ({ behavior: 'allow' }),
    emitProgress: () => {},
    onAgentController: () => {},
    spawnSubagentStream: async function* () { spawns++; throw new Error('unexpected spawn') },
  } as never)
  let caught: unknown
  try {
    await hooks.agent('read the fixture', { agentType: 'missing-worker' })
  } catch (error) {
    caught = error
  }
  const message = caught instanceof Error ? caught.message : ''
  const refusal = message.split("'missing-worker'")
  check('an unknown type rejects with an Error', caught instanceof Error, message)
  check('the refusal names the requested type exactly once', refusal.length === 2)
  check('the refusal lists available types in registry order, including the empty registry', message.endsWith(`: ${names.join(', ')}`))
  check('no worker is spawned for the absent type', spawns === 0)
}

console.log(failures ? `FAIL workflow agent-type refusal: ${failures}` : 'PASS workflow agent-type refusal')
process.exit(failures ? 1 : 0)

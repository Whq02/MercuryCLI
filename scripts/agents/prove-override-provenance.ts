#!/usr/bin/env bun
// ============================================================================
//  scripts/agents/prove-override-provenance.ts — the agents inventory
//  discloses an operator model override's provenance (FC-125). The line
//  renderer carried a branch testing modelOverrideSource — a field nothing
//  in the bundle assigns — so an overridden model printed exactly like the
//  definition's own, while the disabled switch from the SAME override file
//  was disclosed. The loader stamps operatorOverride (with its source
//  scope) onto the patched definition; the line now reads that.
//
//  §1 the loader's stamp drives the line: a user-scope override renders
//     override: user beside the overridden model.
//  §2 an un-overridden definition renders without the clause (control).
//  §3 the driven estate: loadAgentDefinitions over a scratch home whose
//     agent-overrides.json overrides the model — the stamped definition
//     renders the provenance.
//
//  Run: ~/.bun/bin/bun run scripts/agents/prove-override-provenance.ts
// ============================================================================
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'ovr-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'ovr-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { renderAgentLine } = await import('../../src/cli/handlers/agents.ts')

section('§1 THE STAMP DRIVES THE LINE')
{
  const line = renderAgentLine({
    definition: {
      agentType: 'prover-agent',
      model: 'haiku',
      operatorOverride: { from: 'user', model: 'haiku', intentModel: 'opus' },
    },
  } as never)
  check(
    'an overridden model discloses override: user',
    line.includes('haiku') && line.includes('override: user'),
    line,
  )
}

section('§2 NO OVERRIDE, NO CLAUSE (control)')
{
  const line = renderAgentLine({
    definition: { agentType: 'plain-agent', model: 'opus' },
  } as never)
  check('a plain definition renders without the clause', !line.includes('override'), line)
}

section('§3 THE DRIVEN ESTATE')
{
  const agentsDir = join(PROJ, '.mercury', 'agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(
    join(agentsDir, 'zzprobe.md'),
    '---\nname: zzprobe\ndescription: probe\nmodel: opus\n---\nDo the probe thing.\n',
  )
  writeFileSync(
    join(HOME, 'agent-overrides.json'),
    JSON.stringify({ version: 1, disabled: [], agents: { zzprobe: { model: 'haiku' } } }),
  )
  process.chdir(PROJ)
  const { getAgentDefinitionsWithOverrides } = (await import(
    '../../src/tools/AgentTool/loadAgentsDir.ts'
  )) as unknown as {
    getAgentDefinitionsWithOverrides: (cwd: string) => Promise<{ activeAgents: Array<Record<string, unknown>> }>
  }
  const { activeAgents } = await getAgentDefinitionsWithOverrides(PROJ)
  const probe = activeAgents.find(a => a.agentType === 'zzprobe')
  check('the fixture agent loads', probe !== undefined)
  check(
    'the override applied (model haiku) with provenance stamped',
    probe?.model === 'haiku' &&
      (probe?.operatorOverride as { from?: string } | undefined)?.from === 'user',
    JSON.stringify({ model: probe?.model, operatorOverride: probe?.operatorOverride }),
  )
  const line = renderAgentLine({ definition: probe } as never)
  check(
    'the driven definition renders the provenance beside the overridden model',
    line.includes('haiku') && line.includes('override: user'),
    line,
  )
}

console.log(failures === 0 ? '\nprove-override-provenance: all green' : `\nprove-override-provenance: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

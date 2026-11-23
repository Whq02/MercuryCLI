#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg7-attribution-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = join(scratch, 'home')
}
mkdirSync(join(scratch, 'home'), { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()


console.log('§3 — the main Chat is managed session #1 (ruling 26)')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const governor = await import('../../src/crew/capacity/governor.ts')
  const permitsOf = async (plan: { agentId?: string; querySource?: string }): Promise<string> => {
    let during = 'the model was not called'
    const run = await t.runScripted({
      ...plan,
      script: [[{ kind: 'do', fn: () => { during = governor.heldPermits().map(permit => permit.lane).join(',') || 'none' } }, ...t.fixtures.yields(t.fixtures.says('done.'))]],
    })
    const granted = run.events.filter(event => event.kind === 'model_permit').map(event => String(event.lane)).join(',') || 'none'
    return `granted ${granted}, held during the call ${during}, held after the run ${governor.heldPermits().length}`
  }
  const counted = (lane: string): string => `granted ${lane}, held during the call ${lane}, held after the run 0`
  const main = await permitsOf({ querySource: 'main_thread' })
  const crewmate = await permitsOf({ agentId: t.fixtures.agent(), querySource: 'agent:custom' })
  const service = await permitsOf({ querySource: 'side_question' })
  check(
    "the main Chat's own turns hold counted FOREGROUND permits (the backstop)",
    main === counted('foreground') && crewmate === counted('background-session') && service === counted('service'),
    `the model call (streamModel, src/engine/loop/turn/streamModel.ts) must take its permit on the foreground lane for a run with no agent id that owns its turn, hold it while the call streams and release it after; a crewmate's rides background-session and any other call service — the main Chat: ${main}; a crewmate: ${crewmate}; a side question: ${service}`,
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-JOURNAL-ATTRIBUTION: PASS' : `\nPROVE-JOURNAL-ATTRIBUTION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

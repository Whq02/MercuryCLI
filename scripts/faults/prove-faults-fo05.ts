#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

async function capPolicyThatThrowsRefuses(): Promise<void> {
  const before = process.env.MERCURY_AGENT_CAP
  process.env.MERCURY_AGENT_CAP = '*:max-risk=low'
  try {
    const m = await import(join(SRC, 'permissions/rules/capabilityGate.ts'))
    const tool = new Proxy({ name: 'FixtureTool', aliases: [] } as Record<string, unknown>, {
      get(target, key) {
        if (key === 'name' || key === 'aliases') return target[key as string]
        throw new Error('fixture: tool property unreadable')
      },
    })
    const judged = (candidate: unknown): unknown => {
      try {
        return m.isToolKilled(candidate, 'fixture-agent')
      } catch (error) {
        return error
      }
    }
    const unread = judged(tool)
    const evaluated = judged({ name: 'FixtureTool', aliases: [] })
    check('cap-policy-throw-refuses: with a cap set, a check of it that throws refuses the tool', unread === true, `got ${String(unread)} — isToolKilled in src/permissions/rules/capabilityGate.ts must return true (refuse) when evaluating the cap throws and MERCURY_AGENT_CAP is set`)
    check('cap-policy-throw-refuses: a cap that was evaluated and says no still refuses', evaluated === true, `got ${String(evaluated)} — isToolKilled in src/permissions/rules/capabilityGate.ts must return true for a tool the cap '*:max-risk=low' evaluates as refused`)
    delete process.env.MERCURY_AGENT_CAP
    const uncapped = judged(tool)
    check('cap-policy-throw-refuses: with no cap set the same tool is not refused', uncapped === false, `got ${String(uncapped)} — isToolKilled in src/permissions/rules/capabilityGate.ts must return false when MERCURY_AGENT_CAP is unset`)
  } finally {
    if (before === undefined) delete process.env.MERCURY_AGENT_CAP
    else process.env.MERCURY_AGENT_CAP = before
  }
}

async function flowCheckThatThrowsGoesOn(): Promise<void> {
  const m = await import(join(SRC, 'permissions/rules/flowPolicy.ts'))
  const tool = {
    name: 'FixtureWrite',
    isReadOnly: () => false,
    getPath: () => {
      throw new Error('fixture: path unreadable')
    },
  }
  const engineDecision = { behavior: 'ask', message: 'fixture engine ask' }
  const verdict = await m.decideUnderFlow(tool, { file_path: '/elsewhere/x' }, engineDecision, { mode: 'flow' })
  check('flow-throw-goes-on: a flow check that throws lets the call go on unasked', verdict.stage === 'flowAllow' && verdict.decision.behavior === 'allow', `got ${verdict.stage}/${verdict.decision.behavior} — decideUnderFlow in src/permissions/rules/flowPolicy.ts must catch a throwing flow check and return stage flowAllow with an allow decision`)
}

async function wardPatternThatFailsIsSkipped(): Promise<void> {
  const m = await import(join(SRC, 'permissions/wards/wards.ts'))
  const rule = { name: 'fixture-ward', scope: 'bash', teach: 'fixture', patterns: ['rm -rf (', 'fixture-danger'] }
  const judged = (command: string): unknown => {
    try {
      return m.evaluateWards([rule], { toolName: 'Bash', input: { command }, shellCommand: command })
    } catch (error) {
      return error
    }
  }
  const skipped = judged('rm -rf (')
  const other = judged('fixture-danger now')
  check('ward-pattern-skipped: a ward pattern that does not compile is skipped and the call goes on', (skipped as { allow?: unknown })?.allow === true, `${JSON.stringify(skipped)} — evaluateWards in src/permissions/wards/wards.ts must skip a ward pattern that does not compile and return allow: true`)
  check('ward-pattern-skipped: the other pattern of the same ward still judges', (other as { allow?: unknown })?.allow === false, `${JSON.stringify(other)} — evaluateWards in src/permissions/wards/wards.ts must still judge the ward's other patterns after skipping one that fails to compile`)
}

const rows: Array<() => Promise<void>> = [capPolicyThatThrowsRefuses, flowCheckThatThrowsGoesOn, wardPatternThatFailsIsSkipped]
for (const row of rows) {
  try {
    await row()
  } catch (error) {
    check(row.name, false, error instanceof Error ? error.message : String(error))
  }
}
console.log(failures === 0 ? 'prove-faults-fo05: all rows pass' : `prove-faults-fo05: ${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)

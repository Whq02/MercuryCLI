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
  process.env.MERCURY_AGENT_CAP = '*:max-risk=high'
  try {
    const m = await import(join(SRC, 'utils/permissions/capabilityGate.ts'))
    const tool = new Proxy({ name: 'FixtureTool', aliases: [] } as Record<string, unknown>, {
      get(target, key) {
        if (key === 'name' || key === 'aliases') return target[key as string]
        throw new Error('fixture: tool property unreadable')
      },
    })
    let killed: unknown
    try {
      killed = m.isToolKilled(tool, 'fixture-agent')
    } catch (error) {
      killed = error
    }
    check('cap-policy-throw-refuses: an agent-cap check that throws refuses the tool', killed === true, `got ${String(killed)}`)
  } finally {
    if (before === undefined) delete process.env.MERCURY_AGENT_CAP
    else process.env.MERCURY_AGENT_CAP = before
  }
}

const rows: Array<() => Promise<void>> = [capPolicyThatThrowsRefuses]
for (const row of rows) {
  try {
    await row()
  } catch (error) {
    check(row.name, false, error instanceof Error ? error.message : String(error))
  }
}
console.log(failures === 0 ? 'prove-faults-fo05: all rows pass' : `prove-faults-fo05: ${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)

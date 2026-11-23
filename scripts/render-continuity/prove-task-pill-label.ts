#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checker } = await import('../engine-durability/harness.ts')
const pill = (await import('../../src/engine/tasks/pillLabel.ts')) as Record<string, unknown> & { getPillLabel: (tasks: unknown[]) => string }
const base = checker()
const t = {
  ...base,
  check: (name: string, cond: boolean, detail?: string): void =>
    base.check(name, cond, cond ? detail : `${detail ? `${detail} — ` : ''}change getPillLabel in src/engine/tasks/pillLabel.ts (or this expectation if the label wording was meant to change)`),
}
const label = (tasks: unknown[]): string => pill.getPillLabel(tasks)

t.section('§1 one label per board — a count and a noun for each kind')
t.check('one background command', label([{ type: 'local_bash' }]) === '1 background command')
t.check('two commands and a monitor', label([{ type: 'local_bash' }, { type: 'local_bash' }, { type: 'local_bash', kind: 'monitor' }]) === '2 background commands, 1 monitor')
t.check('local agents', label([{ type: 'local_agent' }, { type: 'local_agent' }]) === '2 local crewmates')
t.check('a cloud session wears the open diamond', label([{ type: 'remote_agent' }]) === '◇ 1 cloud session')
t.check('two cloud sessions', label([{ type: 'remote_agent' }, { type: 'remote_agent' }]) === '◇ 2 cloud sessions')
t.check('monitors', label([{ type: 'monitor_mcp' }, { type: 'monitor_mcp' }]) === '2 monitors')
t.check('a mixed board counts tasks', label([{ type: 'local_bash' }, { type: 'local_agent' }]) === '2 background tasks')

t.section('§2 a record\'s extra fields change nothing — the one remote session reads as a cloud session whatever else its record carries')
for (const extra of [{ phase: 'plan_ready' }, { phase: 'needs_input' }, { isUltraplan: true, ultraplanPhase: 'plan_ready' }, { isUltraplan: true, ultraplanPhase: 'needs_input' }, { isUltraplan: true }]) {
  t.check(`remote session with ${JSON.stringify(extra)} reads "◇ 1 cloud session"`, label([{ type: 'remote_agent', ...extra }]) === '◇ 1 cloud session', label([{ type: 'remote_agent', ...extra }]))
}
t.check('the label owner exports the label and nothing that decides a second affordance', Object.keys(pill).sort().join(',') === 'getPillLabel', Object.keys(pill).sort().join(','))


t.finish('prove-task-pill-label')

#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g03p-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g03p-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const ROOT = join(import.meta.dir, '..', '..')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { resolveDisplayedSessionModel } = await import(
  '../../src/hooks/useDisplayedSessionModel.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const plain = resolveDisplayedSessionModel('claude-opus-5')
check('§A no pending: compact is the plain chip', !plain.compact.includes('→'), plain.compact)
check('§A no pending: pendingNext null', plain.pendingNext === null)

const pending = resolveDisplayedSessionModel('claude-opus-5', { setting: 'gpt-5.2' })
check(
  '§B pending: compact carries current → next',
  pending.compact.includes('→') && pending.compact.startsWith(plain.compact),
  pending.compact,
)
check('§B pending: label marks (queued)', pending.label.includes('(queued)'), pending.label)
check('§B pending: structured pendingNext', pending.pendingNext !== null, String(pending.pendingNext))

const pendingDefault = resolveDisplayedSessionModel('claude-opus-5', { setting: null })
check('§C pending Default: → Default', pendingDefault.compact.endsWith('→ Default'), pendingDefault.compact)

const settled = resolveDisplayedSessionModel('claude-opus-5', null)
check(
  '§D settlement clears the projection (byte-identical to no-pending)',
  settled.compact === plain.compact && settled.label === plain.label && settled.pendingNext === null,
)

const hookSrc = readFileSync(join(ROOT, 'src/hooks/useDisplayedSessionModel.ts'), 'utf8')
const { publishSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const plane = mkdtempSync(join(tmpdir(), 'ctm-g03p-plane-'))
const planeBefore = process.env.MERCURY_DAEMON_DIR
process.env.MERCURY_DAEMON_DIR = plane
const parkedOver = (sessionId: string, facts: Record<string, unknown>): unknown => {
  publishSessionFacts({ schema: 1, sessionId, atMs: Date.now(), busy: false, model: { effective: 'claude-opus-5', setting: null }, usage: {}, queue: [], ...facts } as never)
  return new DaemonSessionConnector({ sessionId, runnerId: 'runner-1', title: 'pending projection', projectLabel: 'proof', workspaceId: plane, home: plane } as never).modelFacts().pendingSwitch
}
const parked = { named: parkedOver('g03p-named', { pendingModel: 'gpt-5.2' }), none: parkedOver('g03p-none', { pendingModel: null }), unsaid: parkedOver('g03p-unsaid', {}) }
if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
else process.env.MERCURY_DAEMON_DIR = planeBefore
check(
  "§E the displayed-model owner reads the parked switch through the focused connector (modelFacts().pendingSwitch ← the session's facts feed)",
  hookSrc.includes('modelFacts().pendingSwitch') && JSON.stringify(parked) === JSON.stringify({ named: { setting: 'gpt-5.2' }, none: null, unsaid: null }),
  `modelFacts().pendingSwitch of the hosted connector answers ${JSON.stringify(parked)}: the setting the facts park, and null when they park none`,
)

console.log(
  failures === 0
    ? '\n ✅ PENDING PROJECTION AT THE ONE DISPLAY OWNER (capture leg rides the preview journey)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pinSourceRef } from '../lib/settingsPopupHarness.js'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = process.env.MERCURY_CONFIG_DIR!
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.js')
const { sessionFactsPath, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.js')
const { statusLine } = await import('../../src/components/SwitchboardTagBar.js')
const record = { sessionId: 'resume-seed', runnerId: '', title: 'saved session', projectLabel: 'fixture', workspaceId: home, home, modelKey: 'claude-opus-4-8' }
const facts = { schema: 1 as const, sessionId: record.sessionId, atMs: 1000, model: { effective: 'claude-sonnet-5', setting: 'claude-sonnet-5' }, pendingModel: null, busy: false, usage: noSessionConnector().usage(), identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], workspace: { cwd: home, originalCwd: home, projectRoot: home }, queue: [] }
const write = (value: typeof facts): void => {
  const file = sessionFactsPath(value.sessionId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const refresh = (connector: InstanceType<typeof DaemonSessionConnector>): void => (connector as unknown as { readFacts: () => void }).readFacts()
const words = (connector: InstanceType<typeof DaemonSessionConnector>): string => statusLine(connector.live(), connector.status())
let checks = 0
let failures = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
const cold = new DaemonSessionConnector({ ...record, sessionId: 'without-seed' })
check('a cold resume with no projection waits for a runner answer', words(cold).startsWith('the runner is starting'))
check('the saved record supplies the model before a runner answer', cold.modelFacts().effective === record.modelKey && cold.modelFacts().effectiveSource === 'record')
write({ ...facts, sessionId: 'without-seed' })
refresh(cold)
check('without a seed, the first valid projection is live', words(cold) === 'ready' && cold.modelFacts().effectiveSource === 'live')
write(facts)
check('the seed fixture is a valid projection', readSessionFacts(record.sessionId)?.atMs === 1000)
const seeded = new DaemonSessionConnector(record)
const starting = seeded.status().runner
check('the old seed does not make the resumed runner ready', words(seeded).startsWith('the runner is starting'))
check('the saved record, not an older seed, names the resumed model', seeded.modelFacts().effective === record.modelKey && seeded.modelFacts().effectiveSource === 'record')
refresh(seeded)
check('the feed rereading the same seed does not count as a live answer', words(seeded).startsWith('the runner is starting') && seeded.modelFacts().effectiveSource === 'record')
write({ ...facts, atMs: 999, model: { effective: 'claude-opus-5-5', setting: 'claude-opus-5-5' } })
refresh(seeded)
check('an older projection does not replace the seed or the saved model', seeded.modelFacts().effective === record.modelKey && words(seeded).startsWith('the runner is starting'))
check('waiting keeps the same starting clock', starting?.state === 'starting' && seeded.status().runner?.sinceMs === starting.sinceMs)
write({ ...facts, atMs: 1001 })
refresh(seeded)
check('a strictly newer answer makes the runner ready', words(seeded) === 'ready')
check('the live answer then owns the model', seeded.modelFacts().effective === facts.model.effective && seeded.modelFacts().effectiveSource === 'live')
const standing = new DaemonSessionConnector({ ...record, runnerId: 'standing-runner' })
check('a standing worker keeps the base status and model without a fresh-fact wait', words(standing) === 'ready' && standing.status().runner === null && standing.modelFacts().effective === facts.model.effective && standing.modelFacts().effectiveSource === 'live')
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

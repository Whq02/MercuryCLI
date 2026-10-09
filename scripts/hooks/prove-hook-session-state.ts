#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'hook-session-state-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { refreshHooksSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
const { observeSessionStates, noteSessionAsking, forgetSessionStates } = await import('../../src/daemon/sessionStateHooks.ts')
const { SESSION_STATE_HOOK_STATES } = await import('../../src/utils/hooks/contract.ts')

const capture = join(root, 'states.jsonl')
const q = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { 'session.state': [{ name: 'board watcher', run: `cat >> ${q(capture)}; echo >> ${q(capture)}` }, { name: 'needs me', match: 'needs-you', run: `echo needs-you-matched >> ${q(join(root, 'matched.txt'))}` }] } } }))
refreshHooksSnapshot()
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 700))
const fired = (): Array<Record<string, unknown>> => (existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>) : [])

const base = { schema: 1 as const, runnerId: 'runner-1', sessionId: 'hosted-session-1', workspaceId: workspace, isolation: 'shared' as never, modelKey: 'claude-opus-5-5', spawnedAt: Date.now(), pid: process.pid, title: 'the board session' }
const working = { ...base, lastDeliveryAt: Date.now() }
const settled = { ...working, lastTurnSettledAt: Date.now() + 1 }
const workers = (rec: Record<string, unknown>): Record<string, never> => ({ [rec.sessionId as string]: rec as never })

forgetSessionStates()
observeSessionStates(workers(working))
await settle()
check('the first sight of a session fires nothing: there is no move yet', fired().length === 0, JSON.stringify(fired()))

observeSessionStates(workers(settled))
await settle()
let rows = fired()
check('a move to ready-to-review fires session.state with state, from, title, workspace and model', rows.length === 1 && rows[0]!.event === 'session.state' && rows[0]!.state === 'ready-to-review' && rows[0]!.from === 'working' && rows[0]!.title === 'the board session' && rows[0]!.workspace === workspace && rows[0]!.model === 'claude-opus-5-5', JSON.stringify(rows))
check('the payload names the hosted session, not the daemon process', rows[0]?.session_id === 'hosted-session-1' && rows[0]?.cwd === workspace, JSON.stringify(rows[0]))
check('the hook took no match when the state was not needs-you', !existsSync(join(root, 'matched.txt')))

observeSessionStates(workers(settled))
await settle()
check('the same state seen again fires nothing', fired().length === 1)

noteSessionAsking('hosted-session-1', true, workers(settled))
await settle()
rows = fired()
check('a permission ask moves the session to needs-you with the detail naming the ask, and the matched hook ran', rows.length === 2 && rows[1]!.state === 'needs-you' && rows[1]!.from === 'ready-to-review' && rows[1]!.detail === 'a permission ask is waiting for you' && existsSync(join(root, 'matched.txt')), JSON.stringify(rows))

noteSessionAsking('hosted-session-1', false, workers(settled))
await settle()
rows = fired()
check('the ask answered: back to ready-to-review, from needs-you', rows.length === 3 && rows[2]!.state === 'ready-to-review' && rows[2]!.from === 'needs-you', JSON.stringify(rows.slice(2)))

observeSessionStates(workers({ ...settled, lastDeliveryAt: Date.now() + 10 }))
await settle()
check('a move to working (a mechanic, not a state worth acting on) fires nothing', fired().length === 3 && !(SESSION_STATE_HOOK_STATES as readonly string[]).includes('working'))

observeSessionStates(workers({ ...settled, crash: { reason: 'the runner died with code 9', at: Date.now() } }))
await settle()
rows = fired()
check('a crash moves the session to needs-you with the crash reason as the detail, from working', rows.length === 4 && rows[3]!.state === 'needs-you' && rows[3]!.from === 'working' && rows[3]!.detail === 'the runner died with code 9', JSON.stringify(rows.slice(3)))

observeSessionStates(workers({ ...settled, pausedAt: Date.now(), pausedBy: 'operator' }))
await settle()
rows = fired()
check('a pause fires paused with who paused it', rows.length === 5 && rows[4]!.state === 'paused' && rows[4]!.detail === 'paused by operator', JSON.stringify(rows.slice(4)))

observeSessionStates(workers({ ...settled, pid: 999_999_999 }))
await settle()
rows = fired()
check('a recorded pid that no longer answers is needs-you with the process named gone', rows.length === 6 && rows[5]!.state === 'needs-you' && rows[5]!.detail === 'its process is gone', JSON.stringify(rows.slice(5)))

const { SESSION_BOARD_STATES, hookEventTable } = await import('../../src/utils/hooks/contract.ts')
check('the table reads `from` as the board vocabulary: the lifecycle states plus attached, stopped and parked', ['attached', 'stopped', 'parked', 'working', 'needs-you'].every(word => (SESSION_BOARD_STATES as readonly string[]).includes(word)) && hookEventTable['session.state'].payload().safeParse({ state: 'needs-you', from: 'attached', workspace: '/w' }).success && !hookEventTable['session.state'].payload().safeParse({ state: 'needs-you', from: 'elsewhere', workspace: '/w' }).success)
forgetSessionStates()
observeSessionStates(workers({ ...settled, attachedAt: Date.now() }))
observeSessionStates(workers({ ...settled, attachedAt: undefined, crash: { reason: 'it died while you were away', at: Date.now() } }))
await settle()
rows = fired()
check('a session that was attached and now needs you fires with from attached', rows.length === 7 && rows[6]!.state === 'needs-you' && rows[6]!.from === 'attached' && rows[6]!.detail === 'it died while you were away', JSON.stringify(rows.slice(6)))

forgetSessionStates()
rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? 'HOOK SESSION STATE GREEN' : `${failures} HOOK SESSION STATE FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-proj-')))
const MIRROR_PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-list-mirror-')))
const DAEMON = join(HOME, 'daemon')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON
mkdirSync(DAEMON, { recursive: true })
process.chdir(PROJ)

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { getProjectDir, getProjectsDir } = await import('../../src/sessions/transcripts/paths.ts')
const { setOriginalCwd } = await import('../../src/boot/process-state/processState.ts')
const verb = (await import('../../src/commands/verbs/sessionsVerb.ts')) as { sessionsListCli?: (options: { all?: boolean; limit?: number }, io: unknown) => Promise<number> }

const STORE = getProjectDir(PROJ)
const OTHER_STORE = join(getProjectsDir(), '-other-project')
mkdirSync(STORE, { recursive: true })
mkdirSync(OTHER_STORE, { recursive: true })
const ids = { older: '11111111-1111-4111-8111-111111111111', newer: '22222222-2222-4222-8222-222222222222', elsewhere: '33333333-3333-4333-8333-333333333333' }
const sameTick = new Date('2026-10-10T00:00:00.000Z')
const seed = (store: string, sessionId: string, stamp: string, words: string, title?: string): void => {
  const path = join(store, `${sessionId}.jsonl`)
  const rows: Array<Record<string, unknown>> = [{ type: 'user', sessionId, uuid: `${sessionId}-u1`, parentUuid: null, isSidechain: false, timestamp: stamp, cwd: PROJ, message: { role: 'user', content: words } }]
  if (title !== undefined) rows.push({ type: 'custom-title', customTitle: title, sessionId })
  writeFileSync(path, encodeSeedTranscript(rows, sessionId, stamp))
  utimesSync(path, sameTick, sameTick)
}
seed(STORE, ids.older, '2026-10-01T00:00:00.000Z', 'fix the login page')
seed(STORE, ids.newer, '2026-10-02T00:00:00.000Z', 'write the release notes', 'release notes for .39')
seed(OTHER_STORE, ids.elsewhere, '2026-10-03T00:00:00.000Z', 'another project entirely')

const run = async (options: { all?: boolean; limit?: number }): Promise<{ code: number; out: string[]; err: string[] }> => {
  const out: string[] = []
  const err: string[] = []
  const code = verb.sessionsListCli === undefined ? -1 : await verb.sessionsListCli(options, { out: (l: string) => out.push(l), err: (l: string) => err.push(l), interactive: false, ask: async () => false })
  return { code, out, err }
}

try {
  section("§1 `mercury sessions list` names this project's saved sessions, newest first, with the id the other doors take (the field row M39-10)")
  {
    const result = await run({})
    check('the verb exists and exits 0', result.code === 0, JSON.stringify(result))
    check('both of this project\'s sessions are listed, newest first, and the other project\'s is not', result.out.findIndex(l => l.startsWith(ids.newer)) === 1 && result.out.findIndex(l => l.startsWith(ids.older)) === 2 && !result.out.some(l => l.startsWith(ids.elsewhere)), result.out.join('\n'))
    check('a row carries the id, the modified stamp, the size and the title or first prompt', result.out.some(l => l.startsWith(ids.newer) && /\d{4}-\d{2}-\d{2}T/.test(l) && / KB/.test(l) && l.includes('release notes for .39')) && result.out.some(l => l.startsWith(ids.older) && l.includes('fix the login page')), result.out.join('\n'))
    check('the footer names --resume and sessions delete as the doors the id opens', result.out.at(-1)?.includes('--resume <id>') === true && result.out.at(-1)?.includes('sessions delete <id>') === true, result.out.at(-1) ?? '')
  }
  section('§2 --all reads every project; --limit bounds the list')
  {
    const all = await run({ all: true })
    check('--all lists the other project\'s session too', all.code === 0 && all.out.some(l => l.startsWith(ids.elsewhere)) && all.out.some(l => l.startsWith(ids.newer)), all.out.join('\n'))
    const one = await run({ limit: 1 })
    check('--limit 1 lists the newest only', one.code === 0 && one.out.filter(l => /^[0-9a-f-]{36} /.test(l)).length === 1 && one.out.some(l => l.startsWith(ids.newer)), one.out.join('\n'))
  }
  section('§2b mirrored ids with tied file times: the session with the newer internal stamp still leads, and --limit 1 picks it')
  {
    const mirrorStore = getProjectDir(MIRROR_PROJ)
    mkdirSync(mirrorStore, { recursive: true })
    const mirror = { newer: '11111111-1111-4111-8111-111111111111', older: '22222222-2222-4222-8222-222222222222' }
    seed(mirrorStore, mirror.newer, '2026-10-02T00:00:00.000Z', 'newer session with smaller id', 'mirrored newer')
    seed(mirrorStore, mirror.older, '2026-10-01T00:00:00.000Z', 'older session with larger id')
    setOriginalCwd(MIRROR_PROJ)
    try {
      const result = await run({})
      check('mirrored pair: both sessions are listed, newest first (smaller id carries the newer stamp)', result.code === 0 && result.out.findIndex(l => l.startsWith(mirror.newer)) === 1 && result.out.findIndex(l => l.startsWith(mirror.older)) === 2, result.out.join('\n'))
      const one = await run({ limit: 1 })
      check('mirrored pair: --limit 1 lists the newest only', one.code === 0 && one.out.filter(l => /^[0-9a-f-]{36} /.test(l)).length === 1 && one.out.some(l => l.startsWith(mirror.newer)), one.out.join('\n'))
    } finally {
      setOriginalCwd(PROJ)
    }
  }
  section('§3 the words and the door agree: --help names the listing, a bare `sessions` lists instead of printing the delete help and failing')
  {
    const { builtCli, builtHelp } = await import('../lib/builtProduct.ts')
    const bare = builtCli(['sessions'])
    const listed = builtCli(['sessions', 'list'])
    const unplaced = (text: string): string => text.replace(/\(.*?\)/, '()')
    check("the sessions command's description names list and delete", builtHelp('sessions').includes('Saved sessions: list, delete'))
    check('a bare `sessions` runs the listing (an action on the parent command)', bare.status === 0 && bare.stdout.startsWith('No saved sessions for this project') && unplaced(bare.stdout) === unplaced(listed.stdout) && builtHelp('sessions').includes(' --all ') && builtHelp('sessions').includes(' --limit <n> '))
    check('`sessions list` is a sub-command with --all and --limit', builtHelp('sessions', 'list').includes('Usage: mercury sessions list [options]') && builtHelp('sessions', 'list').includes('--all List the saved sessions of every project, not only this one') && builtHelp('sessions', 'list').includes('--limit <n>'))
  }
  section('§4 a parked session is not live: `sessions delete` removes it, and only a session the board still homes is refused (the Windows box, report 428; liveness is boardHomedSessionIds in src/daemon/concourse-workers/queries.ts, read by src/commands/verbs/sessionsVerb.ts)')
  {
    const { existsSync } = await import('node:fs')
    const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
    const deleteVerb = (await import('../../src/commands/verbs/sessionsVerb.ts')).sessionsDeleteCli
    const parked = '44444444-4444-4444-8444-444444444444'
    const homed = '55555555-5555-4555-8555-555555555555'
    seed(STORE, parked, '2026-10-04T00:00:00.000Z', 'a parked chat')
    seed(STORE, homed, '2026-10-05T00:00:00.000Z', 'a chat the board still homes')
    const now = Date.now()
    const record = (runnerId: string, sessionId: string, more: Record<string, unknown>): Record<string, unknown> => ({ schema: 1, runnerId, sessionId, workspaceId: PROJ, isolation: 'shared', modelKey: 'claude-sonnet-5', spawnedAt: now - 60_000, lastLiveAt: now - 50_000, ...more })
    workers.updateConcourseWorkers(records => {
      Object.assign(records, {
        'concourse-w1': record('concourse-w1', parked, { pid: 2_147_000_000, parkedAt: now - 40_000, parkedBy: 'operator' }),
        'concourse-w2': record('concourse-w2', homed, { pid: process.pid }),
      })
    })
    const remove = async (sessionId: string): Promise<{ code: number; out: string[]; err: string[] }> => {
      const out: string[] = []
      const err: string[] = []
      const code = await deleteVerb(sessionId, { yes: true }, { out: (l: string) => out.push(l), err: (l: string) => err.push(l), interactive: false, ask: async () => false })
      return { code, out, err }
    }
    const listed = await run({})
    check('the list marks the homed session live and the parked one not', listed.out.some(l => l.startsWith(homed) && l.includes('  live  ')) && listed.out.some(l => l.startsWith(parked) && !l.includes('  live  ')), listed.out.join('\n'))
    const refused = await remove(homed)
    check('a session the board still homes is refused as live, and its transcript stands', refused.code === 1 && refused.err.some(l => l.includes('is live')) && existsSync(join(STORE, `${homed}.jsonl`)), JSON.stringify(refused))
    const removed = await remove(parked)
    check('the parked session, whose runner is gone, is deleted', removed.code === 0 && removed.out.some(l => l.startsWith(`Deleted session ${parked}`)) && !existsSync(join(STORE, `${parked}.jsonl`)), JSON.stringify(removed))
  }
} finally {
  removeScratch(HOME)
  removeScratch(PROJ)
  removeScratch(MIRROR_PROJ)
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SESSIONS LIST VERB RED')
  process.exit(1)
}
console.log('SESSIONS LIST VERB GREEN')

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DIST, MODEL, NODE, argAfter, bound, childEnv, makeTally, sleep } from '../daemon/dupline-world.ts'
import { findFiles } from './crew-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { endProcessGroup, spawnInOwnGroup } from '../lib/processGroup.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'

const { Database } = createRequire(import.meta.url)('bun:sqlite')
const tally = makeTally('prove-run-wake-closing-roads')
const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
const root = mkdtempSync(join(scratch, 'run-wake-roads-'))
const text = (words: string): WireBlock[] => [{ type: 'text', text: words }]
const tool = (name: string, input: Record<string, unknown>): WireBlock[] => [{ type: 'tool_use', name, input }]
const launch = (name: string, extra: Record<string, unknown> = {}): WireBlock[] => tool('Crewmate', { description: `${name} closing fixture`, name, team: 'research', prompt: `CLOSING-${name}`, crewmate_type: 'mercury-crew', run_in_background: true, ...extra })
const opens = (name: string) => (req: ScriptedRequest): boolean => req.opening.trim() === `CLOSING-${name}`
const world = (name: string): { home: string; cwd: string } => {
  const home = join(root, name, 'home'), cwd = join(root, name, 'work')
  seedScratchHome(home, cwd)
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
  return { home, cwd }
}

async function retiring(): Promise<void> {
  tally.section('a runner whose retirement is committed starts no seat')
  const { home, cwd } = world('retiring')
  const isCaptain = opens('captain')
  let launched = false, captainCalls = 0
  const fixture = await startScriptedFixture(req => {
    if (isCaptain(req)) {
      const call = captainCalls++
      if (call === 0) return tool('CrewBoard', { op: 'post', clientOpId: 'captain-ready', kind: 'result', text: '@main CAPTAIN-READY' })
      return text(call === 1 ? 'CAPTAIN-PARKED' : 'CAPTAIN-RESUMED')
    }
    if (!launched) { launched = true; return launch('captain', { captain: true }) }
    return text('LEAD-WAITING')
  })
  let raw = ''
  const host = hostRunner({ dist: DIST, node: NODE, cwd, home, env: { ...childEnv(home, Number(new URL(fixture.base).port)), HOME: home, USERPROFILE: home } as Record<string, string | undefined>, argv: ['--model', MODEL, '--sovereign'], raw: line => { raw += line } })
  try {
    await host.initialize({})
    await host.prompt('CLOSING-main')
    const deadline = Date.now() + bound(60_000)
    while (!(captainCalls >= 2 && host.rows.some(row => (row as { type?: string }).type === 'outcome'))) {
      assert(Date.now() < deadline, `the captain parks and the lead is told: ${raw.slice(-1200)}${host.stderr().slice(-600)}`)
      await sleep(25)
    }
    await sleep(1500)
    const token = 'r'.repeat(24)
    const prepared = await host.request('session/quiesce', { action: 'prepare', token })
    const committed = await host.request('session/quiesce', { action: 'commit', token })
    const posted = await host.request('session/board_post', { client_op_id: 'owner-after-commit', channel: 'team', target: 'research', text: 'OWNER-AFTER-COMMIT' }).catch((error: unknown) => ({ ok: false as const, reason: String(error) }))
    const code = await host.exited
    const db = new Database(findFiles(home, 'board.sqlite')[0]!, { readonly: true })
    try {
      const dispatches = Number((db.query('SELECT COUNT(*) AS n FROM wake_dispatches').get() as { n: number }).n)
      const claims = Number((db.query('SELECT COUNT(*) AS n FROM wake_claims').get() as { n: number }).n)
      const waiting = Number((db.query('SELECT COUNT(*) AS n FROM wake_events').get() as { n: number }).n)
      tally.check('the retirement is prepared and committed with the captain parked, and the runner ends by itself', prepared.phase === 'prepared' && committed.phase === 'committed' && code === 0, JSON.stringify({ prepared, committed, code }))
      tally.check('a post lands on the board between the commit and the end', posted.ok === true, JSON.stringify(posted))
      tally.check('no wake is claimed or admitted after the commit', dispatches === 0 && claims === 0, `dispatches=${dispatches} claims=${claims}`)
      tally.check('no request carries the post to the captain', !fixture.requests.some(req => isCaptain(req) && req.allTexts.some(words => words.includes('OWNER-AFTER-COMMIT'))))
      tally.check('the wake waits on the board for the runner that takes the session next', waiting === 1, `wake_events=${waiting}`)
    } finally { db.close() }
  } finally {
    endProcessGroup(host.child)
    await fixture.close()
  }
}

async function emptied(): Promise<void> {
  tally.section('an input that closes before the run has started')
  const reference = argAfter('--reference') ?? DIST
  const readings: { code: number | null; stdout: string; stderr: string }[] = []
  const fixture = await startScriptedFixture(() => text('NEVER-ASKED'))
  try {
    for (const dist of [reference, DIST]) {
      const { home, cwd } = world(`emptied-${readings.length}`)
      const child = spawnInOwnGroup(NODE, [dist, 'run', '--model', MODEL, '--sovereign', '--format', 'json', '-'], { cwd, env: { ...childEnv(home, Number(new URL(fixture.base).port)), HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => endProcessGroup(child), bound(60_000))
      child.stdout!.on('data', chunk => { stdout += chunk })
      child.stderr!.on('data', chunk => { stderr += chunk })
      child.stdin!.end()
      const code = await new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject) })
      clearTimeout(timer)
      readings.push({ code, stdout, stderr })
    }
    const [before, after] = readings
    tally.check('the run with no words ends with the status and the words of the reference', after!.code !== null && after!.code === before!.code && after!.stderr === before!.stderr && !after!.stderr.includes('ReferenceError'), JSON.stringify(readings))
    tally.check('no request was sent', fixture.requests.length === 0)
  } finally { await fixture.close() }
}

try {
  await retiring()
  await emptied()
} finally { rmSync(root, { recursive: true, force: true }) }
tally.finish()

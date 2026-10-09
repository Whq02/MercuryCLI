#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, bootRunner, bound, childEnv, isOutcome, makeTally, removeWorld, sleep } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type Script, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-background-launch-drive')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
console.log(' red on the base: the ON leg — a backgrounded worker born under the setting has no Agent tool in its first request and its launch never lands')
delete process.env.MERCURY_CONCOURSE_WORKER
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(SCRATCH_ROOT, 'bglaunch-drive-proof-home-'))

const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'bglaunch-drive-')))
const ASK = 'background-launch probe: launch the helper and report its answer'
const CHILD_PROMPT = 'background-launch probe child: say the word landed'
const CHILD_DONE = 'the helper says: landed'
const PARENT_DONE = 'the helper reported back'
const SID_ON = '550e8400-e29b-41d4-a716-4466554400f1'
const SID_OFF = '550e8400-e29b-41d4-a716-4466554400f2'
const KEY_NAME = 'backgroundSessionsLaunchCrewmates'

const isChild = (req: ScriptedRequest): boolean => req.opening.trim() === CHILD_PROMPT || req.allTexts.some(t => t.includes(CHILD_PROMPT))
const isMain = (req: ScriptedRequest): boolean => !isChild(req) && req.ask.includes(ASK)
const script: Script = req => {
  if (isChild(req)) return [{ type: 'text', text: CHILD_DONE }]
  if (isMain(req)) {
    if (req.step > 0) return [{ type: 'text', text: PARENT_DONE }]
    return [{ type: 'tool_use', name: 'Agent', input: { description: 'the background-launch helper', prompt: CHILD_PROMPT, subagent_type: 'mercury-crew' } }]
  }
  return [{ type: 'text', text: 'noted' }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)

const { updateConcourseWorkers } = await import('../../src/daemon/concourseWorkers.ts')

type World = { runHome: string; cwd: string; env: NodeJS.ProcessEnv; sid: string }
function world(name: string, sid: string, settingOn: boolean): World {
  const runHome = join(root, `${name}-home`)
  const cwd = join(root, `${name}-work`)
  seedScratchHome(runHome, cwd)
  if (settingOn) {
    const file = join(runHome, '.mercury.json')
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    config[KEY_NAME] = true
    writeFileSync(file, JSON.stringify(config))
  }
  const daemonDir = join(runHome, 'daemon')
  updateConcourseWorkers(ws => {
    ws['concourse-w1'] = { schema: 1, runnerId: 'concourse-w1', sessionId: sid, workspaceId: cwd, isolation: 'exclusive', modelKey: 'claude-opus-4-8', spawnedAt: Date.now(), lastLiveAt: Date.now() }
  }, daemonDir)
  const env: NodeJS.ProcessEnv = { ...childEnv(runHome, port), MERCURY_CONCOURSE_WORKER: '1' }
  return { runHome, cwd, env, sid }
}

async function waitUntil(test: () => boolean, timeoutMs: number): Promise<boolean> {
  const by = Date.now() + timeoutMs
  while (Date.now() < by) {
    if (test()) return true
    await sleep(100)
  }
  return test()
}

async function drive(w: World): Promise<{ first: ScriptedRequest | undefined; child: ScriptedRequest | undefined; followUp: ScriptedRequest | undefined; outcome: boolean; stderr: string }> {
  const before = fixture.requests.length
  const runner = bootRunner({ cwd: w.cwd, env: w.env, extraArgv: ['--session-id', w.sid] })
  void runner.prompt(ASK, randomUUID())
  const outcome = await runner.waitFor('the turn outcome', isOutcome, bound(90_000))
  await waitUntil(() => fixture.requests.slice(before).some(r => isMain(r) && r.step > 0), bound(5_000))
  const mine = fixture.requests.slice(before)
  const stderr = runner.stderr()
  await runner.stop(bound(5_000))
  return {
    first: mine.find(r => isMain(r) && r.step === 0),
    child: mine.find(isChild),
    followUp: mine.find(r => isMain(r) && r.step > 0),
    outcome: outcome !== null,
    stderr,
  }
}

tally.section('ON — a backgrounded worker (the role stamp, an unfocused untagged record) born with the setting on')
{
  const w = world('on', SID_ON, true)
  const r = await drive(w)
  tally.check('the worker took the turn to its outcome', r.outcome, r.stderr.slice(-400))
  tally.check("the FIRST request's tool list carries the Agent tool (never held out until a compaction)", r.first !== undefined && r.first.toolNames.includes('Agent'), r.first === undefined ? 'no first request' : r.first.toolNames.join(' '))
  tally.check("the model's Agent call launched a crewmate: the child's request reached the wire", r.child !== undefined, `${fixture.requests.length} requests: ${fixture.requests.map(q => `${q.n}:${isChild(q) ? 'child' : isMain(q) ? `main${q.step}` : 'other'}`).join(' ')}`)
  tally.check("the crewmate's answer came back to the worker as a plain tool result (no refusal)", r.followUp !== undefined && r.followUp.results.some(x => !x.isError && x.text.includes(CHILD_DONE)), JSON.stringify(r.followUp?.results ?? null).slice(0, 400))
  tally.check('the worker never saw the backgrounded refusal', !(r.followUp?.results ?? []).some(x => x.text.includes('this session is backgrounded')), JSON.stringify(r.followUp?.results ?? null).slice(0, 400))
}

tally.section('OFF — the same worker with the setting absent (the default): the Agent tool is not in the roster and the launch is refused')
{
  const w = world('off', SID_OFF, false)
  const r = await drive(w)
  tally.check('the worker took the turn to its outcome', r.outcome, r.stderr.slice(-400))
  tally.check("the FIRST request's tool list carries no Agent tool", r.first !== undefined && !r.first.toolNames.includes('Agent'), r.first === undefined ? 'no first request' : r.first.toolNames.join(' '))
  tally.check('no crewmate was launched: no child request reached the wire', r.child === undefined)
  tally.check("the model's Agent call came back as an error, never a crewmate's answer", r.followUp !== undefined && r.followUp.results.length > 0 && r.followUp.results.every(x => x.isError), JSON.stringify(r.followUp?.results ?? null).slice(0, 400))
}

await fixture.close()
await removeWorld(root)
tally.finish()

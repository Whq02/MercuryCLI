#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { DIST, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, isSession, isTurnOpen, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-resume-keeps-model')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)

const STARTED_MODEL = 'claude-sonnet-4-6'
const MODEL_MARK = '"metaKind":"model"'
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'resume-keeps-model-')))
const runHome = join(root, 'home')
const cwd = join(root, 'work')
seedScratchHome(runHome, cwd)

const refusing = createServer((req, res) => {
  req.on('data', () => {})
  req.on('end', () => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'the fixture never answers this turn' } }))
  })
})
await new Promise<void>(resolve => refusing.listen(0, '127.0.0.1', resolve))
const refusingPort = (refusing.address() as { port: number }).port
const answering = await startScriptedFixture(() => [{ type: 'text', text: 'answered by the fixture' }])
const answeringPort = Number(new URL(answering.base).port)

type Run = { frames: Frame[]; stderr: string; exitCode: number | null }
function runRows(port: number, argv: string[], ask: string): Promise<Run> {
  return new Promise(resolve => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', ...argv, ask], { cwd, env: childEnv(runHome, port), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ frames: frameLines(stdout), stderr, exitCode })
    }
    const timer = setTimeout(() => {
      console.log(`  [wait] run ${argv.join(' ')}: no exit within the budget`)
      child.kill('SIGKILL')
    }, bound(120_000))
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', code => finish(code))
    child.on('error', () => finish(null))
  })
}
const sessionOf = (run: Run): Frame | undefined => run.frames.find(isSession)
const turnOf = (run: Run): Frame | undefined => run.frames.find(isTurnOpen)
const outcomeOf = (run: Run): Frame | undefined => run.frames.find(isOutcome)
const modelsOf = (run: Run): { session: unknown; turn: unknown } => ({ session: sessionOf(run)?.model, turn: turnOf(run)?.model })

function transcriptOf(sessionId: string): string | null {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        const found = walk(full)
        if (found !== null) return found
      } else if (name === `${sessionId}.jsonl`) return full
    }
    return null
  }
  return existsSync(runHome) ? walk(runHome) : null
}
const linesOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
const servedModelsOf = (file: string): string[] =>
  linesOf(file)
    .map(l => {
      try {
        return JSON.parse(l) as { payload?: { kind?: string; model?: unknown } }
      } catch {
        return null
      }
    })
    .filter(r => r?.payload?.kind === 'output' && typeof r.payload.model === 'string' && r.payload.model !== '<synthetic>')
    .map(r => String(r!.payload!.model))
const modelEntriesOf = (file: string): string[] =>
  linesOf(file)
    .filter(l => l.includes(MODEL_MARK))
    .map(l => {
      const m = /"model":"((?:[^"\\]|\\.)*)"/.exec(l)
      return m ? m[1]! : ''
    })
const stripModelEntries = (file: string): void => {
  writeFileSync(file, linesOf(file).filter(l => !l.includes(MODEL_MARK)).map(l => `${l}\n`).join(''))
}

tally.section("§1 the field shape — a session started on a non-default model whose first turn is never answered")
const unanswered = await runRows(refusingPort, ['--model', STARTED_MODEL], 'the first turn of the unanswered session')
const sid = String(sessionOf(unanswered)?.session_id ?? '')
tally.check('the run names a session and ends on a failed outcome (the fixture refused the only turn)', sid !== '' && outcomeOf(unanswered)?.status === 'failed', JSON.stringify({ sid, outcome: outcomeOf(unanswered) }).slice(0, 240))
tally.check('the session row and the turn row name the started model', sessionOf(unanswered)?.model === STARTED_MODEL && turnOf(unanswered)?.model === STARTED_MODEL, JSON.stringify(modelsOf(unanswered)))
const transcript = sid === '' ? null : transcriptOf(sid)
tally.check('the transcript exists and holds no answer row served on the started model', transcript !== null && !servedModelsOf(transcript).includes(STARTED_MODEL), JSON.stringify({ transcript, served: transcript ? servedModelsOf(transcript) : null }))
tally.check('the transcript carries the model entry naming the started model (red on the base: no such entry)', transcript !== null && modelEntriesOf(transcript).includes(STARTED_MODEL), JSON.stringify({ entries: transcript ? modelEntriesOf(transcript) : null }))

tally.section('§2 the default of this home, measured — the model a resume falls to when it forgets')
const control = await runRows(answeringPort, [], 'a plain turn on the default model')
const defaultModel = String(sessionOf(control)?.model ?? '')
tally.check('a plain run answers on the default model, which is not the started model', outcomeOf(control)?.status === 'completed' && defaultModel !== '' && defaultModel !== STARTED_MODEL, JSON.stringify({ defaultModel, outcome: outcomeOf(control)?.status }))

tally.section('§3 the headless road — run --resume continues the unanswered session on the model it was started with')
const requestsBefore = answering.requests.length
const resumed = await runRows(answeringPort, ['--resume', sid], 'the second turn, after a resume')
tally.check('the resumed run completes in the same session', outcomeOf(resumed)?.status === 'completed' && outcomeOf(resumed)?.session_id === sid, JSON.stringify({ outcome: outcomeOf(resumed), stderr: resumed.stderr.slice(0, 200) }))
tally.check('the resumed session row and turn row name the started model, never the default (red on the base: the default)', sessionOf(resumed)?.model === STARTED_MODEL && turnOf(resumed)?.model === STARTED_MODEL, JSON.stringify({ ...modelsOf(resumed), defaultModel }))
const wire = answering.requests.slice(requestsBefore)
tally.check('the request that answered the resumed turn went to the wire on the started model', wire.length >= 1 && transcript !== null && servedModelsOf(transcript).includes(STARTED_MODEL), JSON.stringify({ requests: wire.length, served: transcript ? servedModelsOf(transcript) : null }))
tally.check('the resume said nothing about the model on stderr', !/model/i.test(resumed.stderr), resumed.stderr.slice(0, 200))

tally.section('§4 an old-shape transcript — no model entry — still resumes as it did: an unanswered session falls to the default, no refusal, no notice')
const oldUnanswered = await runRows(refusingPort, ['--model', STARTED_MODEL], 'an old-shape session whose first turn is never answered')
const oldSid = String(sessionOf(oldUnanswered)?.session_id ?? '')
const oldTranscript = oldSid === '' ? null : transcriptOf(oldSid)
if (oldTranscript !== null) stripModelEntries(oldTranscript)
tally.check('the fixture transcript holds no model entry and no served answer row', oldTranscript !== null && modelEntriesOf(oldTranscript).length === 0 && servedModelsOf(oldTranscript).length === 0, JSON.stringify({ oldTranscript }))
const oldResumed = await runRows(answeringPort, ['--resume', oldSid], 'the second turn of the old-shape session')
tally.check('the old-shape unanswered session resumes on the default model, as today, and completes', outcomeOf(oldResumed)?.status === 'completed' && outcomeOf(oldResumed)?.session_id === oldSid && sessionOf(oldResumed)?.model === defaultModel && turnOf(oldResumed)?.model === defaultModel, JSON.stringify({ ...modelsOf(oldResumed), defaultModel, outcome: outcomeOf(oldResumed)?.status }))
tally.check('nothing on stderr names the model or a migration', !/model|migrat/i.test(oldResumed.stderr), oldResumed.stderr.slice(0, 200))

tally.section('§5 an old-shape transcript WITH an answered turn still resumes on the answered model (the answer-row recovery stands)')
const oldAnswered = await runRows(answeringPort, ['--model', STARTED_MODEL], 'an old-shape session that was answered')
const answeredSid = String(sessionOf(oldAnswered)?.session_id ?? '')
const answeredTranscript = answeredSid === '' ? null : transcriptOf(answeredSid)
if (answeredTranscript !== null) stripModelEntries(answeredTranscript)
tally.check('the fixture transcript holds no model entry but an answer row served on the started model', answeredTranscript !== null && modelEntriesOf(answeredTranscript).length === 0 && servedModelsOf(answeredTranscript).includes(STARTED_MODEL), JSON.stringify({ answeredTranscript, served: answeredTranscript ? servedModelsOf(answeredTranscript) : null }))
const answeredResumed = await runRows(answeringPort, ['--resume', answeredSid], 'the second turn of the answered old-shape session')
tally.check('the answered old-shape session resumes on the model its answer rows name', outcomeOf(answeredResumed)?.status === 'completed' && sessionOf(answeredResumed)?.model === STARTED_MODEL && turnOf(answeredResumed)?.model === STARTED_MODEL, JSON.stringify(modelsOf(answeredResumed)))

tally.section('§6 the resume command naming another model wins over the entry')
const overridden = await runRows(answeringPort, ['--resume', sid, '--model', defaultModel], 'a third turn, resumed with --model')
tally.check('--model on the resume command is the model of the resumed turn', outcomeOf(overridden)?.status === 'completed' && sessionOf(overridden)?.model === defaultModel && turnOf(overridden)?.model === defaultModel, JSON.stringify({ ...modelsOf(overridden), defaultModel }))
tally.check("the session's model entry now reads the model the resume named, so the next resume keeps it", transcript !== null && modelEntriesOf(transcript).at(-1) === defaultModel, JSON.stringify({ entries: transcript ? modelEntriesOf(transcript) : null }))

await answering.close()
await new Promise<void>(resolve => refusing.close(() => resolve()))
rmSync(root, { recursive: true, force: true })
tally.finish()

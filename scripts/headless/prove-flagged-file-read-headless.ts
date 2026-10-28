#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, MODEL, NODE, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { frameLines, isOutcome, type Frame } from '../lib/rows.ts'
import { seedScratchHome, startScriptedFixture, type WireBlock } from '../lib/scriptedTurn.ts'

if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — build the product first')
  process.exit(1)
}
const tally = makeTally('prove-flagged-file-read-headless')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'flagged-file-read-')))
const project = join(scratch, 'project')
const runHome = join(scratch, 'run-home')
const outsideDir = join(scratch, 'outside')
mkdirSync(outsideDir, { recursive: true })
const MARKER = 'outside marker 7f1670'
const outside = join(outsideDir, 'words')
writeFileSync(outside, `${MARKER}\n`)
seedScratchHome(runHome, project)
writeFileSync(join(project, 'README'), 'hello alpha\n')
writeFileSync(join(project, 'list'), 'README\n')
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

type Probe = { ask: string; command: string }
const probes: Probe[] = [
  { ask: 'read the words through xargs', command: `xargs -a ${outside} echo` },
  { ask: 'read the words through cat', command: `cat ${outside}` },
  { ask: 'read the list through xargs', command: process.platform === 'linux' ? 'xargs -a list echo' : 'xargs echo < list' },
]
const seen = new Map<string, { text: string; isError: boolean }>()
const fixture = await startScriptedFixture(req => {
  const probe = probes.find(p => p.ask === req.ask.trim())
  if (probe === undefined) return [{ type: 'text', text: 'ok' }]
  if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: probe.command, description: 'Read a file' } } as WireBlock]
  const last = req.results[req.results.length - 1]
  if (last !== undefined) seen.set(probe.ask, { text: last.text, isError: last.isError })
  return [{ type: 'text', text: 'Done.' }]
})

type Turn = { rows: Frame[]; stdout: string; stderr: string; exitCode: number | null }
const runOnce = (ask: string): Promise<Turn> =>
  new Promise(resolve => {
    const port = Number(new URL(fixture.base).port)
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--model', MODEL, '--', ask], { cwd: project, env: childEnv(runHome, port), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ rows: frameLines(stdout), stdout, stderr, exitCode: code })
    })
  })

const transcriptText = (): string => {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.jsonl?$/.test(name)) out.push(readFileSync(full, 'utf8'))
    }
  }
  walk(join(runHome, 'projects'))
  return out.join('\n')
}

const DENIAL = `Mercury needs permission to read ${outside}, outside the starting folder ('${project}')`

try {
  tally.section('§1 a scripted model reads a file outside the starting folder through xargs -a: auto-denied, nothing of the file reaches the model')
  {
    const turn = await runOnce(probes[0]!.ask)
    const result = seen.get(probes[0]!.ask)
    tally.check('the run reached an outcome', turn.rows.some(isOutcome), `exit ${String(turn.exitCode)} · ${turn.stderr.slice(0, 300)}`)
    tally.check('the tool result the model read is an error', result !== undefined && result.isError, JSON.stringify(result))
    tally.check('…carrying the existing read sentence', result !== undefined && result.text.includes(DENIAL), result?.text.slice(0, 400))
    tally.check("…and none of the file's words", result !== undefined && !result.text.includes(MARKER), result?.text.slice(0, 400))
    tally.check('the rows carry none of the words', !turn.stdout.includes(MARKER))
    tally.check('the transcript on disk carries none of the words', !transcriptText().includes(MARKER))
  }

  tally.section('§2 the same read through cat is denied the same way (the control)')
  {
    const turn = await runOnce(probes[1]!.ask)
    const result = seen.get(probes[1]!.ask)
    tally.check('the run reached an outcome', turn.rows.some(isOutcome), `exit ${String(turn.exitCode)}`)
    tally.check('cat of the outside file is an error with the same sentence', result !== undefined && result.isError && result.text.includes(DENIAL), result?.text.slice(0, 400))
    tally.check("…and none of the file's words", result !== undefined && !result.text.includes(MARKER))
  }

  tally.section(`§3 the in-folder ${probes[2]!.command} runs unprompted and returns its words`)
  {
    const turn = await runOnce(probes[2]!.ask)
    const result = seen.get(probes[2]!.ask)
    tally.check('the run reached an outcome', turn.rows.some(isOutcome), `exit ${String(turn.exitCode)}`)
    tally.check('the tool result is not an error', result !== undefined && !result.isError, JSON.stringify(result)?.slice(0, 400))
    tally.check('…and carries README, the line of the in-folder list', result !== undefined && /\bREADME\b/.test(result.text), result?.text.slice(0, 400))
  }
} finally {
  await fixture.close()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()

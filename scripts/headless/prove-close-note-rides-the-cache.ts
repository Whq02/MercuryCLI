#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { run } from '../../sdk/src/index.ts'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const finalAnswer = 'DONE\nThe file contains fixture input.'
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)])

for (const format of ['rows', 'json', 'text', 'sdk'] as const) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'no-close-note-')))
  seedFirstRun(home, [home])
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'input.txt'), 'fixture input\n')
  const turns: ScriptedTurn[] = [
    { kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'input.txt') }, usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 30 } },
    { kind: 'text', text: finalAnswer, usage: { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 40 } },
    handoffTurn('This extra call must never run.'),
  ]
  const api = await startFixtureApi(turns)
  const env = { HOME: home, PATH: process.env.PATH!, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }
  let out = '', err = '', code: number | null = null
  let rows: Array<Record<string, any>> = []
  let outcome: Record<string, any> | undefined
  try {
    if (format === 'sdk') {
      const task = run({ mercury: ['node', dist], cwd, env, prompt: 'Read input.txt and answer.', mode: 'flow' })
      outcome = await task.outcome
      code = (await task.exit).code
      rows = task.rows as Array<Record<string, any>>
      check('SDK final message is the model answer', outcome.answer === finalAnswer)
    } else {
      const child = spawn('node', [dist, 'run', '--format', format, '--mode', 'flow', 'Read input.txt and answer.'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', d => { out += String(d) })
      child.stderr.on('data', d => { err += String(d) })
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      try { code = await new Promise<number | null>(resolve => child.once('close', resolve)) } finally { clearTimeout(timer) }
      if (format === 'rows') {
        rows = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        outcome = rows.find(row => row.type === 'outcome')
        check('rows carry the final answer unchanged', rows.filter(row => row.type === 'text').map(row => row.text).join('') === finalAnswer)
      } else if (format === 'json') outcome = JSON.parse(out)
      else check('text output is the final answer unchanged', out === `${finalAnswer}\n`)
    }
    const requests = api.messageRequests()
    check(`${format}: run exits successfully`, code === 0, JSON.stringify({ code, err: err.slice(0, 300) }))
    check(`${format}: two task calls, not three`, requests.length === 2, String(requests.length))
    check(`${format}: no close-note request`, !requests.some(request => isHandoffRequest(request)), String(requests.filter(request => isHandoffRequest(request)).length))
    check(`${format}: no close-note row`, !rows.some(row => row.type === 'close'))
    if (outcome) {
      check(`${format}: outcome has the final answer and exit-road status`, outcome.answer === finalAnswer && outcome.status === 'completed')
      check(`${format}: outcome counts task calls and their tokens only`, outcome.steps === 2 && outcome.usage.input_tokens === 290 && outcome.usage.output_tokens === 22 && outcome.usage.cached_input_tokens === 70, JSON.stringify(outcome.usage))
    }
    if (rows.length) check(`${format}: one tool call and result survive`, rows.filter(row => row.type === 'tool_call').length === 1 && rows.filter(row => row.type === 'tool_result').length === 1)
    const config = JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8'))
    const project = Object.values(config.projects).find((value: any) => value.lastSessionId) as Record<string, any> | undefined
    check(`${format}: saved session counts exclude the removed call`, project?.lastTotalInputTokens === 220 && project?.lastTotalOutputTokens === 22 && project?.lastTotalCacheReadInputTokens === 70, JSON.stringify(project && { input: project.lastTotalInputTokens, output: project.lastTotalOutputTokens, cached: project.lastTotalCacheReadInputTokens }))
    const transcripts = filesUnder(home).filter(file => file.endsWith('.jsonl')).map(file => readFileSync(file, 'utf8')).join('\n')
    check(`${format}: recorded final answer stays whole`, transcripts.includes(JSON.stringify(finalAnswer).slice(1, -1)))
    check(`${format}: no synthetic note is recorded`, !transcripts.includes('This extra call must never run.'))
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}
console.log(failures === 0 ? 'NO HEADLESS CLOSE CALL: ALL PASS' : `no headless close call: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
const home = realpathSync(mkdtempSync(join(tmpdir(), 'run-literal-')))
seedFirstRun(home, [home])
const note = join(home, 'note.txt')
const marker = 'THE_FILE_ATTACHMENT_MARKER'
writeFileSync(note, marker)
const api = await startFixtureApi(Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'The literal input answered.' })))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
async function run(prompt: string | undefined, input: string) {
  const before = api.messageRequests().length
  const child = spawn('node', [dist, 'run', ...(prompt === undefined ? [] : [prompt])], { cwd: home, env: { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: api.url }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  clearTimeout(timeout)
  return { code, out, err, bodies: JSON.stringify(api.messageRequests().slice(before).map(request => request.body)) }
}
const evidence = (result: Awaited<ReturnType<typeof run>>) => JSON.stringify({ code: result.code, out: result.out, err: result.err, requests: JSON.parse(result.bodies).length, expandedFile: result.bodies.includes(marker) })
try {
  for (const prompt of ['-', undefined]) {
    for (const input of ['/help', `@${note}`, `/help\n@${note}`]) {
      const result = await run(prompt, input)
      check('stdin prompt text does not invoke a command or expand a path', result.code === 0 && result.out.trim() === 'The literal input answered.' && result.bodies.includes(input.split('\n')[0]!) && !result.bodies.includes(marker), evidence(result))
    }
  }
  const context = await run('summarize this input', `@${note}`)
  check('piped context stays literal beside an argument', context.code === 0 && context.bodies.includes(note) && !context.bodies.includes(marker), evidence(context))
  const argument = await run(`summarize @${note}`, '')
  check('a path in the prompt argument still expands', argument.code === 0 && argument.bodies.includes(marker), evidence(argument))
  const command = await run('/help', `@${note}`)
  check('a command argument still takes its command road', command.code === 1 && command.err.includes('/help') && command.bodies === '[]', evidence(command))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)

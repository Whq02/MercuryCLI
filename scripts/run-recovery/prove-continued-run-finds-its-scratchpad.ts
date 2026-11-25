#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isHandoffRequest, startFixtureApi } from '../lib/fixtureApi.ts'

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  console.log(!existsSync(DIST) ? '❌ dist/mercury.mjs absent — build first with bun run build.ts' : '❌ no node binary on PATH — this proof spawns dist/mercury.mjs with it')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'continued-scratchpad-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'cwd')
mkdirSync(join(home, '.mercury'), { recursive: true })
mkdirSync(cwd, { recursive: true })
const api = await startFixtureApi([
  { kind: 'text', text: 'The first run answered.' },
  { kind: 'paced', deltas: ['The continued run answered.'], gapMs: 10, startDelayMs: 1500 },
])
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: join(home, '.mercury'),
  MERCURY_TMPDIR: join(scratch, 'tmp'),
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_TRUST_DIALOG_ACCEPTED: '1',
}
function run(args: string[]): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(nodeBin!, [DIST, 'run', ...args, '--model', 'claude-opus-4-8', '--format', 'text'], { cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      resolve({ exit, stdout, stderr })
    })
  })
}
const turns = (): string[] => api.messageRequests().filter(request => !isHandoffRequest(request)).map(request => request.raw)
const scratchpadNamedIn = (raw: string | undefined): string => /Scratchpad directory: (\S+) —/.exec(raw ?? '')?.[1] ?? ''

try {
  console.log('a run, then the same session continued: the scratchpad its instructions name is there again')
  const first = await run(['Say hi.'])
  const named = scratchpadNamedIn(turns()[0])
  check('the first run answers and its instructions name a scratchpad under the temp root', first.exit === 0 && first.stdout.includes('The first run answered.') && named.startsWith(join(scratch, 'tmp')), JSON.stringify({ ...first, named }))
  check('the first run\'s end swept that folder', named !== '' && !existsSync(named), named)

  const continued = run(['-c', 'Say hi again.'])
  await Promise.race([api.messageRequestStarted(2), continued])
  const namedAgain = scratchpadNamedIn(turns()[1])
  const thereWhileTheTurnIsOpen = namedAgain !== '' && existsSync(namedAgain)
  const second = await continued
  check('the continued run answers and its instructions name the same folder', second.exit === 0 && second.stdout.includes('The continued run answered.') && namedAgain === named, JSON.stringify({ ...second, named, namedAgain }))
  check('that folder exists while the continued run\'s turn is open, so the model\'s first write into it lands', thereWhileTheTurnIsOpen, `${namedAgain} was missing: a continued session restores its first exchange and never composes the scratchpad line again, so the folder must be made when the session takes its id (the session-switch listener in src/boot/entrypoints/init.ts, ensureScratchpadDir in src/platform/files/scratchpad.ts)`)
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ a continued run finds its scratchpad' : `\n❌ a continued run finds its scratchpad: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

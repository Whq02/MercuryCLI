#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'leave-engine-gone-')))
process.env.MERCURY_CONFIG_DIR = join(ROOT, 'proof-home')

const { startTensorFoldPromptFixture } = await import('../provider-compat/tensorfoldPromptFixture.ts')
const { hostRunner } = await import('../lib/runnerHost.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const MODEL = 'qwen3.5-4b'
const GONE_CEILING_MS = 5_000
const WATCH_MS = 15_000

type Leave = { answer: string; ms: number; interrupted: boolean; debug: string; requests: number }

async function session(name: string, after: (fixture: ReturnType<typeof startTensorFoldPromptFixture>) => void): Promise<Leave> {
  const fixture = startTensorFoldPromptFixture({ model: MODEL, template: 'after-last-user' })
  const world = join(ROOT, name)
  const home = join(world, 'home')
  const cwd = join(world, 'project')
  const cfg = join(home, '.mercury')
  mkdirSync(join(cfg, 'tmp'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# a project\n')
  spawnSync('git', ['init', '-q', cwd])
  seedFirstRun(cfg, [cwd])
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    TERM: 'dumb',
    DEBUG: '1',
    MERCURY_CONFIG_DIR: cfg,
    MERCURY_TMPDIR: join(cfg, 'tmp'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=${fixture.root}`,
    MERCURY_CREDENTIAL_STORE: 'file',
  }
  const host = hostRunner({ dist: DIST, node: NODE, cwd, home, env, argv: ['--model', `local/${MODEL}`], report: () => {} })
  host.onAsk(() => ({ outcome: 'deny', message: 'no tools in this proof' }) as never)
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
  const leave: Leave = { answer: '', ms: -1, interrupted: false, debug: '', requests: 0 }
  try {
    await host.initialize()
    fixture.reply({ reasoning: 'Five words about the sea.', text: 'Deep blue waves crash endlessly.' })
    await host.prompt('Reply with exactly five words about the sea.')
    await host.waitFor('the first turn', (row: { type?: unknown; turn?: unknown }) => row.type === 'outcome' && row.turn === 1, 60_000)
    after(fixture)
    await sleep(300)
    const before = fixture.requests.length
    const started = Date.now()
    const asked = host.request('session/leave' as never, {} as never, null).then(
      (value: unknown) => {
        leave.ms = Date.now() - started
        leave.answer = JSON.stringify(value)
      },
      (error: unknown) => {
        leave.ms = Date.now() - started
        leave.answer = `refused: ${error instanceof Error ? error.message : String(error)}`
      },
    )
    const settled = await Promise.race([asked.then(() => true), sleep(WATCH_MS).then(() => false)])
    if (!settled) {
      leave.interrupted = true
      await host.request('turn/interrupt' as never, {} as never, 10_000).catch(() => undefined)
      await Promise.race([asked, sleep(10_000)])
    }
    leave.requests = fixture.requests.length - before
  } finally {
    host.end()
    await Promise.race([host.exited, sleep(8_000)])
    clearTimeout(killer)
    host.child.kill('SIGKILL')
    host.peer.close('the proof ended the runner')
    fixture.stop()
  }
  const logs = join(cfg, 'debug')
  leave.debug = existsSync(logs) ? readdirSync(logs).filter(file => file.endsWith('.txt')).map(file => readFileSync(join(logs, file), 'utf8')).join('\n') : ''
  return leave
}

section(`1 · a session on local/${MODEL}, one turn, its engine stopped, then the leave a window's /exit sends`)
{
  const gone = await session('gone', fixture => fixture.stop())
  const outages = gone.debug.split('\n').filter(line => line.includes('network outage') && line.includes('connection refused'))
  console.log(`  the leave answered ${gone.answer || 'nothing'} after ${gone.ms} ms${gone.interrupted ? `, interrupted at ${WATCH_MS} ms` : ''}`)
  check(`the leave answers inside ${GONE_CEILING_MS / 1000} s with no note and the session's ledger closed, where it stood on the reconnect ladder until it was interrupted`, !gone.interrupted && gone.ms >= 0 && gone.ms < GONE_CEILING_MS && gone.answer === '{"note":"none","ledger":"closed"}', `${gone.answer || 'no answer'} after ${gone.ms} ms${gone.interrupted ? `, interrupted at ${WATCH_MS} ms` : ''}`)
  check('the handoff met one refused connection and waited for no reconnect', outages.length === 1 && outages[0]!.includes('before reconnect 1'), outages.map(line => line.slice(line.indexOf('network outage'))).join(' | ') || gone.debug.split('\n').filter(line => line.includes('handoff')).join(' | '))
}

section('2 · the same with its engine there and slow: the leave waits for the note')
{
  const slow = await session('slow', fixture => {
    fixture.holdNext(3_000)
    fixture.reply({ text: 'The work: five words about the sea were written. Still to do: nothing.' })
  })
  const answer = slow.answer === '' ? null : (JSON.parse(slow.answer) as { note?: string; ledger?: string; noteChars?: number })
  console.log(`  the leave answered ${slow.answer || 'nothing'} after ${slow.ms} ms`)
  check('a reply held three seconds is waited for and the note stored', !slow.interrupted && slow.ms >= 2_900 && answer?.note === 'stored' && answer.ledger === 'closed' && typeof answer.noteChars === 'number' && slow.requests >= 1, `${slow.answer || 'no answer'} after ${slow.ms} ms · ${slow.requests} request(s)`)
}

if (failures === 0) rmSync(ROOT, { recursive: true, force: true })
else console.log(`\n  [record] the worlds are kept at ${ROOT}`)
console.log(`\nprove-leave-engine-gone: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)

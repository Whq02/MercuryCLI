#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DIST, NODE, REPO, SCRATCH_ROOT, bound, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { seedScratchHome, startScriptedFixture, textScript } from '../lib/scratchSeat.ts'
import { processGone } from '../lib/seatForensics.ts'

const tally = makeTally('prove-seat-launcher')
const root = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'seat-launcher-')))
const launcherModule = join(REPO, 'scripts', 'lib', 'seatLauncher.ts')
const psOf = (pid: number, column: string): string => {
  try {
    return execFileSync('ps', ['-o', `${column}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

tally.section('§1 the one owner: scripts/lib/seatLauncher.ts decides what boots a seat; the three proofs that wrote their own source launcher now ask it')
{
  tally.check('scripts/lib/seatLauncher.ts exists', existsSync(launcherModule))
  const entrySpelling = ['entrypoints', 'cli.tsx'].join('/')
  for (const file of ['scripts/headless/prove-headless-ask-unanswered.ts', 'scripts/daemon/prove-unattended-ask-denied.ts', 'scripts/settings/prove-settings-watch-beside-a-named-pipe.ts']) {
    const text = readFileSync(join(REPO, file), 'utf8')
    tally.check(`${file} imports the launcher helper and never spells the cli entry itself`, text.includes("from '../lib/seatLauncher.ts'") && !text.includes(entrySpelling) && !text.includes("'entrypoints', 'cli.tsx'"))
  }
  const helper = existsSync(launcherModule) ? readFileSync(launcherModule, 'utf8') : ''
  tally.check('the helper is the one place that spells the cli entry for a source seat', helper.includes("'entrypoints', 'cli.tsx'"))
}

const launcher = existsSync(launcherModule) ? await import('../lib/seatLauncher.ts') : null

tally.section('§2 under MERCURY_GATE_PREBUILT=1 a seat is the built product under node; without it, the source under bun; a proof that needs the source says so')
if (launcher === null) tally.check('the launcher helper imports', false, 'scripts/lib/seatLauncher.ts is missing')
else {
  const hadPrebuilt = process.env.MERCURY_GATE_PREBUILT
  process.env.MERCURY_GATE_PREBUILT = '1'
  const built = existsSync(DIST) ? launcher.seatRuntime(join(root, 'decide-built')) : null
  tally.check('PREBUILT=1 → runtime node, script dist/mercury.mjs', built !== null && built.runtime === 'node' && built.script === DIST && built.exe === NODE, built === null ? `${DIST} is absent: build first` : launcher.describeSeat(built))
  const source = launcher.seatRuntime(root, { source: 'required', name: 'source-required.ts' })
  tally.check("PREBUILT=1 with source: 'required' → runtime bun, a launcher importing src/entrypoints/cli.tsx", source.runtime === 'bun' && existsSync(source.script) && readFileSync(source.script, 'utf8').includes(join('src', 'entrypoints', 'cli.tsx')), launcher.describeSeat(source))
  delete process.env.MERCURY_GATE_PREBUILT
  const local = launcher.seatRuntime(root, { name: 'local.ts' })
  tally.check('no PREBUILT → runtime bun from the source (the local reading keeps the source road)', local.runtime === 'bun' && local.from === 'the source' && basename(local.script) === 'local.ts', launcher.describeSeat(local))
  if (hadPrebuilt !== undefined) process.env.MERCURY_GATE_PREBUILT = hadPrebuilt
}

tally.section('§3 a seat launched under PREBUILT runs node (read from the live process) and answers initialize')
if (launcher !== null && existsSync(DIST)) {
  const hadPrebuilt = process.env.MERCURY_GATE_PREBUILT
  process.env.MERCURY_GATE_PREBUILT = '1'
  const seat = launcher.seatRuntime(join(root, 'live'))
  if (hadPrebuilt === undefined) delete process.env.MERCURY_GATE_PREBUILT
  else process.env.MERCURY_GATE_PREBUILT = hadPrebuilt
  const runHome = join(root, 'live-home')
  const cwd = join(runHome, 'work')
  seedScratchHome(runHome, cwd)
  const fixture = await startScriptedFixture(textScript('answered'))
  const seatLog = join(root, 'live-seat-debug.txt')
  const host = hostRunner({ node: seat.exe, dist: seat.script, argv: ['--model', 'claude-opus-4-8', '--log-file', seatLog], cwd, env: childEnv(runHome, Number(new URL(fixture.base).port)) as Record<string, string | undefined>, home: runHome, onRow: () => {} })
  const pid = host.child.pid ?? 0
  const comm = psOf(pid, 'comm')
  const args = psOf(pid, 'args')
  let answered = false
  let detail = ''
  try {
    const result = await host.initialize({}, bound(60_000))
    answered = typeof result.session_id === 'string'
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error)
  }
  tally.check('the live seat is a node process (ps comm), not bun', /node/.test(basename(comm)) && !/bun/.test(basename(comm)), `comm=${comm}`)
  tally.check('…running dist/mercury.mjs (ps args)', args.includes('mercury.mjs') && !args.includes('cli.tsx'), `args=${args.slice(0, 160)}`)
  tally.check('…and it answers initialize', answered, detail)
  host.end()
  await host.stop(3_000)
  await fixture.close()
} else tally.check('§3 needs the launcher helper and a built dist', false, launcher === null ? 'no helper' : `${DIST} is absent: build first`)

tally.section('§4 a deliberately silent seat: the launcher prints the forensics block (state, threads, children, sockets, the seat\'s own log tail) when its wait passes')
{
  const silentScript = join(root, 'silent-seat.mjs')
  writeFileSync(silentScript, "process.stdin.resume()\nsetInterval(() => {}, 1 << 30)\n")
  const seatLog = join(root, 'silent-seat-debug.txt')
  writeFileSync(seatLog, 'boot: the silent seat started\nstall detector armed\nthe last line before the silence\n')
  const blocks: string[] = []
  const host = hostRunner({ node: NODE, dist: silentScript, argv: ['--log-file', seatLog], cwd: root, home: root, env: { MERCURY_CONFIG_DIR: join(root, 'silent-home') }, report: text => blocks.push(text) })
  let failed = ''
  const started = Date.now()
  try {
    await host.initialize({}, 1_500)
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error)
  }
  const elapsed = Date.now() - started
  const block = blocks.join('\n')
  tally.check('initialize fails at its deadline (the seat never answers)', /initialize: no answer within 1500 ms/.test(failed), `${failed} after ${elapsed} ms`)
  tally.check('one forensics block is printed by the launcher, not by the proof', blocks.length === 1 && block.startsWith('[seat forensics] initialize: no answer within 1500 ms'), `${blocks.length} block(s): ${block.slice(0, 120)}`)
  tally.check('…naming the seat pid and the command', host.child.pid !== undefined && block.includes(`the seat ${host.child.pid}`) && block.includes(silentScript), block.slice(0, 300))
  tally.check('…its state and wait channel', /waits in \S+ · State: \S+/.test(block), block.split('\n')[1] ?? '')
  tally.check('…its threads, children and sockets', block.includes('threads:') && block.includes('children:') && block.includes('sockets:'))
  tally.check("…and the tail of the seat's own log, last line last", /the seat's own log \(last lines\):\n(.*\n)*.*the last line before the silence\s*$/.test(block), block.split("the seat's own log")[1]?.slice(0, 200) ?? '(no log section)')
  tally.check('the silent read itself is bounded (under 15 s on this box)', elapsed < 15_000, `${elapsed} ms`)
  const alivePid = host.child.pid ?? 0
  tally.check('processGone reads the live seat as present', alivePid !== 0 && !processGone(alivePid))
  await host.stop(1_000)
  const second = host.silent('after the seat ended')
  tally.check('once the seat has exited, silent() prints nothing and returns null', second === null && blocks.length === 1)
  tally.check('processGone reads the stopped seat as gone (dead or a zombie the runtime never reaped)', processGone(alivePid))
}

rmSync(root, { recursive: true, force: true })
tally.finish()

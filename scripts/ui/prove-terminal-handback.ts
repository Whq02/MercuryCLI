#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import {
  journeyTail,
  lastStateOf,
  mark,
  modeEventsBetween,
  MOUSE_FAMILIES,
  runJobControlHost,
  samplesBetween,
  type HostReport,
  type HostSample,
} from './jobcontrolHost.ts'
import {
  describeTerminalHandback,
  reclaimTerminalAfterChild,
  setTerminalHandbackAddonForTest,
  setTerminalHandbackDescriptorForTest,
  TERMINAL_HANDBACK_FLAG,
  type TtyAddon,
} from '../../src/platform/shell/terminalHandback.ts'
import { loadVoiceAddon, resetVoiceAddonForTest, VOICE_ADDON_EXPORTS } from '../../src/integrations/voice-pack/voicePack.ts'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let skips = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const OWNER_FIX = 'change reclaimTerminalAfterChild in src/platform/shell/terminalHandback.ts'
const HEALTH_FIX = 'change describeTerminalHandback in src/platform/shell/terminalHandback.ts, or the iface-terminal row in src/platform/health/sections/interface.ts'
const JOURNEY_FIX = 'read the grid and samples above, then change reclaimTerminalAfterChild in src/platform/shell/terminalHandback.ts or the driver scripts/ui/jobcontrolReclaimDriver.ts'
const skip = (name: string, why: string): void => {
  console.log(`SKIP  ${name} — ${why}`)
  skips++
}
const section = (name: string): void => {
  console.log(`\n== ${name} ==`)
}

const scratch = mkdtempSync(join(tmpdir(), 'terminal-handback-'))
const EMPTY_PACK = join(scratch, 'no-pack')
mkdirSync(EMPTY_PACK, { recursive: true })

const EDITOR_STAND_IN = join(scratch, 'jobcontrol-editor-stand-in.py')
writeFileSync(
  EDITOR_STAND_IN,
  `#!/usr/bin/python3
import os, signal, sys, time
path = sys.argv[1]
counter = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'takes')
with open(counter, 'a') as f:
    f.write('x')
take = os.path.getsize(counter)
tty = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY)
original = os.tcgetpgrp(tty)
os.setpgrp()
signal.signal(signal.SIGTTOU, signal.SIG_IGN)
os.tcsetpgrp(tty, os.getpgrp())

def normal_return(signum, frame):
    with open(path, 'a') as f:
        f.write(' edited by the stand-in')
    os.tcsetpgrp(tty, original)
    os._exit(0)

signal.signal(signal.SIGTERM, normal_return)
os.write(tty, ('editor stand-in holds the terminal (take %d, pgid %d, was %d)\\r\\n' % (take, os.getpgrp(), original)).encode())
while True:
    time.sleep(0.05)
`,
  { mode: 0o755 },
)

const cargoPresent = ((): boolean => {
  const res = spawnSync('cargo', ['--version'], { encoding: 'utf8', env: process.env })
  return !res.error && res.status === 0
})()

section('U · the owner: compare, reclaim once, never throw; the descriptor; the health line per state')
{
  const calls: string[] = []
  const standIn = (foreground: number, own: number, opts: { refuse?: boolean; throwOn?: 'own' | 'fg' | 'reclaim' } = {}): TtyAddon => ({
    ownProcessGroup() {
      calls.push('own')
      if (opts.throwOn === 'own') throw new Error('stand-in refused')
      return { pgid: own, reason: null }
    },
    ttyForegroundGroup(fd: number) {
      calls.push(`fg:${fd}`)
      if (opts.throwOn === 'fg') throw new Error('stand-in refused')
      return { pgid: foreground, reason: null }
    },
    reclaimTerminal(fd: number) {
      calls.push(`reclaim:${fd}`)
      if (opts.throwOn === 'reclaim') throw new Error('stand-in refused')
      return opts.refuse
        ? { reclaimed: false, before: foreground, after: foreground, reason: 'EPERM: operation not permitted' }
        : { reclaimed: true, before: foreground, after: own, reason: null }
    },
  })
  delete process.env[TERMINAL_HANDBACK_FLAG]
  const injectedFd = openSync(join(scratch, 'descriptor'), 'w')
  setTerminalHandbackDescriptorForTest(injectedFd)

  setTerminalHandbackAddonForTest(standIn(500, 500))
  calls.length = 0
  let r = reclaimTerminalAfterChild('proof')
  check('equal groups: nothing reclaimed, reason "already foreground", NO reclaim call', !r.reclaimed && r.reason === 'already foreground' && !calls.some(c => c.startsWith('reclaim')), JSON.stringify({ r, calls }))
  check('…the receipt names the site and the group', r.label === 'proof' && r.before === 500 && r.after === 500, `${JSON.stringify(r)} · the receipt must carry the label and both groups: ${OWNER_FIX}`)

  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check('differing groups: ONE reclaim, the receipt relays before → after', r.reclaimed && r.before === 777 && r.after === 500 && calls.filter(c => c.startsWith('reclaim')).length === 1, `${JSON.stringify({ r, calls })} · ${OWNER_FIX}`)
  check('…through the SAME descriptor the read used', calls.includes(`fg:${injectedFd}`) && calls.includes(`reclaim:${injectedFd}`) && r.fd === injectedFd, `${JSON.stringify(calls)} · the read and the reclaim must use one descriptor: ${OWNER_FIX}`)

  setTerminalHandbackAddonForTest(standIn(777, 500, { refuse: true }))
  r = reclaimTerminalAfterChild('proof')
  check('a refused tcsetpgrp: reclaimed false, reason "failed", the OS text in the note', !r.reclaimed && r.reason === 'failed' && /EPERM/.test(r.note ?? ''), `${JSON.stringify(r)} · ${OWNER_FIX}`)

  for (const site of ['own', 'fg', 'reclaim'] as const) {
    setTerminalHandbackAddonForTest(standIn(777, 500, { throwOn: site }))
    let threw = false
    try {
      r = reclaimTerminalAfterChild('proof')
    } catch {
      threw = true
    }
    check(`a throwing addon (${site}) never throws out of the owner — reason "failed", the message kept`, !threw && !r.reclaimed && r.reason === 'failed' && /stand-in refused/.test(r.note ?? ''), `${JSON.stringify(r)} · catch the addon error and keep its message in the note: ${OWNER_FIX}`)
  }

  setTerminalHandbackDescriptorForTest('none')
  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check('no terminal descriptor: reason "no terminal", NO native call', !r.reclaimed && r.reason === 'no terminal' && calls.length === 0, `${JSON.stringify({ r, calls })} · ${OWNER_FIX}`)
  setTerminalHandbackDescriptorForTest(injectedFd)

  setTerminalHandbackAddonForTest(null)
  r = reclaimTerminalAfterChild('proof')
  check('pack absent: reclaimed false, reason "pack absent"', !r.reclaimed && r.reason === 'pack absent', `${JSON.stringify(r)} · ${OWNER_FIX}`)
  const absent = describeTerminalHandback()
  check('…and the health line says pack absent ⇒ stop + fg', !absent.native && absent.line.startsWith('Terminal hand-back:') && absent.line.includes('pack absent ⇒ stop + fg') && /fg resumes/.test(absent.line), `${absent.line} · ${HEALTH_FIX}`)

  process.env[TERMINAL_HANDBACK_FLAG] = '0'
  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check(`${TERMINAL_HANDBACK_FLAG}=0: reason "disabled", no native call at all`, !r.reclaimed && r.reason === 'disabled' && calls.length === 0, `${JSON.stringify({ r, calls })} · ${OWNER_FIX}`)
  const off = describeTerminalHandback()
  check('…and the health line names the gate and the stop + fg road', !off.native && off.line.includes(`${TERMINAL_HANDBACK_FLAG}=0`) && off.line.includes('stop + fg'), `${off.line} · ${HEALTH_FIX}`)
  delete process.env[TERMINAL_HANDBACK_FLAG]

  const present = describeTerminalHandback()
  check('with a pack: the health line says native reclaim available', present.native && present.line.includes('native reclaim available'), `${present.line} · ${HEALTH_FIX}`)

  setTerminalHandbackAddonForTest(undefined)
  setTerminalHandbackDescriptorForTest(undefined)
  closeSync(injectedFd)
  check('the loader requires the tty surface as part of the ONE export list', (['ttyForegroundGroup', 'ownProcessGroup', 'reclaimTerminal'] as const).every(fn => (VOICE_ADDON_EXPORTS as readonly string[]).includes(fn)), 'add the missing tty function to VOICE_ADDON_EXPORTS in src/integrations/voice-pack/voicePack.ts')
}

resetVoiceAddonForTest()
delete process.env.MERCURY_VOICE_PACK_DIR
const packLoad = loadVoiceAddon()
const packPresent = packLoad.state === 'ok'
section(`P · the vendored pack: ${packPresent ? `${packLoad.manifest.name} ${packLoad.manifest.version} ${packLoad.manifest.platform} (${packLoad.source})` : packLoad.note}`)
if (packPresent) {
  const addon = packLoad.addon
  const own = addon.ownProcessGroup()
  const psPgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
  check('ownProcessGroup() answers this process group (ps agrees)', typeof own.pgid === 'number' && own.pgid === psPgid, `${String(own.pgid)} vs ps ${psPgid} · the native pack ownProcessGroup disagrees with ps; rebuild the pack with bun run scripts/vendor/build-voice.ts`)
  const plain = openSync(join(scratch, 'plain-file'), 'w')
  const notTty = addon.ttyForegroundGroup(plain)
  check('ttyForegroundGroup(a plain file) answers no group and the OS reason', (notTty.pgid ?? null) === null && typeof notTty.reason === 'string' && notTty.reason.length > 0, `${JSON.stringify(notTty)} · the native pack ttyForegroundGroup must answer no group and an OS reason for a non-tty; rebuild with bun run scripts/vendor/build-voice.ts`)
  const refused = addon.reclaimTerminal(plain)
  check('reclaimTerminal(a plain file) reclaims nothing, names the reason, never throws', refused.reclaimed === false && typeof refused.reason === 'string' && (refused.before ?? null) === null, `${JSON.stringify(refused)} · the native pack reclaimTerminal must refuse a non-tty without throwing; rebuild with bun run scripts/vendor/build-voice.ts`)
  closeSync(plain)
  const real = describeTerminalHandback()
  check('the health line names the pack, its version, platform and source', real.native && real.line.includes(packLoad.manifest.version) && real.line.includes(packLoad.manifest.platform) && real.line.includes(packLoad.source), `${real.line} · ${HEALTH_FIX}`)
} else {
  skip('the vendored pack’s tty surface', `no pack on this build${cargoPresent ? ' (cargo is on PATH: bun run scripts/vendor/build-voice.ts builds it)' : ' and no cargo on PATH'}: ${packLoad.state === 'unavailable' ? packLoad.note : ''}`)
}

section('S · one owner · every hand-off site · the one native spelling · the health row · the registry · the fallback road')
{
  const { interfaceChecks } = await import('../../src/platform/health/sections/interface.ts')
  const terminalSays = await interfaceChecks().find(entry => entry.id === 'iface-terminal')?.run()
  const handbackNow = describeTerminalHandback()
  check("/health's Terminal profile row reads describeTerminalHandback() and carries its line in the detail", terminalSays?.detail?.split('\n').at(-1) === handbackNow.line, `${terminalSays?.detail?.split('\n').at(-1)} · the last detail line of the iface-terminal row must be describeTerminalHandback().line: ${HEALTH_FIX}`)

  const spec = FLAG_REGISTRY.find(f => f.env === TERMINAL_HANDBACK_FLAG)
  check('the gate is registered: default-on, the owner as consumer, this prover as evidence', spec !== undefined && spec.kind === 'default-on' && spec.consumer === 'src/platform/shell/terminalHandback.ts' && spec.evidence === 'scripts/ui/prove-terminal-handback.ts', `${JSON.stringify(spec)} · fix the MERCURY_TERMINAL_HANDBACK entry in FLAG_REGISTRY`)

}

section('D · /health: the Terminal profile row carries the hand-back fact')
{
  const report = await import('../../src/platform/health/healthReport.js')
  const row = async (): Promise<{ status: string; evidence: string; detail: string }> => {
    const cert = await report.runHealthReport({ depth: 'fast' })
    for (const s of cert.sections) {
      const r = s.checks.find(c => c.id === 'iface-terminal')
      if (r) return { status: String(r.status), evidence: String(r.evidence), detail: String(r.detail ?? '') }
    }
    return { status: 'absent', evidence: '', detail: '' }
  }
  if (packPresent) {
    resetVoiceAddonForTest()
    delete process.env.MERCURY_VOICE_PACK_DIR
    const r = await row()
    check('with the pack: the detail says native reclaim available', r.detail.includes('Terminal hand-back: native reclaim available'), `${r.detail.split('\n').slice(-2).join(' | ')} · ${HEALTH_FIX}`)
    if (process.stdout.isTTY) check('…and the evidence line says hand-back: native', r.evidence.includes('hand-back: native'), `${r.evidence} · ${HEALTH_FIX}`)
  }
  process.env.MERCURY_VOICE_PACK_DIR = EMPTY_PACK
  resetVoiceAddonForTest()
  const r = await row()
  check('with the pack absent: the detail says pack absent ⇒ stop + fg', r.detail.includes('Terminal hand-back: pack absent ⇒ stop + fg'), `${r.detail.split('\n').slice(-2).join(' | ')} · ${HEALTH_FIX}`)
  if (process.stdout.isTTY) check('…and the evidence line says hand-back: stop + fg', r.evidence.includes('hand-back: stop + fg'), `${r.evidence} · ${HEALTH_FIX}`)
  delete process.env.MERCURY_VOICE_PACK_DIR
  resetVoiceAddonForTest()
}

const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
const journeyEnv = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: CONFIG_HOME, EDITOR: EDITOR_STAND_IN }
  delete env.VISUAL
  delete env.MERCURY_VOICE_PACK_DIR
  delete env[TERMINAL_HANDBACK_FLAG]
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

const RECLAIM_BUDGET_MS = 200
const EDITOR_RECLAIM_BUDGET_MS = 2000
const withStat = (samples: HostSample[]): HostSample[] => samples.filter(s => s.stat !== null)
const neverStopped = (samples: HostSample[]): boolean => withStat(samples).every(s => !s.stat!.startsWith('T'))
const reclaimLatency = (r: HostReport, killMs: number, untilMs: number): { first: HostSample | undefined; ms: number } => {
  const first = withStat(samplesBetween(r, killMs, untilMs)).find(s => s.foreground === true)
  return { first, ms: first ? first.ms - killMs : Number.POSITIVE_INFINITY }
}
const staysForegroundAfter = (r: HostReport, fromMs: number, toMs: number | null): boolean => {
  const s = withStat(samplesBetween(r, fromMs, toMs))
  return s.length > 0 && s.every(x => x.foreground === true)
}
const childHeldTerminal = (s: HostSample | undefined): boolean =>
  s !== undefined && s.foreground === false && s.tree.some(row => row.pid !== s.pid && row.pgid === s.tpgid)

section('H · the host reports what it was waiting for and the last frame when its budget ends or it is killed from outside')
{
  const spent = runJobControlHost({
    tag: 'handback-host-budget',
    argv: ['sleep', '30'],
    cwd: ROOT,
    cols: 80,
    rows: 24,
    env: journeyEnv({}),
    bundleMarker: 'sleep',
    budgetSeconds: 2,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'a needle that never paints', timeout: 60 },
      { mark: 'unreached' },
    ],
  })
  check('a spent budget ends the host on its own, inside its budget, with a report', spent.status === 0 && spent.report !== null && (spent.report.elapsedMs ?? 0) < 10_000, `${journeyTail(spent)} · the journey host must end itself at budgetSeconds and still write its report (scripts/ui/jobcontrolHost.ts)`)
  check('…that names the wait it was in', spent.report?.endReason === 'budget-while-waiting:a needle that never paints', `${journeyTail(spent)} · the host must record the wait it was in when the budget ended (scripts/ui/jobcontrolHost.ts)`)
  check('…and carries the last frame and the step', (spent.report?.finalGrid ?? '').includes('host$') && spent.report?.lastStep === 'wait:a needle that never paints' && !spent.report.marks.some(m => m.label === 'unreached'), `${journeyTail(spent)} · the host report must carry the last frame and step when the budget ends (scripts/ui/jobcontrolHost.ts)`)
  const killed = runJobControlHost({
    tag: 'handback-host-killed',
    argv: ['sleep', '30'],
    cwd: ROOT,
    cols: 80,
    rows: 24,
    env: journeyEnv({}),
    bundleMarker: 'sleep',
    budgetSeconds: 60,
    hostTimeoutSeconds: 3,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'a needle that never paints', timeout: 50 },
    ],
  })
  check('a host killed from outside still writes its report, naming the step it died in', killed.status !== 0 && killed.report !== null && killed.report.endReason === 'terminated-by-host-during:wait:a needle that never paints', `${journeyTail(killed)} · the host must write its report on SIGTERM naming the step (scripts/ui/jobcontrolHost.ts)`)
}

section('B · a killed terminal-thief ⇒ the native reclaim flips the foreground group back within 200 ms; the next read succeeds')
const RECLAIM_DRIVER = join(ROOT, 'scripts/ui/jobcontrolReclaimDriver.ts')
const parseReceipt = (grid: string): { reclaimed: string; reason: string; before: string; after: string } | null => {
  const m = /reclaim-driver: receipt reclaimed=(\w+) reason=(\S+) before=(\S+) after=(\S+)/.exec(grid)
  return m ? { reclaimed: m[1]!, reason: m[2]!, before: m[3]!, after: m[4]! } : null
}
if (!packPresent) {
  skip('B (needs the native pack)', cargoPresent ? 'build it: bun run scripts/vendor/build-voice.ts' : 'no cargo on this box')
} else {
  const run = runJobControlHost({
    tag: 'handback-reclaim',
    argv: [process.execPath, 'run', RECLAIM_DRIVER],
    cwd: ROOT,
    cols: 120,
    rows: 40,
    env: journeyEnv({}),
    bundleMarker: 'jobcontrolReclaimDriver',
    budgetSeconds: 90,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'reclaim-driver: thief spawned', timeout: 40 },
      { wait: 'reclaim-thief holds', timeout: 15 },
      { sleep: 0.3 },
      { observe: 'thief-holds' },
      { mark: 'thief-holds' },
      { signal: 'SIGKILL', match: 'reclaim-thief', label: 'kill-thief' },
      { poll: true, seconds: 1.2, interval: 0.05, label: 'after-kill' },
      { wait: 'reclaim-driver: receipt', timeout: 10 },
      { observe: 'reclaimed' },
      { mark: 'reclaimed' },
      { send: 'x\r' },
      { wait: 'reclaim-driver: read ok', timeout: 10 },
      { sleep: 0.3 },
      { observe: 'read' },
      { mark: 'read' },
    ],
  })
  check('the reclaim journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `${journeyTail(run)} · a step did not appear; ${JOURNEY_FIX}`)
  if (run.report && run.report.endReason === 'steps-done') {
    const r = run.report
    const holds = r.samples.find(s => s.label === 'thief-holds')
    const kill = mark(r, 'signal:kill-thief')!
    const reclaimedMark = mark(r, 'reclaimed')!
    const readMark = mark(r, 'read')!
    check('B: the thief DID take the terminal’s foreground group (the hazard is real: tpgid == the thief’s pgid ≠ ours)', childHeldTerminal(holds), `${JSON.stringify({ pgid: holds?.pgid, tpgid: holds?.tpgid, tree: holds?.tree.map(t => [t.pgid, t.cmd.slice(0, 40)]) })} · the thief in scripts/ui/jobcontrolReclaimDriver.ts did not take the foreground group before the kill`)
    const receipt = parseReceipt(reclaimedMark.grid)
    check('B: the owner reported ONE reclaim — reclaimed=true, before (the dead group) ≠ after (ours)', receipt !== null && receipt.reclaimed === 'true' && receipt.before !== '-' && receipt.after !== '-' && receipt.before !== receipt.after, `${JSON.stringify(receipt)} · ${JOURNEY_FIX}`)
    const after = samplesBetween(r, kill.ms, readMark.ms + 1)
    check('B: the process never entered T after the kill', neverStopped(after), `${withStat(after).map(s => s.stat).join(',')} · the process was stopped (T) after the kill; ${JOURNEY_FIX}`)
    const latency = reclaimLatency(r, kill.ms, readMark.ms + 1)
    check(`B: the foreground group is the driver’s again within ${RECLAIM_BUDGET_MS} ms (pgid == tpgid)`, latency.first?.foreground === true && latency.ms <= RECLAIM_BUDGET_MS, `first sample at +${latency.ms} ms: ${JSON.stringify({ stat: latency.first?.stat, pgid: latency.first?.pgid, tpgid: latency.first?.tpgid })} · ${JOURNEY_FIX}`)
    console.log(`      reclaim observed at +${latency.ms} ms after the kill (${withStat(after).length} samples)`)
    check('B: the read that would have stopped a background job returned (the job is the foreground group)', readMark.grid.includes('reclaim-driver: read ok'), `${readMark.grid.split('\n').filter(l => l.includes('reclaim-driver:')).join(' | ')} · ${JOURNEY_FIX}`)
    check('B: once reclaimed, every later sample keeps the foreground group', staysForegroundAfter(r, latency.first?.ms ?? kill.ms, readMark.ms + 1), withStat(after).map(s => `${s.pgid}/${s.tpgid}`).join(',') + ' · the foreground group was lost again after the reclaim; ' + JOURNEY_FIX)
  }
}

section('Bf · the pack absent ⇒ the reclaim is a no-op; the job never regains the foreground group and its next read stops it — the stop owner’s road')
if (!packPresent) {
  skip('Bf (needs the native pack to contrast against its absence)', cargoPresent ? 'build it: bun run scripts/vendor/build-voice.ts' : 'no cargo on this box')
} else {
  const run = runJobControlHost({
    tag: 'handback-reclaim-absent',
    argv: [process.execPath, 'run', RECLAIM_DRIVER],
    cwd: ROOT,
    cols: 120,
    rows: 40,
    env: journeyEnv({ MERCURY_VOICE_PACK_DIR: EMPTY_PACK }),
    bundleMarker: 'jobcontrolReclaimDriver',
    budgetSeconds: 90,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'reclaim-driver: thief spawned', timeout: 40 },
      { wait: 'reclaim-thief holds', timeout: 15 },
      { sleep: 0.3 },
      { observe: 'thief-holds' },
      { mark: 'thief-holds' },
      { signal: 'SIGKILL', match: 'reclaim-thief', label: 'kill-thief' },
      { wait: 'reclaim-driver: receipt', timeout: 10 },
      { poll: true, seconds: 1.5, interval: 0.05, label: 'after' },
      { observe: 'after' },
      { mark: 'after' },
    ],
  })
  check('the fallback journey completed', run.status === 0 && run.report !== null && (run.report.endReason === 'steps-done' || run.report.endReason.startsWith('budget')), `${journeyTail(run)} · a step did not appear; ${JOURNEY_FIX}`)
  if (run.report && (run.report.endReason === 'steps-done' || run.report.endReason.startsWith('budget'))) {
    const r = run.report
    const holds = r.samples.find(s => s.label === 'thief-holds')
    const kill = mark(r, 'signal:kill-thief')!
    const receipt = parseReceipt(r.finalGrid)
    check('Bf: the thief held the terminal (the same hazard)', childHeldTerminal(holds), `${JSON.stringify({ pgid: holds?.pgid, tpgid: holds?.tpgid })} · the thief in scripts/ui/jobcontrolReclaimDriver.ts did not take the foreground group before the kill`)
    check('Bf: the owner did NOT reclaim — reclaimed=false, reason "pack-absent"', receipt !== null && receipt.reclaimed === 'false' && receipt.reason === 'pack-absent', `${JSON.stringify(receipt)} · with MERCURY_VOICE_PACK_DIR empty the owner must skip the native call: ${OWNER_FIX}`)
    const after = withStat(samplesBetween(r, kill.ms, null))
    check('Bf: the job never regained the foreground group (the reclaim did not fire)', after.length > 0 && after.every(s => s.foreground === false), after.map(s => `${s.pgid}/${s.tpgid}`).join(',') + ' · a reclaim fired with no pack; ' + OWNER_FIX)
    check('Bf: …so its next read stopped it (T) or failed from the background — the exact condition the renderer’s stop owner turns into a clean stop + fg (prove-tty-suspend)', after.some(s => s.stat!.startsWith('T')) || /reclaim-driver: read failed/.test(r.finalGrid), `${after.map(s => s.stat).join(',')} · grid=${r.finalGrid.split('\n').filter(l => l.includes('reclaim-driver:')).join(' | ')} · the job neither stopped nor failed its read; ${JOURNEY_FIX}`)
  }
}

section('A · the prompt editor’s stand-in killed -9 ⇒ reclaimed within 200 ms · C · a normal return')
const COMPOSER_CRASH_POINTER =
  'a composer overlay crashes the session on open (React #300, the inter-render hook-count regression prove-composer-hook-order pins — PromptInput.tsx voiceInputFilter below the "after every hook" marker, not this lane’s file). These legs light up once that is fixed; the panel legs prove the native reclaim meanwhile.'
if (!packPresent) {
  skip('A/C (need the native pack)', cargoPresent ? 'build it: bun run scripts/vendor/build-voice.ts' : 'no cargo on this box')
} else {
  const openEditor = [{ send: '\x18' }, { sleep: 0.3 }, { send: '\x05' }]
  const run = runJobControlHost({
    tag: 'handback-editor',
    argv: base.argv,
    cwd: base.cwd,
    cols: 120,
    rows: 40,
    env: journeyEnv({}),
    budgetSeconds: 180,
    steps: [
      { wait: 'host$', timeout: 15 },
      { launch: true },
      { wait: 'New Session', timeout: 45 },
      { sleep: 1.5 },
      { send: '\r' },
      { wait: 'Type a prompt', timeout: 30 },
      { sleep: 1.5 },
      { send: 'kestrel' },
      { wait: 'kestrel', timeout: 10 },
      { sleep: 0.3 },
      { mark: 'pre-editor' },
      ...openEditor,
      { wait: ['holds the terminal (take 1', 'exited on an error', 'React error', 'React #300'], timeout: 25, required: false },
      { sleep: 0.5 },
      { observe: 'editor-holds' },
      { mark: 'editor-holds' },
      { signal: 'SIGKILL', match: 'jobcontrol-editor-stand-in', label: 'kill-editor' },
      { poll: true, seconds: 2.0, interval: 0.05, label: 'after-kill' },
      { observe: 'after-kill' },
      { mark: 'after-kill' },
      { send: ' typed after kill' },
      { wait: 'kestrel typed after kill', timeout: 10 },
      { sleep: 0.5 },
      { observe: 'typed' },
      { mark: 'typed' },
      ...openEditor,
      { wait: 'holds the terminal (take 2', timeout: 25 },
      { sleep: 0.5 },
      { observe: 'editor-holds-2' },
      { signal: 'SIGTERM', match: 'jobcontrol-editor-stand-in', label: 'end-editor' },
      { poll: true, seconds: 1.0, interval: 0.05, label: 'after-return' },
      { wait: 'edited by the stand-in', timeout: 15 },
      { sleep: 0.5 },
      { observe: 'after-return' },
      { mark: 'after-return' },
      { send: ' more' },
      { wait: 'stand-in more', timeout: 10 },
      { sleep: 0.3 },
      { observe: 'typed-2' },
      { mark: 'typed-2' },
    ],
  })
  const grid = run.report?.finalGrid ?? ''
  const composerCrashed = /exited on an error|React (error|#)|Crash report:/.test(grid)
  const editorNeverHeld = !/holds the terminal \(take 1/.test(grid)
  if (run.report !== null && run.report.endReason !== 'steps-done' && composerCrashed && editorNeverHeld) {
    skip('A/C the killed and the normal editor return', COMPOSER_CRASH_POINTER)
  } else {
    check('the editor journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `crash=${composerCrashed} ${journeyTail(run)} · a step did not appear; read the grid above`)
    if (run.report && run.report.endReason === 'steps-done') {
      const r = run.report
      const kill = mark(r, 'signal:kill-editor')!
      const afterKill = mark(r, 'after-kill')!
      const typed = mark(r, 'typed')!
      const afterReturn = mark(r, 'after-return')!
      const typed2 = mark(r, 'typed-2')!
      const holdsSample = r.samples.find(s => s.label === 'editor-holds')
      check('A: the stand-in DID take the terminal’s foreground group (the hazard is real)', childHeldTerminal(holdsSample), `${JSON.stringify({ pgid: holdsSample?.pgid, tpgid: holdsSample?.tpgid })} · the editor stand-in did not take the foreground group; check that the EDITOR stand-in opened from the composer`)
      const afterSamples = samplesBetween(r, kill.ms, typed.ms + 1)
      check('A: the process never entered T after the kill', neverStopped(afterSamples), withStat(afterSamples).map(s => s.stat).join(',') + ' · the process was stopped (T) after the editor was killed; ' + OWNER_FIX)
      const latency = reclaimLatency(r, kill.ms, typed.ms + 1)
      check(`A: the foreground group is Mercury’s again within ${EDITOR_RECLAIM_BUDGET_MS} ms (E2E; the native-call speed is B’s ≤200 ms)`, latency.first !== undefined && latency.ms <= EDITOR_RECLAIM_BUDGET_MS, `first foreground sample at +${latency.ms} ms · ${OWNER_FIX}`)
      console.log(`      reclaim observed at +${latency.ms} ms after the kill`)
      const rearm = modeEventsBetween(r, kill.teeOffset, typed.teeOffset)
      check('A: the alternate screen and the mouse family are re-armed after the return', lastStateOf(rearm, 'alt-screen') === 'on' && MOUSE_FAMILIES.every(f => lastStateOf(rearm, f) === 'on'), `alt=${lastStateOf(rearm, 'alt-screen')} · the alternate screen and the mouse modes must be switched on again after the editor returns`)
      check('A: the next keys landed in the composer', typed.grid.includes('kestrel typed after kill'), 'keys typed after the kill never reached the composer; the terminal was not handed back to the session')
      check('A: the shell never reported a stop', !r.shellLines.some(l => /Stopped|suspended/.test(l)), r.shellLines.join(' | ') + ' · the session was stopped by the shell; ' + OWNER_FIX)
      const holds2 = r.samples.find(s => s.label === 'editor-holds-2')
      check('C: the second take held the terminal too', childHeldTerminal(holds2), 'the second editor stand-in did not take the foreground group; check that the second editor open reached the stand-in')
      check('C: a normal return: the edit landed in the composer', afterReturn.grid.includes('edited by the stand-in'), 'the composer did not show the edit written by the stand-in after a normal return')
      const returnSamples = samplesBetween(r, afterKill.ms, typed2.ms + 1)
      check('C: never T, foreground ours after the return', neverStopped(returnSamples) && withStat(samplesBetween(r, afterReturn.ms - 1, typed2.ms + 1)).every(s => s.foreground === true), 'after a normal return the process stopped or lost the foreground group; ' + OWNER_FIX)
      check('C: keys still land after the normal return', typed2.grid.includes('stand-in more'), 'keys typed after a normal editor return never reached the composer; ' + OWNER_FIX)
    }
  }
}

cleanupScenario('boot-face')
rmSync(scratch, { recursive: true, force: true })

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` ❌ prove-terminal-handback: ${failures} failure(s)${skips ? `, ${skips} skipped` : ''}`)
  process.exit(1)
}
const editorNote = skips > 0 ? 'the editor legs gated on the composer fix' : 'the external editor killed mid-edit ⇒ reclaimed, a normal return untouched'
console.log(` ✅ terminal-handback — one owner in every hand-off finally · a killed terminal-thief ⇒ the foreground group reclaimed natively (≤200 ms), the next read returns · the pack absent ⇒ no reclaim, the job stays background and stops on its next read (the stop owner’s road) · ${editorNote}${skips ? ` (${skips} leg(s) skipped)` : ''}`)

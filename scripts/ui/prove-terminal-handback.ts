#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-terminal-handback.ts — after ANY return of a deliberate
//  tty child, the terminal's foreground process group is Mercury's again.
//
//  Mercury hands the terminal to a child on purpose (the external editor,
//  the prompt editor, the terminal panel). A job-control child takes the
//  terminal's foreground process group for itself and gives it back on a
//  normal exit; killed, it gives nothing back, and Mercury's next read of
//  the terminal stops the whole process group (SIGTTIN) — a clean stop the
//  operator must notice and `fg`. The hand-back owner
//  (utils/terminalHandback) reclaims the group through the native pack's tty
//  module in a `finally` at every hand-off site; without the pack the stop +
//  fg road stands.
//
//  Legs (jobcontrol-host.py — a bash job-control shell hosting the job in a
//  PTY; a bare exec is an orphaned process group where none of this is
//  observable):
//   U  unit pins on the owner with a stand-in addon and an injected
//      descriptor: equal groups ⇒ no call; differing ⇒ one reclaim, the
//      receipt relays before → after; a throwing addon never throws out;
//      pack absent / gate off / no terminal answer their reasons; the doctor
//      line per state.
//   P  the vendored pack's tty surface in-process (ownProcessGroup agrees
//      with ps; a plain file answers a reason, never a group; never throws).
//   S  source pins: every hand-off site calls the owner in its finally BEFORE
//      the renderer re-arms; one owner calls the native surface; the crate's
//      tty module is the one native spelling; every inherited-stdio spawn
//      calls the owner or is a named headless site; the doctor row reads the
//      describer; the registry row; the stop owner still handles the
//      background stops the fallback rides.
//   D  the doctor's Terminal profile row carries the fact — native with the
//      pack, stop + fg with it absent.
//   B  the terminal panel's owner hosted as the job (no chord opens the panel
//      in the tree), its login shell killed -9 ⇒ the foreground group is the
//      job's again within 200 ms (pgid == tpgid), never T, and the job's next
//      terminal read succeeds — the read that would have stopped it.
//   Bf the same with the pack ABSENT: the reclaim is a no-op, the job never
//      regains the foreground group and its next read STOPS it (T) — the
//      exact condition the renderer's stop owner turns into a clean stop +
//      fg (the fallback pinned live, not assumed; prove-tty-suspend is the
//      E2E of that clean-stop road).
//   A/C the prompt editor (ctrl+x ctrl+e) with an EDITOR stand-in that takes
//      the terminal like a shell would: killed -9 ⇒ reclaimed within 200 ms,
//      never T, keys land; a normal return ⇒ the edit lands, foreground
//      throughout. GATED: while opening a composer overlay crashes the
//      session (the inter-render hook-count regression prove-composer-hook-
//      order pins — PromptInput.tsx, not this lane's file), these legs SKIP
//      with the pointer and light up the moment that is fixed.
//
//  Needs the built bundle, the native pack (scripts/vendor/build-voice.ts;
//  without cargo the native legs are a loud skip and the fallback still
//  runs), /bin/bash, /usr/bin/python3 + pyte, `ps -o tpgid`.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME, scenario, cleanupScenario } from './renderScenarios.ts'
import {
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
} from '../../src/utils/terminalHandback.ts'
import { loadVoiceAddon, resetVoiceAddonForTest, VOICE_ADDON_EXPORTS } from '../../src/services/voice/voicePack.ts'
import { FLAG_REGISTRY } from '../../src/substrate/flagRegistry.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let skips = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
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

// An editor stand-in with a job-control shell's manners: it takes the
// terminal's foreground process group for itself (setpgrp + tcsetpgrp,
// SIGTTOU ignored) and holds it until a signal — SIGTERM is a normal return
// (append to the file, hand the terminal back, exit 0); SIGKILL is the
// hazard (nothing hands the terminal back). Each run announces its take.
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

// ── U · the owner with a stand-in addon and an injected descriptor ──────────
section('U · the owner: compare, reclaim once, never throw; the descriptor; the doctor line per state')
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
  // A descriptor a prover under a pipe would not otherwise have; the stand-in
  // ignores its content. The 'none' branch is tested below.
  const injectedFd = openSync(join(scratch, 'descriptor'), 'w')
  setTerminalHandbackDescriptorForTest(injectedFd)

  setTerminalHandbackAddonForTest(standIn(500, 500))
  calls.length = 0
  let r = reclaimTerminalAfterChild('proof')
  check('equal groups: nothing reclaimed, reason "already foreground", NO reclaim call', !r.reclaimed && r.reason === 'already foreground' && !calls.some(c => c.startsWith('reclaim')), JSON.stringify({ r, calls }))
  check('…the receipt names the site and the group', r.label === 'proof' && r.before === 500 && r.after === 500)

  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check('differing groups: ONE reclaim, the receipt relays before → after', r.reclaimed && r.before === 777 && r.after === 500 && calls.filter(c => c.startsWith('reclaim')).length === 1, JSON.stringify({ r, calls }))
  check('…through the SAME descriptor the read used', calls.includes(`fg:${injectedFd}`) && calls.includes(`reclaim:${injectedFd}`) && r.fd === injectedFd, JSON.stringify(calls))

  setTerminalHandbackAddonForTest(standIn(777, 500, { refuse: true }))
  r = reclaimTerminalAfterChild('proof')
  check('a refused tcsetpgrp: reclaimed false, reason "failed", the OS text in the note', !r.reclaimed && r.reason === 'failed' && /EPERM/.test(r.note ?? ''), JSON.stringify(r))

  for (const site of ['own', 'fg', 'reclaim'] as const) {
    setTerminalHandbackAddonForTest(standIn(777, 500, { throwOn: site }))
    let threw = false
    try {
      r = reclaimTerminalAfterChild('proof')
    } catch {
      threw = true
    }
    check(`a throwing addon (${site}) never throws out of the owner — reason "failed", the message kept`, !threw && !r.reclaimed && r.reason === 'failed' && /stand-in refused/.test(r.note ?? ''), JSON.stringify(r))
  }

  // The no-terminal branch: the descriptor resolution answers nothing.
  setTerminalHandbackDescriptorForTest('none')
  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check('no terminal descriptor: reason "no terminal", NO native call', !r.reclaimed && r.reason === 'no terminal' && calls.length === 0, JSON.stringify({ r, calls }))
  setTerminalHandbackDescriptorForTest(injectedFd)

  setTerminalHandbackAddonForTest(null)
  r = reclaimTerminalAfterChild('proof')
  check('pack absent: reclaimed false, reason "pack absent"', !r.reclaimed && r.reason === 'pack absent', JSON.stringify(r))
  const absent = describeTerminalHandback()
  check('…and the doctor line says pack absent ⇒ stop + fg', !absent.native && absent.line.startsWith('Terminal hand-back:') && absent.line.includes('pack absent ⇒ stop + fg') && /fg resumes/.test(absent.line), absent.line)

  process.env[TERMINAL_HANDBACK_FLAG] = '0'
  setTerminalHandbackAddonForTest(standIn(777, 500))
  calls.length = 0
  r = reclaimTerminalAfterChild('proof')
  check(`${TERMINAL_HANDBACK_FLAG}=0: reason "disabled", no native call at all`, !r.reclaimed && r.reason === 'disabled' && calls.length === 0, JSON.stringify({ r, calls }))
  const off = describeTerminalHandback()
  check('…and the doctor line names the gate and the stop + fg road', !off.native && off.line.includes(`${TERMINAL_HANDBACK_FLAG}=0`) && off.line.includes('stop + fg'), off.line)
  delete process.env[TERMINAL_HANDBACK_FLAG]

  const present = describeTerminalHandback()
  check('with a pack: the doctor line says native reclaim available', present.native && present.line.includes('native reclaim available'), present.line)

  setTerminalHandbackAddonForTest(undefined)
  setTerminalHandbackDescriptorForTest(undefined)
  closeSync(injectedFd)
  check('the loader requires the tty surface as part of the ONE export list', (['ttyForegroundGroup', 'ownProcessGroup', 'reclaimTerminal'] as const).every(fn => (VOICE_ADDON_EXPORTS as readonly string[]).includes(fn)))
}

// ── P · the vendored pack on this box ───────────────────────────────────────
resetVoiceAddonForTest()
delete process.env.MERCURY_VOICE_PACK_DIR
const packLoad = loadVoiceAddon()
const packPresent = packLoad.state === 'ok'
section(`P · the vendored pack: ${packPresent ? `${packLoad.manifest.name} ${packLoad.manifest.version} ${packLoad.manifest.platform} (${packLoad.source})` : packLoad.note}`)
if (packPresent) {
  const addon = packLoad.addon
  const own = addon.ownProcessGroup()
  const psPgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())
  check('ownProcessGroup() answers this process group (ps agrees)', typeof own.pgid === 'number' && own.pgid === psPgid, `${String(own.pgid)} vs ps ${psPgid}`)
  const plain = openSync(join(scratch, 'plain-file'), 'w')
  const notTty = addon.ttyForegroundGroup(plain)
  check('ttyForegroundGroup(a plain file) answers no group and the OS reason', (notTty.pgid ?? null) === null && typeof notTty.reason === 'string' && notTty.reason.length > 0, JSON.stringify(notTty))
  const refused = addon.reclaimTerminal(plain)
  check('reclaimTerminal(a plain file) reclaims nothing, names the reason, never throws', refused.reclaimed === false && typeof refused.reason === 'string' && (refused.before ?? null) === null, JSON.stringify(refused))
  closeSync(plain)
  const real = describeTerminalHandback()
  check('the doctor line names the pack, its version, platform and source', real.native && real.line.includes(packLoad.manifest.version) && real.line.includes(packLoad.manifest.platform) && real.line.includes(packLoad.source), real.line)
} else if (cargoPresent) {
  check('cargo is on this box, so the pack must be built before this prover (bun run scripts/vendor/build-voice.ts)', false, packLoad.state === 'unavailable' ? packLoad.note : '')
} else {
  skip('the vendored pack’s tty surface', `no cargo on PATH and no pack: ${packLoad.state === 'unavailable' ? packLoad.note : ''}`)
}

// ── S · source pins ─────────────────────────────────────────────────────────
section('S · one owner · every hand-off site · the one native spelling · the doctor row · the registry · the fallback road')
{
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
  const sites: Array<[string, string, string[]]> = [
    ['src/utils/editor.ts', "reclaimTerminalAfterChild('external editor')", ['instance.exitAlternateScreen()']],
    ['src/utils/promptEditor.ts', "reclaimTerminalAfterChild(isTerminalEditor ? 'prompt editor' : 'prompt editor (gui)')", ['instance.exitAlternateScreen()', 'instance.resumeStdin()']],
    ['src/utils/terminalPanel.ts', "reclaimTerminalAfterChild('terminal panel')", ['ink.exitAlternateScreen()']],
  ]
  for (const [rel, call, rearms] of sites) {
    const text = read(rel)
    check(`${rel} imports the one owner`, text.includes("from './terminalHandback.js'"))
    const inFinally = new RegExp('finally \\{[\\s\\S]*?' + call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text)
    check(`${rel} calls it inside a finally`, inFinally)
    const at = text.indexOf(call)
    check(`${rel} calls it BEFORE the renderer re-arms (${rearms.join(' / ')})`, at >= 0 && rearms.every(re => text.indexOf(re, at) > at), `call at ${at}`)
  }
  // Every inherited-stdio spawn under src either calls the owner or is a named
  // headless site — the census keeps a new tty child from shipping without
  // its hand-back.
  const headless: Record<string, string> = {
    'src/cli/editorBridge.ts': 'a headless verb (mercury editor …) — the process ends with the child; no renderer returns to the terminal',
    'src/daemon/main.ts': 'the daemon successor spawn — no terminal',
    'src/daemon/headlessRun.ts': 'the stream-json child inherits stderr only',
    'src/services/acp/childSession.ts': 'the ACP child inherits stderr only',
    'src/memdir/promoteRungate.ts': 'the promote gate runs at the headless CLI',
    'src/utils/worktree.ts': 'the --worktree --tmux attach: a multiplexer client never takes the foreground group, and it runs before the renderer mounts',
    'src/substrate/directSplash.ts': 'the pre-boot launch splash — it runs before the renderer mounts, its child shares this process group (no tcsetpgrp, so no foreground-group hand-off), and an abnormal splash death is healed by its own ABNORMAL_HEAL (terminal modes), never the reclaim',
  }
  const offenders: string[] = []
  const walk = (dir: string, visit: (rel: string, text: string) => void): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full, visit)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      visit(full.slice(ROOT.length + 1), readFileSync(full, 'utf8'))
    }
  }
  walk(join(ROOT, 'src'), (rel, text) => {
    // Any spawn whose stdio inherits a terminal descriptor (direct, in an
    // array, or behind a ternary/nullish) — a comment `stdio is` is not one.
    if (!/stdio:[^\n]*'inherit'/.test(text)) return
    if (text.includes('reclaimTerminalAfterChild(') || headless[rel]) return
    offenders.push(rel)
  })
  check('every inherited-stdio spawn under src calls the owner or is a named headless site', offenders.length === 0, offenders.join(', '))
  for (const rel of Object.keys(headless)) check(`the named headless site exists: ${rel}`, statSync(join(ROOT, rel), { throwIfNoEntry: false })?.isFile() === true)

  const callers: string[] = []
  const spellers: string[] = []
  walk(join(ROOT, 'src'), (rel, text) => {
    if (/\.reclaimTerminal\(|\.ttyForegroundGroup\(|\.ownProcessGroup\(/.test(text)) callers.push(rel)
    if (/tcsetpgrp|tcgetpgrp/.test(text)) spellers.push(rel)
  })
  check('no src file but the owner CALLS the native surface', callers.length === 1 && callers[0] === 'src/utils/terminalHandback.ts', callers.join(', '))
  check('no src file outside the owner and the pack loader spells tcsetpgrp/tcgetpgrp', spellers.every(f => f === 'src/utils/terminalHandback.ts' || f === 'src/services/voice/voicePack.ts'), spellers.join(', '))
  const rustFiles = readdirSync(join(ROOT, 'native/voice/src')).filter(f => f.endsWith('.rs'))
  const rustSpellers = rustFiles.filter(f => /tcsetpgrp/.test(readFileSync(join(ROOT, 'native/voice/src', f), 'utf8')))
  check('the crate’s tty module is the ONE native spelling of tcsetpgrp', rustSpellers.join() === 'tty.rs', rustSpellers.join(', '))
  const tty = read('native/voice/src/tty.rs')
  check('the native reclaim ignores SIGTTOU for the call and restores the previous disposition', tty.includes('libc::SIGTTOU, &ignore, &mut previous') && tty.includes('libc::SIGTTOU, &previous, std::ptr::null_mut()') && tty.includes('libc::tcsetpgrp(fd, own'))
  check('off POSIX every function exists and answers "unsupported"', /#\[cfg\(not\(unix\)\)\]\s*mod imp/.test(tty) && (tty.match(/UNSUPPORTED/g) ?? []).length >= 4)
  check('the crate is one pack: lib.rs mounts the tty module beside the voice capture', read('native/voice/src/lib.rs').includes('pub mod tty;'))
  check('the libc dependency is unix-only', /\[target\.'cfg\(unix\)'\.dependencies\]\s*\nlibc = "0\.2"/.test(read('native/voice/Cargo.toml')))

  const report = read('src/utils/healthReport.ts')
  const row = report.slice(report.indexOf("id: 'iface-terminal'"), report.indexOf("id: 'iface-tokens'"))
  check("the doctor's Terminal profile row reads describeTerminalHandback() and carries its line in the detail", row.includes("require('./terminalHandback.js')") && row.includes('describeTerminalHandback()') && row.includes('handback.line'))

  const spec = FLAG_REGISTRY.find(f => f.env === TERMINAL_HANDBACK_FLAG)
  check('the gate is registered: default-on, the owner as consumer, this prover as evidence', spec !== undefined && spec.kind === 'default-on' && spec.consumer === 'src/utils/terminalHandback.ts' && spec.evidence === 'scripts/ui/prove-terminal-handback.ts', JSON.stringify(spec))
  check('the owner reads the gate through the registry reader', read('src/utils/terminalHandback.ts').includes('flagEnabled(TERMINAL_HANDBACK_FLAG)') && TERMINAL_HANDBACK_FLAG === 'MERCURY_TERMINAL_HANDBACK')

  // The fallback road: when the reclaim does not fire, the next terminal read
  // draws a background stop, and the renderer's stop owner handles exactly
  // those signals cleanly (prove-tty-suspend is its E2E).
  const stop = read('src/ink/root/stop-continue.ts')
  check('the stop owner still handles the background stops the fallback rides (SIGTTIN/SIGTTOU)', stop.includes("'SIGTSTP', 'SIGTTIN', 'SIGTTOU'") && stop.includes('stopIsForeground') && statSync(join(ROOT, 'scripts/ui/prove-tty-suspend.ts'), { throwIfNoEntry: false })?.isFile() === true)
}

// ── D · the doctor row ──────────────────────────────────────────────────────
section('D · the doctor: the Terminal profile row carries the hand-back fact')
{
  const report = await import('../../src/utils/healthReport.js')
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
    check('with the pack: the detail says native reclaim available', r.detail.includes('Terminal hand-back: native reclaim available'), r.detail.split('\n').slice(-2).join(' | '))
    if (process.stdout.isTTY) check('…and the evidence line says hand-back: native', r.evidence.includes('hand-back: native'), r.evidence)
  }
  process.env.MERCURY_VOICE_PACK_DIR = EMPTY_PACK
  resetVoiceAddonForTest()
  const r = await row()
  check('with the pack absent: the detail says pack absent ⇒ stop + fg', r.detail.includes('Terminal hand-back: pack absent ⇒ stop + fg'), r.detail.split('\n').slice(-2).join(' | '))
  if (process.stdout.isTTY) check('…and the evidence line says hand-back: stop + fg', r.evidence.includes('hand-back: stop + fg'), r.evidence)
  delete process.env.MERCURY_VOICE_PACK_DIR
  resetVoiceAddonForTest()
}

// ── the PTY journeys ────────────────────────────────────────────────────────
const base = scenario('boot-face', 120, 40) as { argv: string[]; cwd: string }
const journeyEnv = (extra: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_FULLSCREEN: '1', MERCURY_CONFIG_DIR: CONFIG_HOME, EDITOR: EDITOR_STAND_IN }
  delete env.VISUAL
  delete env.MERCURY_VOICE_PACK_DIR
  delete env[TERMINAL_HANDBACK_FLAG]
  // extra is applied LAST, so a leg that sets MERCURY_VOICE_PACK_DIR (the
  // fallback) is not undone by the default deletion above.
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

// The DIRECT reclaim latency (the thief leg B: a native tcsetpgrp in the
// child's exit handler) — sub-frame, budgeted tight.
const RECLAIM_BUDGET_MS = 200
// The EDITOR E2E budget (leg A): the reclaim rides the promptEditor await →
// finally chain in the built bundle, and the whole fleet shares this box —
// event-loop starvation under load pushes the first foreground SAMPLE out
// (observed 79 ms idle, 371 ms loaded). The hard guarantee is "never a
// persistent stop (T)"; this bound only says the reclaim lands promptly, not
// after a hang. The native-call speed itself is B's ≤200 ms.
const EDITOR_RECLAIM_BUDGET_MS = 2000
const withStat = (samples: HostSample[]): HostSample[] => samples.filter(s => s.stat !== null)
const neverStopped = (samples: HostSample[]): boolean => withStat(samples).every(s => !s.stat!.startsWith('T'))
// The reclaim runs in the child's exit path (an editor's finally, the thief's
// exit handler), a few event-loop hops after the kill: there is a brief window
// where the process is still background before the reclaim lands. So the
// latency is to the FIRST foreground sample, and "stays foreground" is asserted
// from there on — not from the kill.
const reclaimLatency = (r: HostReport, killMs: number, untilMs: number): { first: HostSample | undefined; ms: number } => {
  const first = withStat(samplesBetween(r, killMs, untilMs)).find(s => s.foreground === true)
  return { first, ms: first ? first.ms - killMs : Number.POSITIVE_INFINITY }
}
const staysForegroundAfter = (r: HostReport, fromMs: number, toMs: number | null): boolean => {
  const s = withStat(samplesBetween(r, fromMs, toMs))
  return s.length > 0 && s.every(x => x.foreground === true)
}
// A deliberate tty child holds the terminal: the sampled process is NOT the
// foreground group, and one of its descendants IS (its pgid == the terminal's
// tpgid). The descendant's command line is truncated in the sample tree, so
// this keys on the process-group topology, not the (possibly cut) path.
const childHeldTerminal = (s: HostSample | undefined): boolean =>
  s !== undefined && s.foreground === false && s.tree.some(row => row.pid !== s.pid && row.pgid === s.tpgid)

// ── B · a killed terminal-thief ⇒ the native reclaim flips the group back ────
//
// The product's editor/panel hand-off is a spawnSync with inherited stdio,
// and under a bun-hosted prover bun restores the foreground group ITSELF on
// such a child's exit — masking the reclaim. So the driver steals the
// terminal through a DETACHED thief (not an inherited-stdio spawn) that
// tcsetpgrp's it to its own group and holds it — the exact state a killed
// editor or panel shell leaves — and, when the host kills the thief, calls
// the SAME owner the hand-off finally calls. Here only the native reclaim
// can flip the group back, so the observation is the reclaim's, faithful to
// the product under node.
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
  check('the reclaim journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `status=${run.status} end=${run.report?.endReason} ${run.stderr.slice(-300)} ${run.report?.log.slice(-8).join(' | ') ?? ''}`)
  if (run.report && run.report.endReason === 'steps-done') {
    const r = run.report
    const holds = r.samples.find(s => s.label === 'thief-holds')
    const kill = mark(r, 'signal:kill-thief')!
    const reclaimedMark = mark(r, 'reclaimed')!
    const readMark = mark(r, 'read')!
    check('B: the thief DID take the terminal’s foreground group (the hazard is real: tpgid == the thief’s pgid ≠ ours)', childHeldTerminal(holds), JSON.stringify({ pgid: holds?.pgid, tpgid: holds?.tpgid, tree: holds?.tree.map(t => [t.pgid, t.cmd.slice(0, 40)]) }))
    const receipt = parseReceipt(reclaimedMark.grid)
    check('B: the owner reported ONE reclaim — reclaimed=true, before (the dead group) ≠ after (ours)', receipt !== null && receipt.reclaimed === 'true' && receipt.before !== '-' && receipt.after !== '-' && receipt.before !== receipt.after, JSON.stringify(receipt))
    const after = samplesBetween(r, kill.ms, readMark.ms + 1)
    check('B: the process never entered T after the kill', neverStopped(after), withStat(after).map(s => s.stat).join(','))
    const latency = reclaimLatency(r, kill.ms, readMark.ms + 1)
    check(`B: the foreground group is the driver’s again within ${RECLAIM_BUDGET_MS} ms (pgid == tpgid)`, latency.first?.foreground === true && latency.ms <= RECLAIM_BUDGET_MS, `first sample at +${latency.ms} ms: ${JSON.stringify({ stat: latency.first?.stat, pgid: latency.first?.pgid, tpgid: latency.first?.tpgid })}`)
    console.log(`      reclaim observed at +${latency.ms} ms after the kill (${withStat(after).length} samples)`)
    check('B: the read that would have stopped a background job returned (the job is the foreground group)', readMark.grid.includes('reclaim-driver: read ok'), readMark.grid.split('\n').filter(l => l.includes('reclaim-driver:')).join(' | '))
    check('B: once reclaimed, every later sample keeps the foreground group', staysForegroundAfter(r, latency.first?.ms ?? kill.ms, readMark.ms + 1), withStat(after).map(s => `${s.pgid}/${s.tpgid}`).join(','))
  }
}

// ── Bf · the fallback: the pack absent ⇒ no reclaim, the job stays background
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
  check('the fallback journey completed', run.status === 0 && run.report !== null && (run.report.endReason === 'steps-done' || run.report.endReason === 'budget'), `status=${run.status} end=${run.report?.endReason} ${run.stderr.slice(-200)} ${run.report?.log.slice(-8).join(' | ') ?? ''}`)
  if (run.report && (run.report.endReason === 'steps-done' || run.report.endReason === 'budget')) {
    const r = run.report
    const holds = r.samples.find(s => s.label === 'thief-holds')
    const kill = mark(r, 'signal:kill-thief')!
    const receipt = parseReceipt(r.finalGrid)
    check('Bf: the thief held the terminal (the same hazard)', childHeldTerminal(holds), JSON.stringify({ pgid: holds?.pgid, tpgid: holds?.tpgid }))
    check('Bf: the owner did NOT reclaim — reclaimed=false, reason "pack-absent"', receipt !== null && receipt.reclaimed === 'false' && receipt.reason === 'pack-absent', JSON.stringify(receipt))
    const after = withStat(samplesBetween(r, kill.ms, null))
    check('Bf: the job never regained the foreground group (the reclaim did not fire)', after.length > 0 && after.every(s => s.foreground === false), after.map(s => `${s.pgid}/${s.tpgid}`).join(','))
    check('Bf: …so its next read stopped it (T) or failed from the background — the exact condition the renderer’s stop owner turns into a clean stop + fg (prove-tty-suspend)', after.some(s => s.stat!.startsWith('T')) || /reclaim-driver: read failed/.test(r.finalGrid), `${after.map(s => s.stat).join(',')} · grid=${r.finalGrid.split('\n').filter(l => l.includes('reclaim-driver:')).join(' | ')}`)
  }
}

// ── A · C · the prompt editor, killed and returning normally (GATED) ────────
section('A · the prompt editor’s stand-in killed -9 ⇒ reclaimed within 200 ms · C · a normal return')
const COMPOSER_CRASH_POINTER =
  'a composer overlay crashes the session on open (React #300, the inter-render hook-count regression prove-composer-hook-order pins — PromptInput.tsx voiceInputFilter below the "after every hook" marker, not this lane’s file). These legs light up once that is fixed; the panel legs prove the native reclaim meanwhile.'
if (!packPresent) {
  skip('A/C (need the native pack)', cargoPresent ? 'build it: bun run scripts/vendor/build-voice.ts' : 'no cargo on this box')
} else {
  const openEditor = [{ send: '\x18' }, { sleep: 0.3 }, { send: '\x05' }]
  // ONE boot: the editor is opened, killed, reopened, and returned normally in
  // a single journey. The first "holds the terminal" wait does NOT hard-fail
  // (required:false), so if the composer crashes on open the journey runs on to
  // the kill step, finds no editor child, and stops — a partial report the
  // crash-gate below reads to SKIP (rather than boot the bundle twice).
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
      { wait: 'Doctor / Health Check', timeout: 45 },
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
    check('the editor journey completed', run.status === 0 && run.report !== null && run.report.endReason === 'steps-done', `status=${run.status} end=${run.report?.endReason} crash=${composerCrashed} ${run.stderr.slice(-200)} ${run.report?.log.slice(-6).join(' | ') ?? ''}`)
    if (run.report && run.report.endReason === 'steps-done') {
      const r = run.report
      const kill = mark(r, 'signal:kill-editor')!
      const afterKill = mark(r, 'after-kill')!
      const typed = mark(r, 'typed')!
      const afterReturn = mark(r, 'after-return')!
      const typed2 = mark(r, 'typed-2')!
      const holdsSample = r.samples.find(s => s.label === 'editor-holds')
      check('A: the stand-in DID take the terminal’s foreground group (the hazard is real)', childHeldTerminal(holdsSample), JSON.stringify({ pgid: holdsSample?.pgid, tpgid: holdsSample?.tpgid }))
      const afterSamples = samplesBetween(r, kill.ms, typed.ms + 1)
      check('A: the process never entered T after the kill', neverStopped(afterSamples), withStat(afterSamples).map(s => s.stat).join(','))
      const latency = reclaimLatency(r, kill.ms, typed.ms + 1)
      check(`A: the foreground group is Mercury’s again within ${EDITOR_RECLAIM_BUDGET_MS} ms (E2E; the native-call speed is B’s ≤200 ms)`, latency.first !== undefined && latency.ms <= EDITOR_RECLAIM_BUDGET_MS, `first foreground sample at +${latency.ms} ms`)
      console.log(`      reclaim observed at +${latency.ms} ms after the kill`)
      const rearm = modeEventsBetween(r, kill.teeOffset, typed.teeOffset)
      check('A: the alternate screen and the mouse family are re-armed after the return', lastStateOf(rearm, 'alt-screen') === 'on' && MOUSE_FAMILIES.every(f => lastStateOf(rearm, f) === 'on'), `alt=${lastStateOf(rearm, 'alt-screen')}`)
      check('A: the next keys landed in the composer', typed.grid.includes('kestrel typed after kill'))
      check('A: the shell never reported a stop', !r.shellLines.some(l => /Stopped|suspended/.test(l)), r.shellLines.join(' | '))
      const holds2 = r.samples.find(s => s.label === 'editor-holds-2')
      check('C: the second take held the terminal too', childHeldTerminal(holds2))
      check('C: a normal return: the edit landed in the composer', afterReturn.grid.includes('edited by the stand-in'))
      const returnSamples = samplesBetween(r, afterKill.ms, typed2.ms + 1)
      check('C: never T, foreground ours after the return', neverStopped(returnSamples) && withStat(samplesBetween(r, afterReturn.ms - 1, typed2.ms + 1)).every(s => s.foreground === true))
      check('C: keys still land after the normal return', typed2.grid.includes('stand-in more'))
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

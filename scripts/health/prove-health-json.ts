#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const STATUSES = new Set(['ok', 'warn', 'fail', 'stale', 'unknown', 'off', 'info'])

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failures++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

interface RunResult {
  status: number
  json: unknown
}
const scratchHome = mkdtempSync(join(tmpdir(), 'doctor-proof-home-'))
function runHealth(cwd: string, env: Record<string, string | undefined> = {}, verb: 'health' | 'doctor' = 'health', extraArgs: string[] = [], bin: string = BIN): RunResult {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('node', [bin, verb, '--json', ...extraArgs], {
      cwd,
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string }
    status = err.status ?? -1
    stdout = err.stdout ?? ''
  }
  let json: unknown = null
  try {
    json = JSON.parse(stdout)
  } catch {
    json = null
  }
  return { status, json }
}

type Check = { id: string; status: string; evidence?: unknown; fix?: unknown }
type Cert = {
  verdict: string
  sections: Array<{ id: string; title: string; checks: Check[] }>
  ranAt: string
  head: { sha: string | null; dirty: boolean | null }
  version: string
}
const allChecks = (c: Cert): Check[] => c.sections.flatMap(s => s.checks)
const byId = (c: Cert, id: string): Check | undefined => allChecks(c).find(x => x.id === id)

const scratch = mkdtempSync(join(tmpdir(), 'doctor-proof-'))
try {
  {
    const dir = join(scratch, 'bare')
    mkdirSync(dir, { recursive: true })
    const r = runHealth(dir)
    check(
      'bare run exits 0 or 3 (report produced; 3 = fault verdict on this signed-out scratch home — FC-044)',
      r.status === 0 || r.status === 3,
      `status=${r.status}`,
    )
    const cert = r.json as Cert
    check('cert has verdict/sections/head/version', !!cert && typeof cert.verdict === 'string' && Array.isArray(cert.sections) && 'head' in cert)
    check('ranAt is ISO-8601', !Number.isNaN(Date.parse(cert.ranAt)))
    const checks = allChecks(cert)
    check(`every check carries NON-EMPTY evidence (${checks.length} checks)`,
      checks.length >= 15 && checks.every(c => typeof c.evidence === 'string' && c.evidence.length > 0),
      checks.filter(c => !c.evidence).map(c => c.id).join(','))
    check('every status is in the 7-status enum', checks.every(c => STATUSES.has(c.status)))
    check('no gate in a bare project reads info (not fabricated ok/unknown)', byId(cert, 'gate')?.status === 'info')
    const sandbox = byId(cert, 'sandbox')
    check('sandbox check present in RUNTIME', !!sandbox)
    check('sandbox off (default) reads info, not ok/fail', sandbox?.status === 'info', JSON.stringify(sandbox))
    check('sandbox evidence names the unconfined state', /unconfined/.test(String(sandbox?.evidence)))
    const mcp = byId(cert, 'mcp')
    check('mcp evidence carries the untrusted-hardening state', /untrusted-hardening off|untrusted servers clamped/.test(String(mcp?.evidence)))
    check('no retired estate row lingers in the certificate', byId(cert, 'party') === undefined && byId(cert, 'multiplayer') === undefined && byId(cert, 'room-snapshots') === undefined)
    const authSection = cert.sections.find(s => s.id === 'auth')
    check('AUTH section present', !!authSection)
    for (const provider of ['anthropic', 'openai', 'zai']) {
      const row = authSection?.checks.find(c => c.id === `auth-${provider}`)
      check(`AUTH carries one row for ${provider} (absent ⇒ an absent row, never silence)`,
        !!row && typeof row.evidence === 'string' && row.evidence.length > 0,
        JSON.stringify(row))
    }
    check('the legacy single-provider auth row is gone', !authSection?.checks.some(c => c.id === 'auth'))
    const projectsDir = join(scratchHome, '.mercury', 'projects')
    const slugs = existsSync(projectsDir) ? readdirSync(projectsDir) : []
    check('the bare run wrote ONE project store under the config home', slugs.length === 1, JSON.stringify(slugs))
    const lastCert = join(projectsDir, slugs[0] ?? '(none)', 'doctor', 'last-cert.json')
    check('last-cert summary artifact written under the config home\'s project store', existsSync(lastCert), lastCert)
    check('POISON: nothing was written into the project folder\'s .mercury/doctor', !existsSync(join(dir, '.mercury', 'doctor', 'last-cert.json')))
    const sum = JSON.parse(readFileSync(lastCert, 'utf8')) as { verdict?: string; counts?: unknown }
    check('last-cert summary carries verdict + counts', typeof sum.verdict === 'string' && !!sum.counts)
  }

  const plantGateMachinery = (dir: string): void => {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'run-all-suites.sh'), '#!/usr/bin/env bash\nexit 0\n')
  }

  {
    const dir = join(scratch, 'green')
    plantGateMachinery(dir)
    mkdirSync(join(dir, '.mercury', 'gate'), { recursive: true })
    writeFileSync(
      join(dir, '.mercury', 'gate', 'verdict.json'),
      JSON.stringify({ ok: true, pass: ['ui', 'doctor'], fail: [], ranAt: new Date().toISOString(), headSha: null, dirty: false, durationS: 42 }),
    )
    const r = runHealth(dir)
    const gate = byId(r.json as Cert, 'gate')
    check('planted green verdict (no repo) ⇒ gate ok', gate?.status === 'ok', JSON.stringify(gate))
    check('gate evidence says the sha comparison was skipped', String(gate?.evidence).includes('sha comparison skipped'))
  }

  {
    const dir = join(scratch, 'moved')
    plantGateMachinery(dir)
    mkdirSync(join(dir, '.mercury', 'gate'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir })
    writeFileSync(
      join(dir, '.mercury', 'gate', 'verdict.json'),
      JSON.stringify({ ok: true, pass: ['ui'], fail: [], ranAt: new Date().toISOString(), headSha: 'f'.repeat(40), dirty: false, durationS: 1 }),
    )
    const r = runHealth(dir)
    const gate = byId(r.json as Cert, 'gate')
    check('green verdict @ a moved HEAD ⇒ stale (never silently green)', gate?.status === 'stale', JSON.stringify(gate))
    check('stale evidence names the movement', String(gate?.evidence).includes('HEAD has moved'))
    check('a stale gate rolls the verdict to caution-or-worse', (r.json as Cert).verdict !== 'certified')
  }

  {
    const dir = join(scratch, 'red')
    plantGateMachinery(dir)
    mkdirSync(join(dir, '.mercury', 'gate'), { recursive: true })
    writeFileSync(
      join(dir, '.mercury', 'gate', 'verdict.json'),
      JSON.stringify({ ok: false, pass: ['ui'], fail: ['crew', 'memory'], ranAt: new Date().toISOString(), headSha: null, dirty: false, durationS: 9 }),
    )
    const r = runHealth(dir)
    const cert = r.json as Cert
    check('red verdict ⇒ gate fail', byId(cert, 'gate')?.status === 'fail')
    check('red evidence names the red suites', String(byId(cert, 'gate')?.evidence).includes('crew'))
    check('a failing check rolls the verdict to FAULT', cert.verdict === 'fault')
    check('FAULT exits 3 — produced AND the guard fires (FC-044)', r.status === 3)
  }

  {
    const dir = join(scratch, 'off')
    mkdirSync(dir, { recursive: true })
    const r = runHealth(dir, { MERCURY_DOCTOR_CERT: '0' })
    check('MERCURY_DOCTOR_CERT=0 ⇒ exit 1 (could not produce)', r.status === 1)
    const err = r.json as { code?: string; error?: string }
    check('gated-off error is JSON on stdout with a stable code', err?.code === 'cert-unavailable' && typeof err?.error === 'string')
  }

  {
    const dir = join(scratch, 'alias')
    mkdirSync(dir, { recursive: true })
    const r = runHealth(dir, {}, 'doctor')
    const cert = r.json as { verdict?: string } | null
    check('`doctor` alias still produces the certificate (0/3 by verdict, verdict present)', (r.status === 0 || r.status === 3) && typeof cert?.verdict === 'string', `status=${r.status}`)
  }

  {
    const dir = join(scratch, 'piped-vs-tty')
    mkdirSync(dir, { recursive: true })
    const piped = runHealth(dir)
    const pipedCert = piped.json as Cert
    const pipedRow = byId(pipedCert, 'iface-terminal')
    check('piped: the profile row is NEVER a fault', pipedRow !== undefined && pipedRow.status !== 'fail', JSON.stringify(pipedRow))
    check("piped: the row reads neutral 'info'", pipedRow?.status === 'info', pipedRow?.status)
    check('piped: the evidence names the environmental condition', /environmental/.test(String(pipedRow?.evidence)), String(pipedRow?.evidence))
  }
  {
    const dir = join(scratch, 'only-json')
    mkdirSync(dir, { recursive: true })
    const r = runHealth(dir, {}, 'doctor', ['--only', 'build-identity'])
    check('--only run exits 0', r.status === 0)
    const cert = r.json as Cert
    const checks = cert ? allChecks(cert) : []
    check('the record carries EXACTLY one check', checks.length === 1, `${checks.length} checks`)
    check('…the named one', checks[0]?.id === 'build-identity', checks[0]?.id)
    check('…with the verdict recomputed over what remains', cert.verdict === 'certified', cert.verdict)

    const bad = runHealth(dir, {}, 'doctor', ['--only', 'no-such-check'])
    check('unknown id ⇒ exit 1', bad.status === 1)
    const err = bad.json as { code?: string; knownIds?: string[] }
    check('…typed refusal', err?.code === 'unknown-check-id', err?.code)
    check('…naming the known ids', Array.isArray(err?.knownIds) && err.knownIds.includes('build-identity'))
  }

  {
    const dir = join(scratch, 'only-plain')
    mkdirSync(dir, { recursive: true })
    let pipedOut = ''
    let pipedStatus = 0
    try {
      pipedOut = execFileSync('node', [BIN, 'doctor', '--only', 'build-identity'], {
        cwd: dir,
        env: { ...process.env, MERCURY_CONFIG_DIR: join(scratchHome, '.mercury') },
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const err = e as { status?: number; stdout?: string }
      pipedStatus = err.status ?? -1
      pipedOut = err.stdout ?? ''
    }
    check('plain piped --only exits 0', pipedStatus === 0)
    check('…prints the one check row', pipedOut.includes('Mercury build'), pipedOut.slice(0, 200))
    check('…and ONLY that row', (pipedOut.match(/^\s*\[[A-Z]+\]/gm) ?? []).length === 1, pipedOut.slice(0, 300))
    check('…with the verdict line', /verdict: [A-Z]+/.test(pipedOut))

  }

  console.log('\n§sandbox-row: the OS Bash sandbox row reads its three states, and on Linux the ON row says what the helper answers about unix sockets')
  {
    const ON_MAC = 'ON — Bash filesystem + network confined (seatbelt/bubblewrap)'
    const ON_LINUX_BLOCKED = 'ON — Bash filesystem + network confined (bubblewrap; unix sockets blocked)'
    const ON_LINUX_NO_HELPER = 'ON — Bash filesystem + network confined (bubblewrap; unix sockets open — no seccomp helper)'
    const ON_LINUX_BY_SETTING = 'ON — Bash filesystem + network confined (bubblewrap; unix sockets open — sandbox.network.allowAllUnixSockets)'
    const dir = join(scratch, 'sandbox-row', 'cwd')
    const home = join(scratch, 'sandbox-row', 'home')
    const settings = join(home, 'settings.json')
    const bin = join(scratch, 'sandbox-row', 'bin')
    const bundleDir = join(scratch, 'sandbox-row', 'dist')
    mkdirSync(dir, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(bin, { recursive: true })
    mkdirSync(bundleDir, { recursive: true })
    const shim = (path: string): void => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '#!/bin/sh\nexit 0\n')
      chmodSync(path, 0o755)
    }
    for (const tool of ['bwrap', 'socat', 'rg']) shim(join(bin, tool))
    copyFileSync(BIN, join(bundleDir, 'mercury.mjs'))
    const helper = join(bundleDir, 'vendor', 'seccomp', process.arch, 'apply-seccomp')
    const sandboxRow = (sandbox: Record<string, unknown>, linux: boolean, bundle: string = BIN): Check | undefined => {
      writeFileSync(settings, JSON.stringify({ sandbox }))
      const env: Record<string, string> = { MERCURY_CONFIG_DIR: home, PATH: `${bin}:${process.env.PATH ?? ''}` }
      if (linux) {
        env.SANDBOX_PATHS_PLATFORM = 'linux'
        env.NODE_OPTIONS = `--require=${join(REPO, 'scripts', 'ui', 'fixtures', 'sandbox-paths', 'platform.cjs')}`
      }
      const r = runHealth(dir, env, 'doctor', ['--only', 'sandbox'], bundle)
      return r.json ? byId(r.json as Cert, 'sandbox') : undefined
    }

    const off = sandboxRow({}, false)
    check('off: the row reads info with the unconfined words, byte for byte', off?.status === 'info' && off.evidence === 'off — Bash runs unconfined (no OS filesystem/network boundary)', JSON.stringify(off))
    const unavailable = sandboxRow({ enabled: true, enabledPlatforms: [] }, false)
    check('enabled but unavailable: the row reads warn with the reason and a fix', unavailable?.status === 'warn' && /sandbox\.enabledPlatforms/.test(String(unavailable.evidence)) && typeof unavailable.fix === 'string', JSON.stringify(unavailable))
    if (process.platform === 'darwin') {
      const mac = sandboxRow({ enabled: true }, false)
      check('macOS ON: the seatbelt words stay byte for byte, nothing said about sockets', mac?.status === 'ok' && mac.evidence === ON_MAC, JSON.stringify(mac))
    } else {
      console.log(`  [SKIP] the host is ${process.platform}; the macOS ON row is read on a Mac`)
    }
    const noHelper = sandboxRow({ enabled: true }, true, join(bundleDir, 'mercury.mjs'))
    check('Linux ON, no apply-seccomp beside the bundle: the row says unix sockets are open and why', noHelper?.status === 'ok' && noHelper.evidence === ON_LINUX_NO_HELPER, JSON.stringify(noHelper))
    shim(helper)
    const blocked = sandboxRow({ enabled: true }, true, join(bundleDir, 'mercury.mjs'))
    check('Linux ON, apply-seccomp beside the bundle: the row says unix sockets are blocked', blocked?.status === 'ok' && blocked.evidence === ON_LINUX_BLOCKED, JSON.stringify(blocked))
    const bySetting = sandboxRow({ enabled: true, network: { allowAllUnixSockets: true } }, true, join(bundleDir, 'mercury.mjs'))
    check('Linux ON, the helper present but allowAllUnixSockets set: the row says the sockets are open by that setting', bySetting?.status === 'ok' && bySetting.evidence === ON_LINUX_BY_SETTING, JSON.stringify(bySetting))
  }

  console.log('\n§slow-reader: a consumer slower than the writer still reads exactly one record')
  {
    const errFile = join(scratch, 'slow-reader.stderr')
    let piped = ''
    let status = 0
    try {
      piped = execFileSync(
        'bash',
        ['-c', 'node "$0" health --json 2>"$1" | (sleep 3; cat); exit "${PIPESTATUS[0]}"', BIN, errFile],
        {
          cwd: scratch,
          env: { ...process.env, MERCURY_CONFIG_DIR: join(scratchHome, '.mercury') },
          encoding: 'utf8',
          timeout: 90_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string }
      status = err.status ?? -1
      piped = err.stdout ?? ''
    }
    const stderrText = existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''
    let record: { verdict?: string } | null = null
    try {
      record = JSON.parse(piped) as { verdict?: string }
    } catch {
      record = null
    }
    check('stdout is exactly one JSON record (a second document would fail the parse)', record !== null, `${piped.length} bytes; tail: ${JSON.stringify(piped.slice(-160))}`)
    check('the exit code is the verdict\'s own (3 = fault, else 0), not a crash', record !== null && status === (record.verdict === 'fault' ? 3 : 0), `status ${status}, verdict ${record?.verdict}`)
    check('stderr carries no crash banner', stderrText.trim() === '', stderrText.slice(0, 200))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(scratchHome, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n❌ ${failures} end-to-end check(s) failed`)
  process.exit(1)
}
console.log('\n✅ health --json end-to-end contract holds')

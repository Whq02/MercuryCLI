#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
function runHealth(cwd: string, env: Record<string, string | undefined> = {}, verb: 'health' | 'doctor' = 'health', extraArgs: string[] = []): RunResult {
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('node', [BIN, verb, '--json', ...extraArgs], {
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
    const lastCert = join(dir, '.mercury', 'doctor', 'last-cert.json')
    check('last-cert summary artifact written', existsSync(lastCert))
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

  const scriptArgv = (argv: string[]): string[] =>
    process.platform === 'linux'
      ? ['-q', '-e', '-c', argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null']
      : ['-q', '/dev/null', ...argv]
  {
    const dir = join(scratch, 'piped-vs-tty')
    mkdirSync(dir, { recursive: true })
    const NO_CREDENTIAL = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, MERCURY_OAUTH_TOKEN: undefined }
    const piped = runHealth(dir, NO_CREDENTIAL)
    const pipedCert = piped.json as Cert
    const pipedRow = byId(pipedCert, 'iface-terminal')
    check('piped: the profile row is NEVER a fault', pipedRow !== undefined && pipedRow.status !== 'fail', JSON.stringify(pipedRow))
    check("piped: the row reads neutral 'info'", pipedRow?.status === 'info', pipedRow?.status)
    check('piped: the evidence names the environmental condition', /environmental/.test(String(pipedRow?.evidence)), String(pipedRow?.evidence))
    let ttyCert: Cert | null = null
    try {
      const out = execFileSync(
        '/usr/bin/script',
        scriptArgv(['node', BIN, 'health', '--json']),
        {
          cwd: dir,
          env: {
            ...process.env,
            MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            ...NO_CREDENTIAL,
          },
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).replace(/\r/g, '')
      const first = out.indexOf('{')
      const last = out.lastIndexOf('}')
      if (first !== -1 && last > first) ttyCert = JSON.parse(out.slice(first, last + 1)) as Cert
    } catch (error) {
      const out = String((error as { stdout?: unknown }).stdout ?? '').replace(/\r/g, '')
      const first = out.indexOf('{')
      const last = out.lastIndexOf('}')
      ttyCert = first !== -1 && last > first ? (JSON.parse(out.slice(first, last + 1)) as Cert) : null
    }
    if (ttyCert === null) {
      check('tty drive produced a certificate (script(1) PTY)', false)
    } else {
      const ttyRow = byId(ttyCert, 'iface-terminal')
      check('tty: the profile row is NOT the environmental form', !/environmental/.test(String(ttyRow?.evidence)), String(ttyRow?.evidence))
      const nonPass = (cert: Cert): string =>
        allChecks(cert)
          .filter(r => r.status !== 'ok' && r.status !== 'info' && r.status !== 'off')
          .map(r => `${r.id}:${r.status}`)
          .join(' ')
      check(
        "the piped run's verdict equals the TTY run's (the profile row no longer flips it)",
        pipedCert.verdict === ttyCert.verdict,
        `piped=${pipedCert.verdict} [${nonPass(pipedCert)}] tty=${ttyCert.verdict} [${nonPass(ttyCert)}]`,
      )
    }
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

    let ptyOut: string | null = null
    try {
      ptyOut = execFileSync(
        '/usr/bin/script',
        scriptArgv(['node', BIN, 'doctor', '--only', 'build-identity']),
        {
          cwd: dir,
          env: {
            ...process.env,
            MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'),
            TERM: 'xterm-256color',
          },
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).replace(/\r/g, '')
    } catch {
      ptyOut = null
    }
    check('PTY --only exits unaided (no parked interactive view)', ptyOut !== null)
    check('…printing the one check, not the panel', ptyOut !== null && ptyOut.includes('Mercury build'), (ptyOut ?? '').slice(0, 200))
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

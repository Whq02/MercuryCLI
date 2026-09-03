#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✅ ${name}`)
  else {
    failures++
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

type Check = { id: string; status: string; evidence?: unknown; fix?: unknown }
type Cert = { verdict: string; sections: Array<{ id: string; checks: Check[] }> }
const allChecks = (c: Cert): Check[] => c.sections.flatMap(s => s.checks)
const byId = (c: Cert, id: string): Check | undefined => allChecks(c).find(x => x.id === id)
const nonPass = (cert: Cert): string =>
  allChecks(cert)
    .filter(r => r.status !== 'ok' && r.status !== 'info' && r.status !== 'off')
    .map(r => `${r.id}:${r.status}`)
    .join(' ')

const scratchHome = mkdtempSync(join(tmpdir(), 'doctor-tty-home-'))
const scratch = mkdtempSync(join(tmpdir(), 'doctor-tty-'))
const NO_CREDENTIAL = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, MERCURY_OAUTH_TOKEN: undefined }
const PTY_DRIVER = 'import os, pty, sys; st = pty.spawn(sys.argv[1:]); sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os, "waitstatus_to_exitcode") else (st >> 8))'

const firstJsonObject = (text: string): Cert | null => {
  const out = text.replace(/\r/g, '')
  const first = out.indexOf('{')
  if (first === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = first; i < out.length; i++) {
    const c = out[i] as string
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(out.slice(first, i + 1)) as Cert
      } catch {
        return null
      }
    }
  }
  return null
}

function ptyRun(cwd: string, args: string[], env: Record<string, string | undefined>): { out: string; threw: boolean } {
  try {
    const out = execFileSync('python3', ['-c', PTY_DRIVER, 'node', BIN, ...args], {
      cwd,
      env: { ...process.env, MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'), TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { out, threw: false }
  } catch (error) {
    return { out: String((error as { stdout?: unknown }).stdout ?? ''), threw: true }
  }
}

function pipedRun(cwd: string, args: string[], env: Record<string, string | undefined>): Cert | null {
  let out = ''
  try {
    out = execFileSync('node', [BIN, ...args], {
      cwd,
      env: { ...process.env, MERCURY_CONFIG_DIR: join(scratchHome, '.mercury'), ...env },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    out = String((error as { stdout?: unknown }).stdout ?? '')
  }
  return firstJsonObject(out)
}

console.log('health --json under a real pseudo-terminal')
try {
  console.log('\n§1 the piped verdict equals the TTY verdict (the profile row never flips it)')
  {
    const dir = join(scratch, 'piped-vs-tty')
    mkdirSync(dir, { recursive: true })
    const pipedCert = pipedRun(dir, ['health', '--json'], NO_CREDENTIAL)
    check('the piped run produced a record', pipedCert !== null)
    const tty = ptyRun(dir, ['health', '--json'], NO_CREDENTIAL)
    const ttyCert = firstJsonObject(tty.out)
    check('the tty run produced a record (a python pty)', ttyCert !== null, `no balanced record in the transcript — tail: ${JSON.stringify(tty.out.slice(-300))}`)
    if (pipedCert !== null && ttyCert !== null) {
      const pipedRow = byId(pipedCert, 'iface-terminal')
      const ttyRow = byId(ttyCert, 'iface-terminal')
      check("piped: the profile row reads neutral 'info' naming the environmental condition", pipedRow?.status === 'info' && /environmental/.test(String(pipedRow?.evidence)), JSON.stringify(pipedRow))
      check('tty: the profile row is NOT the environmental form', !/environmental/.test(String(ttyRow?.evidence)), String(ttyRow?.evidence))
      check(
        "the piped run's verdict equals the TTY run's (the profile row no longer flips it)",
        pipedCert.verdict === ttyCert.verdict,
        `piped=${pipedCert.verdict} [${nonPass(pipedCert)}] tty=${ttyCert.verdict} [${nonPass(ttyCert)}]`,
      )
    }
  }

  console.log('\n§2 `doctor --only <id>` under a pty exits unaided with the one row')
  {
    const dir = join(scratch, 'only-tty')
    mkdirSync(dir, { recursive: true })
    const r = ptyRun(dir, ['doctor', '--only', 'build-identity'], {})
    const out = r.out.replace(/\r/g, '')
    check('PTY --only exits unaided (no parked interactive view)', !r.threw, `threw; tail: ${JSON.stringify(out.slice(-200))}`)
    check('…printing the one check, not the panel', out.includes('Mercury build'), out.slice(0, 200))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(scratchHome, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n❌ ${failures} tty check(s) failed`)
  process.exit(1)
}
console.log('\n✅ health --json holds under a real pseudo-terminal')

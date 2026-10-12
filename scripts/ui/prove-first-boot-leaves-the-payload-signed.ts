#!/usr/bin/env bun
// gate-watch: src/utils/ripgrep.ts src/main.tsx src/services/privateChannel/artifactVerify.ts src/services/privateChannel/installLayout.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import {
  FIXTURE_VERSION,
  buildSignedPayloadWithLinkerSignedRg,
  codesignFlags,
  flipOneByte,
  isLinkerSigned,
  sha256Of,
} from '../lib/signedRipgrepPayload.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 600) : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

if (process.platform !== 'darwin') {
  console.log('prove-first-boot-leaves-the-payload-signed: SKIPPED — the ad-hoc re-sign of the vendored search binary exists on macOS only')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`prove-first-boot-leaves-the-payload-signed: SKIPPED — no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
if (!existsSync(DIST)) {
  console.log('prove-first-boot-leaves-the-payload-signed: SKIPPED — dist/mercury.mjs is not built')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'first-boot-payload-'))
const HOME = join(scratch, 'home')
const CWD = join(scratch, 'cwd')
mkdirSync(CWD, { recursive: true })
writeFileSync(join(CWD, 'README.md'), '# a small folder for the first boot\n')
writeFileSync(join(CWD, 'notes.txt'), 'one line\n')
seedFirstRun(HOME, [CWD])
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_VERSIONS_DIR

const { installPayload, resolveLayoutRoots } = await import('../../src/services/privateChannel/installLayout.ts')
const { verifyPayloadDir } = await import('../../src/services/privateChannel/artifactVerify.ts')

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: HOME,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_UPDATE_NOTICE: '0',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    BROWSER: '/usr/bin/true',
  }
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_MODEL', 'MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_FIXTURE', 'NODE_ENV', 'CI']) delete env[key]
  return env
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

async function bootUntil(entry: string, evidence: () => boolean, budgetMs: number): Promise<{ status: number | null; reason: string; stderr: string }> {
  const cfgPath = join(scratch, 'boot-vshot.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', entry, '--chat'], sends: [], total: Math.ceil(budgetMs / 200), cols: 120, rows: 40, out: join(scratch, 'boot-grid.json'), title: 'first boot' }))
  const stderr: string[] = []
  const child = spawn(driver.python, [VSHOT, cfgPath], { env: childEnv(), cwd: CWD, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr?.on('data', c => stderr.push(String(c)))
  const closed = new Promise<number | null>(resolveStatus => child.on('close', code => resolveStatus(code)))
  const started = Date.now()
  let reason = 'budget'
  while (Date.now() - started < budgetMs) {
    if (evidence()) {
      reason = 'evidence'
      break
    }
    if (child.exitCode !== null) {
      reason = 'exited'
      break
    }
    await sleep(250)
  }
  if (reason === 'evidence') await sleep(1500)
  if (child.exitCode === null) child.kill('SIGTERM')
  const status = await Promise.race([closed, sleep(vshotBudgetMs(20_000)).then(() => null)])
  if (child.exitCode === null) child.kill('SIGKILL')
  return { status, reason, stderr: stderr.join('').trim() }
}

try {
  section('§1 install a signed release payload whose vendored rg is linker-signed, the way the archive ships it')
  const fixture = buildSignedPayloadWithLinkerSignedRg(join(scratch, 'archive', 'mercury'), { primary: DIST })
  check('the archive rg is linker-signed', isLinkerSigned(fixture.rgPath), codesignFlags(fixture.rgPath))
  const roots = resolveLayoutRoots()
  const installed = installPayload(roots, fixture.dir, FIXTURE_VERSION)
  check('the payload installs into the scratch home through the updater\'s own install road', installed.state === 'installed', JSON.stringify(installed))
  const versionDir = join(roots.versionsDir, FIXTURE_VERSION)
  const installedRg = join(versionDir, 'vendor', 'ripgrep', `${process.arch}-${process.platform}`, 'rg')
  const shippedSha = sha256Of(installedRg)
  check('the installed rg is the shipped one, still linker-signed', shippedSha === fixture.rgSha256 && isLinkerSigned(installedRg), codesignFlags(installedRg))
  const control = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
  check('deep verification before any boot reads signed', control.verdict.state === 'signed', JSON.stringify(control.verdict))

  section('§2 boot the installed payload once, as a stranger would, until its first search')
  const cacheDir = join(HOME, 'cache', 'ripgrep')
  const copyAppeared = (): boolean => existsSync(cacheDir) && readdirSync(cacheDir).some(d => existsSync(join(cacheDir, d, 'rg')))
  const payloadChanged = (): boolean => sha256Of(installedRg) !== shippedSha
  const boot = await bootUntil(join(versionDir, 'mercury.mjs'), () => copyAppeared() || payloadChanged(), vshotBudgetMs(45_000))
  console.log(`  · boot ended: ${boot.reason} (vshot exit ${String(boot.status)})`)
  check('the boot reached the first search (the repair road ran: a copy appeared or the payload moved)', boot.reason === 'evidence', `${boot.reason} · ${boot.stderr.slice(-400)}`)

  section('§3 the payload is exactly what was signed; the re-signed copy lives under the config home')
  check('the installed rg bytes are unchanged by the boot', sha256Of(installedRg) === shippedSha, `${sha256Of(installedRg).slice(0, 12)} vs shipped ${shippedSha.slice(0, 12)} · ${codesignFlags(installedRg)}`)
  check('…and still linker-signed, as shipped', isLinkerSigned(installedRg), codesignFlags(installedRg))
  const after = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
  check('deep verification after the first boot reads signed — a clean install never reads TAMPERED', after.verdict.state === 'signed', JSON.stringify(after.verdict))
  const copyDir = join(cacheDir, shippedSha.slice(0, 16))
  const copy = join(copyDir, 'rg')
  check('the re-signed copy sits under <home>/cache/ripgrep/<digest>/rg, keyed by the shipped file\'s digest', existsSync(copy), existsSync(cacheDir) ? readdirSync(cacheDir).join(' · ') : 'no cache dir')
  check('the copy carries a full ad-hoc signature, no longer linker-signed', existsSync(copy) && !isLinkerSigned(copy) && codesignFlags(copy).includes('adhoc'), existsSync(copy) ? codesignFlags(copy) : '')
  check('nothing under the installed version dir was written by the boot (no new member)', readdirSync(versionDir).sort().join(',') === readdirSync(fixture.dir).sort().join(','), readdirSync(versionDir).join(','))

  section('§4 a real change to the installed payload still reads TAMPERED')
  flipOneByte(installedRg)
  const tampered = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
  check('one flipped byte in the installed rg: deep verification reads tampered', tampered.verdict.state === 'tampered' && tampered.verdict.note.includes('payload tree differs'), JSON.stringify(tampered.verdict))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-first-boot-leaves-the-payload-signed — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-first-boot-leaves-the-payload-signed — all checks pass')
process.exit(0)

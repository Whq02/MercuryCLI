#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_DELETED_FOLDER_BIN ?? join(REPO, 'dist', 'mercury.mjs')
const NODE = existsSync(join(REPO, 'dist', 'vendor', 'node', 'bin', 'node'))
  ? join(REPO, 'dist', 'vendor', 'node', 'bin', 'node')
  : 'node'

const EXPECTED = 'the folder you started in no longer exists; start Mercury from another folder'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

if (!existsSync(BIN)) {
  console.error(`the built bundle is missing at ${BIN} — run \`bun run build.ts\``)
  process.exit(1)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'deleted-folder-boot-')))
const home = join(SCRATCH, 'home')
const gone = join(SCRATCH, 'gone')
mkdirSync(home, { recursive: true })
mkdirSync(gone, { recursive: true })

const script = `cd ${JSON.stringify(gone)} && rmdir ${JSON.stringify(gone)} && exec ${JSON.stringify(NODE)} ${JSON.stringify(BIN)} health --json`
const r = spawnSync('bash', ['-c', script], {
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    BROWSER: '/usr/bin/true',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  },
  encoding: 'utf8',
  timeout: 60_000,
})

const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
const stderrTrimmed = (r.stderr ?? '').trim()

check('the boot exits non-zero (the folder is gone; nothing was opened)', typeof r.status === 'number' && r.status !== 0, `status=${r.status}; the missing-folder branch at the top of src/boot/entrypoints/cli.tsx (cwdIsMissing) must exit non-zero; rebuild with bun run build.ts if the bundle is stale`)
check('stderr is the ONE plain line, in Mercury\'s words', stderrTrimmed === EXPECTED, `${JSON.stringify(stderrTrimmed.slice(0, 200))}; src/boot/entrypoints/cli.tsx must write MISSING_CWD_LINE (src/platform/node-runtime/nodePolicy.ts) to stderr and nothing else when cwdIsMissing()`)
check('the crash card is NOT shown (no "MERCURY COULD NOT START")', !out.includes('MERCURY COULD NOT START'), `${out.slice(0, 200)}; src/boot/entrypoints/cli.tsx must exit on cwdIsMissing() before the crash card path runs`)
check('Node\'s own uv_cwd sentence is NOT surfaced to the operator', !out.includes('uv_cwd'), `${out.slice(0, 200)}; the missing-folder branch in src/boot/entrypoints/cli.tsx and src/platform/processes/gracefulShutdown.ts must replace Node's uv_cwd error with MISSING_CWD_LINE`)

const crashesDir = join(home, 'crashes')
const crashFiles = existsSync(crashesDir) ? readdirSync(crashesDir).filter(f => f.startsWith('crash-')) : []
check('NO crash record is written (so the next boot shows no crash notice)', crashFiles.length === 0, `${crashFiles.join(', ')}; a missing folder must not reach persistCrashReport in src/platform/logs/crashReport.ts (see isMissingCwd in src/platform/node-runtime/nodePolicy.ts and src/platform/processes/gracefulShutdown.ts)`)
const bootNoticed = existsSync(join(home, '.boot-noticed'))
check('no boot-crash notice marker is left behind', !bootNoticed, `${join(home, '.boot-noticed')} exists; the missing-folder exit must not write the notice marker handled in src/platform/logs/crashReport.ts`)

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-deleted-folder-boot: all green' : `\n❌ prove-deleted-folder-boot: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

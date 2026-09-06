#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENGINE_ENV, ROOT, engineLaneState, resolveEngineUnderTest } from './shell-engine-parity.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const engine = resolveEngineUnderTest()
const lane = engineLaneState()
console.log('============================================================')
console.log(' The sandbox law — the shell engine is the sandboxed child')
console.log('============================================================')
console.log(`  engine under test: ${engine} (pin ${ENGINE_ENV}=${process.env[ENGINE_ENV] ?? 'unset'}; lane ${lane.state})`)

const HOME = process.env.MERCURY_CONFIG_DIR as string
mkdirSync(HOME, { recursive: true })
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }, null, 2))

const { exec, setCwd } = await import('../../src/utils/Shell.ts')
const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
const { shouldUseSandbox } = await import('../../src/tools/BashTool/shouldUseSandbox.ts')

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'shell-engine-sandbox-')))
const PROJECT = join(SCRATCH, 'project')
const OUTSIDE = join(SCRATCH, 'outside')
mkdirSync(PROJECT)
mkdirSync(OUTSIDE)
process.chdir(PROJECT)
setCwd(PROJECT)

section('§0 the platform and the decision owner')
const platformOk = process.platform === 'darwin' || process.platform === 'linux'
const enabledInSettings = SandboxManager.isSandboxEnabledInSettings()
check('the hermetic home turned the sandbox on in settings', enabledInSettings)
const unavailable = SandboxManager.getSandboxUnavailableReason()
const ready = platformOk && enabledInSettings && unavailable === null && SandboxManager.isSandboxingEnabled()
if (!ready) {
  console.log(`  [SKIP] live sandbox — platform ${process.platform}, enabled ${enabledInSettings}, reason ${unavailable ?? 'none'}: the boundary cannot be exercised on this machine`)
} else {
  check('shouldUseSandbox says yes for a plain command', shouldUseSandbox({ command: 'ls' }) === true)
  check('shouldUseSandbox honours the explicit override', shouldUseSandbox({ command: 'ls', dangerouslyDisableSandbox: true }) === false)
  const doctor = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check('the doctor names the mechanism (seatbelt / bubblewrap)', /seatbelt\/bubblewrap/.test(doctor))
  await SandboxManager.initialize()

  interface Outcome {
    code: number
    out: string
    stderr: string
  }
  async function run(command: string, sandboxed: boolean): Promise<Outcome> {
    const handle = await exec(command, new AbortController().signal, 'bash', {
      timeout: 20_000,
      shouldUseSandbox: sandboxed,
      shouldAutoBackground: false,
    })
    const result = await handle.result
    return { code: result.code, out: result.stdout, stderr: result.stderr }
  }

  section('§1 the boundary through the seam')
  const echo = await run('echo sandboxed-ok', true)
  check('a sandboxed command runs', /sandboxed-ok/.test(echo.out), `code ${echo.code} ${JSON.stringify(echo.out.slice(0, 120))}`)
  check('the cwd record lands inside the boundary (the command settles 0, no refusal of the tracking file)', echo.code === 0 && !/mercury-cwd-[0-9a-f]+: Operation not permitted|Permission denied/.test(echo.out), `code ${echo.code} ${JSON.stringify(echo.out.slice(0, 160))}`)
  const inside = await run(`echo in > "${PROJECT}/in.txt"`, true)
  check('a write inside the session directory lands', existsSync(join(PROJECT, 'in.txt')), `code ${inside.code} ${JSON.stringify(inside.out.slice(0, 120))}`)
  const outside = await run(`echo out > "${OUTSIDE}/out.txt"`, true)
  check('a write outside the allow-write set is refused and the file never appears', outside.code !== 0 && !existsSync(join(OUTSIDE, 'out.txt')), `code ${outside.code} ${JSON.stringify(outside.out.slice(0, 160))}`)
  note(`refusal text: ${JSON.stringify((outside.out + outside.stderr).trim().slice(0, 160))}`)
  const child = await run(`sh -c 'echo child > "${OUTSIDE}/child.txt"'; echo rc=$?`, true)
  check('a child process of the command is inside the boundary too', !existsSync(join(OUTSIDE, 'child.txt')) && /rc=[1-9]/.test(child.out), `${JSON.stringify(child.out.slice(0, 160))}`)
  await run(`(sleep 0.4; echo late > "${OUTSIDE}/late.txt") >/dev/null 2>&1 &`, true)
  await new Promise(resolve => setTimeout(resolve, 1200))
  check('a process left running in the background stays inside the boundary', !existsSync(join(OUTSIDE, 'late.txt')))
  const readOutside = await run(`cat "${PROJECT}/in.txt"; ls "${OUTSIDE}" | wc -l | tr -d ' '`, true)
  check('reads outside the write set still work (the boundary is on writes)', /^in\n0/.test(readOutside.out.replace(/\r/g, '')), JSON.stringify(readOutside.out.slice(0, 80)))

  section('§2 the policy is the call\'s, never the engine process\'s')
  const control = await run(`echo control > "${OUTSIDE}/control.txt"`, false)
  check("an unsandboxed call writes outside (the control: the sandbox is what refuses)", control.code === 0 && existsSync(join(OUTSIDE, 'control.txt')), `code ${control.code}`)
  const again = await run(`echo again > "${OUTSIDE}/again.txt"`, true)
  check('the next sandboxed call is refused again — no policy carried over from the unsandboxed call', again.code !== 0 && !existsSync(join(OUTSIDE, 'again.txt')), `code ${again.code} ${JSON.stringify(again.out.slice(0, 120))}`)
  const relaxed = await run(`echo relaxed > "${OUTSIDE}/relaxed.txt"`, false)
  check('the next unsandboxed call writes again — no policy carried over from the sandboxed call', relaxed.code === 0 && existsSync(join(OUTSIDE, 'relaxed.txt')), `code ${relaxed.code}`)
  const persisted = await run('SANDBOX_STATE=set; :', true)
  const readBack = await run('echo "[${SANDBOX_STATE:-none}]"', true)
  note(`state across two sandboxed calls: ${JSON.stringify(readBack.out.trim().split('\n')[0])} (${engine}; set-call code ${persisted.code})`)
  check('the sandboxed seam still answers after the policy switches', /^\[(none|set)\]/.test(readBack.out), JSON.stringify(readBack.out.slice(0, 80)))
  try {
    SandboxManager.reset()
  } catch {
  }
}

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) console.log(` ✅ THE SANDBOX LAW HOLDS (${engine})`)
else console.log(` ❌ ${failures} SANDBOX-LAW CHECK(S) FAILED (${engine})`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)

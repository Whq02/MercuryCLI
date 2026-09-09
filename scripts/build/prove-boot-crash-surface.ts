#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Boot crash surface — a module the artifact cannot load fails LOUD')
console.log('============================================================')

section('§1 — no handle-require shape: the entry and the handlers fail loud')
{
  const proxy = src('utils', 'proxy.ts')
  const mtls = src('utils', 'mtls.ts')
  const lockfile = src('utils', 'lockfile.ts')
  const main = src('main.tsx')
  const cli = src('entrypoints', 'cli.tsx')
  const shutdown = src('utils', 'gracefulShutdown.ts')
  const build = readFileSync(join(ROOT, 'build.ts'), 'utf8')

  check('proxy.ts imports undici statically (bundled)', /^import \{[^}]*\bAgent\b[^}]*\bfetch as undiciFetch\b[^}]*\} from 'undici'$/m.test(proxy))
  check('proxy.ts holds no createRequire handle', !proxy.includes('createRequire'))
  check('mtls.ts imports its Agent from the same bundled undici', /^import \{ Agent, type Dispatcher \} from 'undici'$/m.test(mtls) && !mtls.includes('createRequire'))
  check('lockfile.ts requires proper-lockfile through the module-scope require (inlined, lazy)', /^\s+cached = require\('proper-lockfile'\)/m.test(lockfile) && !lockfile.includes('createRequire'))
  check('main.tsx raises InvalidArgumentError through its static commander import', main.includes('InvalidArgumentError, Option } from \'commander\'') && !main.includes("require('commander')"))
  const offenders = handleRequiredPackages()
  check('no src module requires a package through a createRequire(import.meta.url) handle', offenders.length === 0, offenders.join(', '))
  check('the entry catches what escapes main() and fails loud', /main\(\)\.catch\(async \(error: unknown\) => \{[\s\S]{0,400}failLoud\(error, 'boot'\)/.test(cli) && !/^void main\(\)$/m.test(cli))
  check('unhandledRejection routes module-load failures to the loud exit', /process\.on\('unhandledRejection', \(reason: unknown\) => \{[\s\S]{0,600}if \(isModuleLoadFailure\(reason\) && !isShuttingDown\(\)\) \{\s*failLoud\(reason, 'unhandled-rejection'\)/.test(shutdown))
  check('uncaughtException routes module-load failures to the loud exit', /process\.on\('uncaughtException', \(err: unknown\) => \{[\s\S]{0,400}if \(isModuleLoadFailure\(err\) && !isShuttingDown\(\)\) \{\s*failLoud\(err, 'uncaught-exception'\)/.test(shutdown))
  check('failLoud restores the terminal, prints the card and force-exits 1', /export function failLoud\([\s\S]*runTerminalRestoration\(\)[\s\S]*MERCURY COULD NOT START[\s\S]*forceExit\(1\)/.test(shutdown))
  check('build.ts carries the runtime-require tripwire', build.includes('RUNTIME-REQUIRE TRIPWIRE') && build.includes('createRequire\\(\\s*import\\.meta\\.url\\s*\\)'))
}

function handleRequiredPackages(): string[] {
  const builtin = new Set(builtinModules)
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (full === join(ROOT, 'src', 'skills', 'bundled')) continue
        walk(full)
      } else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\./.test(name)) {
        files.push(full)
      }
    }
  }
  walk(join(ROOT, 'src'))
  const offenders: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('createRequire(')) continue
    const handles = new Set(
      [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^\n;]*\bcreateRequire\(\s*import\.meta\.url\s*\)/g)].map(m => m[1] as string),
    )
    for (const handle of handles) {
      const call = new RegExp(`(?<![\\w$.])${handle.replace(/\$/g, '\\$')}\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, 'g')
      for (const m of text.matchAll(call)) {
        const spec = m[2] as string
        if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && !builtin.has(spec)) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${handle}('${spec}')`)
        }
      }
    }
  }
  return offenders
}

const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH — the product runtime is the subject of this proof')
  process.exit(1)
}
const work = mkdtempSync(join(tmpdir(), 'boot-crash-surface-'))
const isoHome = join(work, 'home')
const cleanEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: isoHome,
  PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: join(isoHome, '.mercury'),
  ...extra,
})
type Run = { status: number | null; signal: string | null; stdout: string; stderr: string; ms: number }
const run = (args: string[], env: Record<string, string>, timeoutMs: number, cwd = work): Run => {
  const t0 = Date.now()
  const r = spawnSync(nodeBin, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs })
  return { status: r.status, signal: r.signal as string | null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms: Date.now() - t0 }
}
const CARD = 'MERCURY COULD NOT START'

section('§2 — the loud exit under node (a bundle of the real shutdown owner)')
{
  const entry = join(work, 'entry.ts')
  writeFileSync(
    entry,
    [
      `import { failLoud, setupGracefulShutdown } from '${join(ROOT, 'src/utils/gracefulShutdown.ts')}'`,
      `const mode = process.env.PROOF_MODE`,
      `const moduleErr = Object.assign(new Error("Cannot find module 'undici'\\nRequire stack:\\n- /x/runtime/dist/mercury.mjs"), { code: 'MODULE_NOT_FOUND' })`,
      `setupGracefulShutdown()`,
      `const keepAlive = setInterval(() => {}, 1000)`,
      `if (mode === 'reject-module') {`,
      `  void Promise.reject(moduleErr)`,
      `} else if (mode === 'reject-plain') {`,
      `  setTimeout(() => { clearInterval(keepAlive); process.exit(7) }, 1500)`,
      `  void Promise.reject(new Error('background warm-up hiccup'))`,
      `} else if (mode === 'boot-catch') {`,
      `  Promise.reject(new Error('boot seam threw')).catch((error: unknown) => failLoud(error, 'boot'))`,
      `} else if (mode === 'throw-module') {`,
      `  setTimeout(() => { throw moduleErr }, 10)`,
      `}`,
      '',
    ].join('\n'),
  )
  const stub = join(work, 'shutdownRestoration.stub.ts')
  writeFileSync(
    stub,
    'export function cleanupTerminalModes(): void {}\nexport function printResumeHint(): void {}\nexport function drainStdinForExit(): void {}\n',
  )
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    outdir: work,
    naming: 'harness.mjs',
    define: { MACRO: JSON.stringify({ VERSION: '0.0.0-proof' }), 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'stub-shutdown-restoration',
        setup(b) {
          b.onResolve({ filter: /shutdownRestoration\.js$/ }, () => ({ path: stub }))
        },
      },
    ],
  })
  if (!built.success) {
    for (const log of built.logs) console.log(`    ${String(log)}`)
  }
  check('the shutdown owner bundles for node on its own', built.success)
  const harness = join(work, 'harness.mjs')
  if (built.success && existsSync(harness)) {
    const a = run([harness], cleanEnv({ PROOF_MODE: 'reject-module' }), 8000)
    check('a MODULE_NOT_FOUND rejection exits 1', a.status === 1, `status ${a.status} signal ${a.signal}`)
    check('…inside the bound (never an idle)', a.ms < 6000, `${a.ms}ms`)
    check('…with the card: cause names the module, consequence, next, report', a.stderr.includes(CARD) && /cause:\s+Cannot find module 'undici'/.test(a.stderr) && /consequence:/.test(a.stderr) && /next:\s+redeploy the runtime/.test(a.stderr) && /report:\s+\S+crash-\d+-boot\.json/.test(a.stderr), a.stderr.slice(0, 400))

    const b = run([harness], cleanEnv({ PROOF_MODE: 'reject-plain' }), 8000)
    check('a plain background rejection keeps the log-only posture (the session lives on; exit 7 is the harness)', b.status === 7 && !b.stderr.includes(CARD), `status ${b.status} stderr ${b.stderr.slice(0, 120)}`)

    const c = run([harness], cleanEnv({ PROOF_MODE: 'boot-catch' }), 8000)
    check('the boot catch exits 1 with the card for a non-module error', c.status === 1 && c.stderr.includes(CARD) && /cause:\s+Error: boot seam threw/.test(c.stderr) && /next:\s+run again with --debug/.test(c.stderr), `status ${c.status} ${c.stderr.slice(0, 300)}`)
    check('…inside the bound', c.ms < 6000, `${c.ms}ms`)

    const d = run([harness], cleanEnv({ PROOF_MODE: 'throw-module' }), 8000)
    check('a MODULE_NOT_FOUND uncaught exception exits 1 with the card', d.status === 1 && d.stderr.includes(CARD) && /Cannot find module 'undici'/.test(d.stderr), `status ${d.status} ${d.stderr.slice(0, 300)}`)
  }
}

section('§3 — the shipped artifact out of tree: the real boot path, unshimmed and with an injected module-load failure')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    check('dist/mercury.mjs present (run `bun run build.ts`; the build suite prebuilds it)', false)
  } else {
    const iso = join(work, 'iso')
    mkdirSync(iso, { recursive: true })
    mkdirSync(isoHome, { recursive: true })
    copyFileSync(dist, join(iso, 'mercury.mjs'))
    const bundle = join(iso, 'mercury.mjs')

    const plain = run([bundle, 'doctor', '--json'], cleanEnv({ CI: 'true' }), 90_000, iso)
    check('doctor --json out of tree exits 0|3 (init() ran through the bundled transport owners; 3 = the signed-out verdict fault)', plain.status === 0 || plain.status === 3, `status ${plain.status} signal ${plain.signal} ${plain.stderr.slice(0, 300)}`)
    check('…with no module-load failure and no card on stderr', !/Cannot find module|MERCURY COULD NOT START/.test(plain.stderr), plain.stderr.slice(0, 300))

    const shim = join(work, 'missing-module.cjs')
    writeFileSync(
      shim,
      [
        "const Module = require('node:module')",
        'const original = Module.prototype.require',
        'Module.prototype.require = function patched(id) {',
        "  if (id === 'node:tls') {",
        "    const err = new Error(\"Cannot find module 'node:tls' (proof injection: a module the artifact cannot load)\")",
        "    err.code = 'MODULE_NOT_FOUND'",
        '    throw err',
        '  }',
        '  return original.apply(this, arguments)',
        '}',
        '',
      ].join('\n'),
    )
    const pem = join(work, 'extra-ca.pem')
    writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
    const injected = run(['--require', shim, bundle, 'doctor', '--json'], cleanEnv({ CI: 'true', NODE_EXTRA_CA_CERTS: pem }), 30_000, iso)
    check('an injected module-load failure on the real boot path exits 1 (never idles)', injected.status === 1, `status ${injected.status} signal ${injected.signal}`)
    check('…inside the bound', injected.ms < 20_000, `${injected.ms}ms`)
    check('…with the card naming the module and the next action', injected.stderr.includes(CARD) && /Cannot find module 'node:tls'/.test(injected.stderr) && /next:\s+redeploy the runtime/.test(injected.stderr), injected.stderr.slice(0, 400))
  }
}

rmSync(work, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BOOT-CRASH-SURFACE PROOFS PASS')
else console.log(`❌ ${failures} BOOT-CRASH-SURFACE PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

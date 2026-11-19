#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = join(ROOT, 'src', 'services', 'privateChannel', 'verifyArtifactStandalone.ts')
const DIST_VERIFIER = join(ROOT, 'dist', 'verify-artifact.mjs')
const DIST_BUNDLE = join(ROOT, 'dist', 'mercury.mjs')
const DIST_MANIFEST = join(ROOT, 'dist', 'manifest.json')
const SIZE_CEILING_BYTES = 64 * 1024
const MODULES_ALLOWED = [
  'src/services/privateChannel/artifactSigning.ts',
  'src/services/privateChannel/artifactVerify.ts',
  'src/services/privateChannel/payloadDigest.ts',
  'src/services/privateChannel/provenanceNotice.ts',
  'src/services/privateChannel/releaseTarget.ts',
  'src/services/privateChannel/signingTrust.ts',
  'src/services/privateChannel/vendoredPython.ts',
  'src/services/privateChannel/vendoredRuntime.ts',
  'src/services/privateChannel/verifyArtifactStandalone.ts',
]
const EXIT_BY_STATE: Record<string, number> = { signed: 0, unsigned: 3, 'unrecognized-key': 4, tampered: 5, malformed: 6 }
const LEAVE_WITHIN_MS = 10_000

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 the verifier bundle carries the verifier and its own needs: every module under src/services/privateChannel, from a fixed list, nothing from node_modules')
{
  const built = await Bun.build({
    entrypoints: [ENTRY],
    target: 'node',
    format: 'esm',
    minify: true,
    metafile: true,
    define: { MACRO: JSON.stringify({ VERSION: '1.0.0' }), 'process.env.NODE_ENV': JSON.stringify('production') },
  })
  check('the entry builds', built.success, built.logs.map(l => String(l)).join(' | '))
  const inputs = Object.keys(built.metafile?.inputs ?? {}).map(p => relative(ROOT, resolve(process.cwd(), p)).split('\\').join('/'))
  const outside = inputs.filter(p => !p.startsWith('src/services/privateChannel/'))
  check('no module outside src/services/privateChannel is bundled (the product substrate, config, git, flag registry and lodash stay out)', outside.length === 0, outside.slice(0, 12).join(' · '))
  const unlisted = inputs.filter(p => !MODULES_ALLOWED.includes(p))
  check(`every bundled module is on the list of ${MODULES_ALLOWED.length} the verifier may carry`, unlisted.length === 0, unlisted.join(' · '))
  check('the list is exact: each listed module is bundled (a stale row is red)', MODULES_ALLOWED.every(p => inputs.includes(p)), MODULES_ALLOWED.filter(p => !inputs.includes(p)).join(' · '))
  check('no node_modules input', !inputs.some(p => p.includes('node_modules')), inputs.filter(p => p.includes('node_modules')).join(' · '))
  const sourceBytes = Object.values(built.metafile?.inputs ?? {}).reduce((sum, v) => sum + v.bytes, 0)
  check(`the bundled source stays under 96 KiB (${sourceBytes} bytes over ${inputs.length} modules)`, sourceBytes < 96 * 1024)
}

section('§2 the shipped file: dist/verify-artifact.mjs under its ceiling, self-contained')
if (!existsSync(DIST_VERIFIER)) check('dist/verify-artifact.mjs is built', false, 'run bun run build.ts first')
else {
  const bytes = statSync(DIST_VERIFIER).size
  check(`dist/verify-artifact.mjs is ${bytes} bytes, under the ${SIZE_CEILING_BYTES}-byte ceiling (it shipped at 566,638 bytes in 1.0.0-beta.40 carrying 211 modules)`, bytes <= SIZE_CEILING_BYTES)
  const text = readFileSync(DIST_VERIFIER, 'utf8')
  const bare = new Bun.Transpiler({ loader: 'js' }).scanImports(text).map(i => i.path).filter(p => !p.startsWith('node:'))
  check('every import is a node: builtin', bare.length === 0, bare.join(' · '))
  check('the file carries no file watcher, interval or stdin reader that could hold the loop', !/\bwatchFile\(|\bsetInterval\(|process\.stdin\b/.test(text))
}

section('§3 the verifier prints its verdict and leaves at once, in every mode, with the exit code of the state')
type Run = { code: number | null; signal: string | null; out: string; err: string; ms: number }
const runVerifier = (args: string[], env: Record<string, string> = {}): Promise<Run> =>
  new Promise(resolveRun => {
    const started = Date.now()
    const child = spawn('node', [DIST_VERIFIER, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += String(chunk)))
    child.stderr.on('data', chunk => (err += String(chunk)))
    const guard = setTimeout(() => child.kill('SIGKILL'), LEAVE_WITHIN_MS)
    child.on('close', (code, signal) => {
      clearTimeout(guard)
      resolveRun({ code, signal, out, err, ms: Date.now() - started })
    })
  })
if (!existsSync(DIST_VERIFIER) || !existsSync(DIST_BUNDLE) || !existsSync(DIST_MANIFEST)) check('the dist payload is built', false, 'run bun run build.ts first')
else {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'verifier-bundle-')))
  const payload = join(scratch, 'payload')
  mkdirSync(payload, { recursive: true })
  for (const name of ['manifest.json', 'mercury.mjs', 'verify-artifact.mjs']) copyFileSync(join(ROOT, 'dist', name), join(payload, name))
  const json = await runVerifier(['--json', '--deep', '--dir', payload])
  let state = ''
  try {
    state = String((JSON.parse(json.out) as { verdict?: { state?: string } }).verdict?.state ?? '')
  } catch {
    state = ''
  }
  check(`--json --deep: the verdict parses (state '${state}') and the process left in ${json.ms} ms`, state !== '' && json.signal === null && json.ms < LEAVE_WITHIN_MS, `code=${String(json.code)} signal=${String(json.signal)} out=${json.out.slice(0, 160)} err=${json.err.slice(0, 160)}`)
  check('…with the exit code of its state', json.code === EXIT_BY_STATE[state], `code=${String(json.code)} state=${state}`)
  const plain = await runVerifier(['--dir', payload])
  check(`plain: the verdict line prints and the process left in ${plain.ms} ms with the same code`, /artifact provenance \(fast\)/.test(plain.out) && plain.code === EXIT_BY_STATE[state] && plain.signal === null, `code=${String(plain.code)} out=${plain.out.slice(0, 160)}`)
  const launcher = await runVerifier(['--launcher', '--dir', payload])
  check(`--launcher: exit 0 always, one stderr line unless signed, left in ${launcher.ms} ms`, launcher.code === 0 && launcher.signal === null && (state === 'signed' ? launcher.err === '' : state === 'unsigned' ? launcher.err === 'mercury: this installation is unsigned — mercury health\n' : /^mercury: provenance — /.test(launcher.err)), `code=${String(launcher.code)} err=${launcher.err.slice(0, 160)}`)
  const beside = join(payload, 'verify-artifact.mjs')
  const selfDir = await new Promise<Run>(resolveRun => {
    const started = Date.now()
    const child = spawn('node', [beside, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => (out += String(chunk)))
    child.stderr.on('data', chunk => (err += String(chunk)))
    const guard = setTimeout(() => child.kill('SIGKILL'), LEAVE_WITHIN_MS)
    child.on('close', (code, signal) => {
      clearTimeout(guard)
      resolveRun({ code, signal, out, err, ms: Date.now() - started })
    })
  })
  check(`run from inside the payload with no --dir (the launcher's and the smoke's shape): the verdict names that dir and the process left in ${selfDir.ms} ms`, selfDir.signal === null && selfDir.out.includes(`"dir": "${payload}"`) && selfDir.code === EXIT_BY_STATE[state], `code=${String(selfDir.code)} out=${selfDir.out.slice(0, 200)}`)
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\nprove-verifier-bundle: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-verifier-bundle: all green')

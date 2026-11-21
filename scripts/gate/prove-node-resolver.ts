#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-node-resolver.ts'
const LOOKED_FOR = 'node on PATH or MERCURY_NODE'
const SPELLING_FIX = 'the SPELLINGS pattern for this case in scripts/gate/prove-node-resolver.ts reads the sample wrongly; fix that pattern'
const NODE_LIB_FIX = 'fix nodeBinPath in scripts/lib/nodeBin.ts'
const GUARD_LIB_FIX = 'fix requireLiveDaemon in scripts/lib/nodeBin.ts'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const SPELLINGS: Array<{ name: string; re: RegExp }> = [
  { name: 'a which/where child asked for node', re: /['"](?:which|where)(?:\.exe)?['"]\s*,\s*\[\s*['"]node['"]/ },
  { name: 'a shell -c string resolving node', re: /['"]-l?c['"]\s*,\s*['"`][^'"`]*\b(?:which|where|command -v)\s+node\b/ },
  { name: 'an exec string resolving node', re: /\bexec(?:Sync)?\(\s*['"`](?:which|where|command -v)\s+node\b/ },
  { name: 'Bun.which(node) falling back to the running Bun', re: /Bun\.which\(\s*['"]node['"]\s*\)\s*\?\?\s*process\.execPath/ },
]
const spelled = (text: string): string[] => SPELLINGS.filter(s => s.re.test(text)).map(s => s.name)

section('§0 the detectors read each spelling and leave the honest ones alone')
check('spawnSync(which, [node])', spelled("spawnSync('which', ['node'], { encoding: 'utf8' })").length === 1, SPELLING_FIX)
check('where.exe on the Windows road is the same spelling', spelled('spawnSync("where.exe", ["node"])').length === 1, SPELLING_FIX)
check('sh -c command -v node', spelled("execFileSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' })").length === 1, SPELLING_FIX)
check('bash -lc which node', spelled("spawnSync('bash', ['-lc', 'which node'])").length === 1, SPELLING_FIX)
check('execSync(which node)', spelled("execSync('which node').toString()").length === 1, SPELLING_FIX)
check('Bun.which(node) ?? process.execPath', spelled("const nodeBin = Bun.which('node') ?? process.execPath").length === 1, SPELLING_FIX)
check('a which for git is not node', spelled("spawnSync('which', ['git'], { encoding: 'utf8' })").length === 0, SPELLING_FIX)
check('a census reading the launcher text for command -v node is not a resolution', spelled("check('…', opsLive.includes('command -v node'))").length === 0, SPELLING_FIX)
check('a vendored-first fallback to the PATH name is not the Bun fallback', spelled("const NODE = existsSync(VENDORED) ? VENDORED : (Bun.which('node') ?? 'node')").length === 0, SPELLING_FIX)
check('the shared resolver itself spells none of them', spelled(readFileSync(join(ROOT, 'scripts', 'lib', 'nodeBin.ts'), 'utf8')).length === 0, 'scripts/lib/nodeBin.ts itself spells a node lookup that the census forbids; resolve node there without which, where, a shell lookup or Bun.which')

section('§1 the census: no file under scripts/ resolves node through which, where, a shell lookup or a Bun fallback')
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && file !== SELF)
const offenders: string[] = []
for (const file of tracked) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const found = spelled(text)
  if (found.length === 0) continue
  const line = text.split('\n').findIndex(l => SPELLINGS.some(s => s.re.test(l))) + 1
  offenders.push(`${file}:${line} (${found.join('; ')})`)
}
check(`the census read the estate (${tracked.length} files)`, tracked.length > 3000, `the file list from git ls-files under scripts/ is too short (run the proof from a checkout with the whole scripts/ tree tracked); read ${tracked.length}`)
check('zero resolver spellings outside the shared library (resolve node through scripts/lib/nodeBin.ts)', offenders.length === 0, `replace each listed which, where, shell lookup or Bun.which(node) fallback with nodeBinPath from scripts/lib/nodeBin.ts:\n    ${offenders.join('\n    ')}`)

const throwsNaming = (run: () => unknown, words: string[]): { ok: boolean; detail: string } => {
  try {
    const value = run()
    return { ok: false, detail: `returned ${String(value)}` }
  } catch (error) {
    const message = (error as Error).message
    return { ok: words.every(w => message.includes(w)), detail: message }
  }
}
const envWithPath = (path: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH' && key !== 'MERCURY_NODE') env[key] = value
  env.PATH = path
  return env
}

section('§2 the library: an existing Node here, MERCURY_NODE first, and a loud refusal when nothing answers')
const scratch = mkdtempSync(join(tmpdir(), 'node-resolver-'))
try {
  const here = nodeBinPath()
  check('the resolved path is an absolute existing regular file', isAbsolute(here) && statSync(here).isFile(), `${NODE_LIB_FIX} so it returns an absolute path to an existing file; got ${here}`)
  const answers = spawnSync(here, ['-p', 'JSON.stringify([process.versions.node, process.versions.bun || null])'], { encoding: 'utf8' })
  check('…and it is Node, not Bun: it prints its own version and no Bun version on -p', answers.status === 0 && /^\["\d+\.\d+\.\d+[^"]*",null\]$/.test(answers.stdout.trim()), `status=${answers.status} out=${answers.stdout.trim()} err=${answers.stderr.trim().slice(0, 200)} (${NODE_LIB_FIX} so the file it returns is Node, not Bun)`)
  check('a second call answers the same path', nodeBinPath() === here, `${NODE_LIB_FIX} so a second call returns the same path`)
  check('MERCURY_NODE naming an existing Node is honoured first', nodeBinPath({ ...process.env, MERCURY_NODE: here }) === here, `${NODE_LIB_FIX} so a MERCURY_NODE naming an existing Node is returned first`)
  const pinnedBun = throwsNaming(() => nodeBinPath({ ...process.env, MERCURY_NODE: process.execPath }), ['MERCURY_NODE', 'is Bun', LOOKED_FOR])
  check('MERCURY_NODE naming the running Bun is refused by name (a pin is probed for identity like a PATH node)', pinnedBun.ok, `${NODE_LIB_FIX} to throw naming MERCURY_NODE, is Bun and the lookup words; got ${pinnedBun.detail}`)
  const notARuntime = join(scratch, 'not-a-runtime')
  writeFileSync(notARuntime, 'plain text, not a program\n')
  const text = throwsNaming(() => nodeBinPath({ ...process.env, MERCURY_NODE: notARuntime }), ['MERCURY_NODE', LOOKED_FOR])
  check('MERCURY_NODE naming a regular file that is no runtime refuses (the identity probe cannot run it)', text.ok, `${NODE_LIB_FIX} to throw naming MERCURY_NODE and the lookup words when the file cannot be run; got ${text.detail}`)
  const absent = join(scratch, 'absent-node')
  const missing = throwsNaming(() => nodeBinPath({ ...process.env, MERCURY_NODE: absent }), ['MERCURY_NODE', absent, LOOKED_FOR])
  check('a pinned-but-missing MERCURY_NODE refuses by name even with node on PATH (no silent fallback, as the launchers refuse)', missing.ok, `${NODE_LIB_FIX} to throw naming MERCURY_NODE and the missing path, with no fallback to PATH; got ${missing.detail}`)
  const folder = throwsNaming(() => nodeBinPath({ ...process.env, MERCURY_NODE: scratch }), ['MERCURY_NODE', LOOKED_FOR])
  check('MERCURY_NODE naming a folder refuses', folder.ok, `${NODE_LIB_FIX} to throw naming MERCURY_NODE when it names a folder; got ${folder.detail}`)
  const shim = join(scratch, 'node.cmd')
  writeFileSync(shim, '@echo off\r\n')
  const cmd = throwsNaming(() => nodeBinPath({ ...process.env, MERCURY_NODE: shim }), ['MERCURY_NODE', LOOKED_FOR])
  check('MERCURY_NODE naming a .cmd shim refuses (a shim is never the runtime a proof spawns)', cmd.ok, `${NODE_LIB_FIX} to throw naming MERCURY_NODE when it names a .cmd shim; got ${cmd.detail}`)
  const empty = join(scratch, 'empty')
  mkdirSync(empty)
  const nothing = throwsNaming(() => nodeBinPath(envWithPath(empty)), ['no node found', LOOKED_FOR])
  check('an empty PATH and no MERCURY_NODE: one line naming what was looked for', nothing.ok, `${NODE_LIB_FIX} to throw one line with no node found and the lookup words when PATH has no node; got ${nothing.detail}`)
  const bunAsNode = join(scratch, 'bun-as-node')
  mkdirSync(bunAsNode)
  const fakeNode = join(bunAsNode, process.platform === 'win32' ? 'node.exe' : 'node')
  if (process.platform === 'win32') copyFileSync(process.execPath, fakeNode)
  else symlinkSync(process.execPath, fakeNode)
  const bun = throwsNaming(() => nodeBinPath(envWithPath(bunAsNode)), ['is Bun', LOOKED_FOR])
  check('a node on PATH that answers as Bun is refused by name (the runtime a proof spawns is never the proof\'s own Bun)', bun.ok, `${NODE_LIB_FIX} to throw naming is Bun when the node on PATH answers as Bun; got ${bun.detail}`)

  section('§3 a proof whose node is unresolved ends before it can spawn anything')
  const stub = join(scratch, 'probe.ts')
  writeFileSync(stub, `import { nodeBinPath } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'nodeBin.ts'))}\nconst node = nodeBinPath()\nconsole.log('SPAWNING ' + node)\n`)
  const died = spawnSync(process.execPath, [stub], { encoding: 'utf8', cwd: scratch, env: { ...envWithPath(empty), MERCURY_NODE: absent }, timeout: 60_000 })
  check('non-zero exit, the one line on stderr, and nothing reached the spawn', died.status !== 0 && died.stderr.includes(LOOKED_FOR) && !died.stdout.includes('SPAWNING'), `${NODE_LIB_FIX} so an unresolved node throws before the caller spawns anything; status=${died.status} out=${died.stdout.trim()} err=${died.stderr.trim().slice(0, 300)}`)
  const lived = spawnSync(process.execPath, [stub], { encoding: 'utf8', cwd: scratch, timeout: 60_000 })
  check('control: with node on PATH the same proof reaches its spawn with the resolved file', lived.status === 0 && lived.stdout.startsWith(`SPAWNING ${here}`), `${NODE_LIB_FIX} so a node on PATH resolves to the same file; status=${lived.status} out=${lived.stdout.trim()} err=${lived.stderr.trim().slice(0, 300)}`)

  section('§4 requireLiveDaemon: a proof whose own daemon is not live ends before any connector call, and leaves no child behind')
  const daemonDir = join(scratch, 'no-daemon')
  mkdirSync(daemonDir)
  const guardStub = join(scratch, 'guard-probe.ts')
  writeFileSync(guardStub, [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    "import { spawn } from 'node:child_process'",
    `import { requireLiveDaemon } from ${JSON.stringify(join(ROOT, 'scripts', 'lib', 'nodeBin.ts'))}`,
    'const mode = process.argv[2]',
    `const child = mode === 'no-pid' ? spawn(${JSON.stringify(join(scratch, 'no-such-daemon'))}, []) : mode === 'ended' ? spawn(process.execPath, ['-e', 'process.exit(3)']) : spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])`,
    "console.log('CHILD ' + child.pid)",
    "const pid = await requireLiveDaemon(child, { what: 'guard-probe ' + mode, timeoutMs: 1500 })",
    "console.log('CONTINUED ' + pid)",
    '',
  ].join('\n'))
  const guardEnv = { ...process.env, MERCURY_DAEMON_DIR: daemonDir, MERCURY_CONFIG_DIR: join(scratch, 'guard-home') }
  mkdirSync(guardEnv.MERCURY_CONFIG_DIR)
  const guarded = (mode: string) => spawnSync(process.execPath, [guardStub, mode], { encoding: 'utf8', cwd: scratch, env: guardEnv, timeout: 60_000 })
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const noPid = guarded('no-pid')
  check('a spawn that gave no pid: exit 1, the line says so, nothing continued', noPid.status === 1 && noPid.stderr.includes('did not spawn (no pid)') && !noPid.stdout.includes('CONTINUED'), `${GUARD_LIB_FIX} to exit 1 with did not spawn (no pid) before the caller continues; status=${noPid.status} out=${noPid.stdout.trim()} err=${noPid.stderr.trim().slice(0, 300)}`)
  const ended = guarded('ended')
  check('a child that ended before answering: exit 1 naming its exit code, nothing continued', ended.status === 1 && ended.stderr.includes('ended with 3 before answering') && !ended.stdout.includes('CONTINUED'), `${GUARD_LIB_FIX} to exit 1 naming the exit code of a child that ended before answering; status=${ended.status} out=${ended.stdout.trim()} err=${ended.stderr.trim().slice(0, 300)}`)
  const silent = guarded('silent')
  const silentPid = Number(/CHILD (\d+)/.exec(silent.stdout)?.[1] ?? 0)
  check('a live child that never answers on the control socket: exit 1 within the bound, nothing continued', silent.status === 1 && silent.stderr.includes('did not answer on the control socket within 1500 ms') && !silent.stdout.includes('CONTINUED'), `${GUARD_LIB_FIX} to exit 1 after the timeout when the child never answers on the control socket; status=${silent.status} out=${silent.stdout.trim()} err=${silent.stderr.trim().slice(0, 300)}`)
  check('…and the guard took that child down with it', silentPid > 0 && !alive(silentPid), `${GUARD_LIB_FIX} to kill the silent child before it exits; pid ${silentPid} alive=${silentPid > 0 && alive(silentPid)}`)
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? '\nNODE RESOLVER: ALL PASS' : `\nNODE RESOLVER: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

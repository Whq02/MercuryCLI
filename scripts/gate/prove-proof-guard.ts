import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

const root = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..'))
const guard = join(root, 'scripts/lib/proofGuard.cjs')
const subject = join(root, 'scripts/gate/proofGuardSubject.ts')
const node = Bun.which('node') ?? 'node'
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const section = (title: string) => console.log(`\n── ${title}`)

if (process.platform === 'win32') {
  console.log('the proof guard is installed on POSIX only, nothing driven here')
  process.exit(0)
}

const SUITE_OWNED = ['NODE_OPTIONS', 'BUN_OPTIONS', 'MERCURY_SUITE_TMPDIR', 'MERCURY_PROCESS_LEDGER_DIR', 'MERCURY_SUITE_RUNNER_PID', 'MERCURY_SUITE_SCRIPT', 'MERCURY_SUITE_OF_ONE', 'MERCURY_SUITE_GUARDED', 'MERCURY_SUITE_LIBC', 'MERCURY_TMPDIR']
const clean = Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([name]) => !SUITE_OWNED.includes(name) && !name.startsWith('BASH_FUNC_')))
const base = mkdtempSync(join(realpathSync('/tmp'), 'ppg-'))
const token = `${process.pid}.${Date.now().toString(36)}`
type Tried = { shape: string; outcome: string; stands: boolean; error?: { code: unknown; syscall: unknown; path: unknown } }
type Facts = { guarded: string[] | null; refused?: Tried[]; underNode?: Tried[]; allowed?: Tried[]; runs?: Array<{ name: string; status: number | null; refusals: string[]; stands: boolean }>; environment?: { home: boolean; cache: boolean } }
const world = (name: string): string => {
  const at = join(base, name)
  mkdirSync(join(at, 'account', 'root', 'session'), { recursive: true })
  for (const folder of ['account/sibling', 'swap-foreign', 'spare', 'tmp']) mkdirSync(join(at, folder))
  for (const file of ['account/root/kept', 'account/root/session/file', 'account/sibling/file', 'swap-foreign/file']) writeFileSync(join(at, file), 'made by the proof\n')
  writeFileSync(join(at, 'made-here'), token)
  symlinkSync(join(at, 'account'), join(at, 'alias'))
  symlinkSync(join(at, 'account', 'root'), join(at, 'to-root'))
  symlinkSync(join(at, 'account', 'missing'), join(at, 'to-missing'))
  symlinkSync(join(at, 'to-missing'), join(at, 'to-to-missing'))
  return at
}
const named = (at: string): string => [join(at, 'account', 'root'), join(at, 'account', 'missing')].join(delimiter)
const drive = (name: string, alter: (env: Record<string, string>, at: string) => Record<string, string> = env => env): { at: string; code: number | null; said: string; facts: Facts | undefined } => {
  const at = world(name)
  const receipt = join(at, 'facts.json')
  const run = spawnSync(process.execPath, [subject, receipt, name, at, token], { cwd: root, env: alter({ ...clean, TMPDIR: join(at, 'tmp'), MERCURY_SUITE_GUARDED: named(at) }, at), encoding: 'utf8', timeout: 180_000 })
  return { at, code: run.status, said: `${run.stdout}${run.stderr}`, facts: existsSync(receipt) ? (JSON.parse(readFileSync(receipt, 'utf8')) as Facts) : undefined }
}
const stillStands = (at: string): boolean => existsSync(join(at, 'account', 'root', 'kept')) && !existsSync(join(at, 'account', 'missing'))
const refusalLines = (said: string): string[] => said.split('\n').filter(line => line.startsWith('proof guard:') && line.includes(' refused: '))

try {
  section('the call of 12:21 as written, against a stand-in root: a child the proof starts with no env option, from another folder, removes the temp root a function handed it and links another folder over it')
  {
    const run = drive('incident')
    const runs = run.facts?.runs ?? []
    const standIn = join(run.at, 'account', 'root')
    check('the scene ran: four children, each in a folder with no bunfig.toml, none given an environment', run.code === 0 && runs.length === 4, `rc=${run.code} runs=${runs.length} ${run.said.slice(-600)}`)
    const [written, careless, absent, underNode] = runs
    check('bun, the two calls as written: the removal is refused, the child ends red, the root stands with what it held', written !== undefined && written.status !== 0 && written.stands && written.refusals.length === 1 && written.refusals[0] === `proof guard: rmSync refused: ${standIn}/ is a guarded root (${standIn}); a proof removes, renames and links over only what its own run made`, JSON.stringify(written))
    check("bun, the removal's error swallowed as a careless cleanup would: the link over the root is refused too, and both refusals are still read on stderr", careless !== undefined && careless.status !== 0 && careless.stands && careless.refusals.length === 2 && careless.refusals[0]!.includes('rmSync refused') && careless.refusals[1]!.includes(`symlinkSync refused: ${standIn}/ is a guarded root`), JSON.stringify(careless))
    check('bun, nothing standing where a root would be: the removal has nothing to do, the link that would plant a root there is refused', absent !== undefined && absent.status !== 0 && absent.stands && absent.refusals.length === 1 && absent.refusals[0]!.includes(`symlinkSync refused: ${join(run.at, 'account', 'missing')}/ is a guarded root`), JSON.stringify(absent))
    check('node, the two calls as written: refused the same way', underNode !== undefined && underNode.status !== 0 && underNode.stands && underNode.refusals.length === 1 && underNode.refusals[0]!.includes('rmSync refused'), JSON.stringify(underNode))
    check('after all four the stand-in root is the folder the proof made, and no link stands beside it', stillStands(run.at))
  }

  section('every way a proof process reaches a root: each call is refused before it touches anything')
  {
    const run = drive('shapes')
    const refused = run.facts?.refused ?? []
    const allowed = run.facts?.allowed ?? []
    const standIn = join(run.at, 'account', 'root')
    const wrong = refused.filter(tried => tried.outcome !== 'refused' || !tried.stands)
    check(`${refused.length} calls that remove, rename or link over the root, the folder that holds it or the place it would stand are refused, the root untouched after each`, run.code === 0 && refused.length >= 27 && wrong.length === 0, `rc=${run.code} ${JSON.stringify(wrong)} ${run.facts === undefined ? run.said.slice(-600) : ''}`)
    check('a place where a root would stand is judged where the filesystem puts it: spelled through a link to the root and "..", the link, the hard link and the rename are refused', ['symlinkSync where a root would stand, spelled through a link to the root and ..', 'linkSync there, spelled the same way', 'renameSync, a folder moved there, spelled the same way'].every(shape => refused.some(tried => tried.shape === shape && tried.outcome === 'refused' && tried.stands)), JSON.stringify(refused.filter(tried => tried.shape.includes('spelled')).map(tried => `${tried.shape}: ${tried.outcome}`)))
    const refusedAs = (shape: string): boolean => refused.some(tried => tried.shape === shape && tried.outcome === 'refused' && tried.stands)
    const underNode = run.facts?.underNode ?? []
    check('a path is read in every form the runtime takes, as the bytes it will use: a Uint8Array that is no Buffer, a DataView, an ArrayBuffer and a String object are refused, and under node a Uint8Array and a plain object shaped like a file URL', ['rmSync, a Uint8Array that is no Buffer', 'promises.rm, a Uint8Array', 'renameSync, the root as a Uint8Array, moved away', 'symlinkSync where a root would stand, the place a Uint8Array', 'rmSync, a DataView', 'rmSync, an ArrayBuffer', 'rmSync, a String object'].every(refusedAs) && underNode.length === 2 && underNode.every(tried => tried.outcome === 'refused' && tried.stands), JSON.stringify([...refused.filter(tried => /Uint8Array|DataView|ArrayBuffer|String object/.test(tried.shape)), ...underNode].map(tried => `${tried.shape}: ${tried.outcome}`)))
    check('a value the guard does not read and a path it cannot check are refused, each with its sentence, and neither goes through', refusedAs('rmSync, a value that is no path') && refusedAs('rmSync, a name longer than the system reads, which no check can look at') && run.said.includes('proof guard: rmSync refused: its path is a value the guard does not read (Object); a call whose path the guard cannot judge does not go through') && /proof guard: rmSync refused: \S+ could not be checked \([^)]*\); a call whose path the guard cannot judge does not go through/.test(run.said), JSON.stringify(refused.filter(tried => /no path|no check/.test(tried.shape)).map(tried => `${tried.shape}: ${tried.outcome}`)))
    check('a link under a trailing separator is followed to where the call lands: a folder renamed onto a link to the place a root would stand, onto a second link to that link, and with the separator written twice is refused each time', ['renameSync, a folder moved onto a link to the place a root would stand, spelled with a trailing separator', 'renameSync there through a second link to that link', 'renameSync there, the separator written twice'].every(refusedAs), JSON.stringify(refused.filter(tried => tried.shape.includes('link to')).map(tried => `${tried.shape}: ${tried.outcome}`)))
    check('named, default, namespace, required and dynamic imports, the callback and both promise forms, a Buffer and a file URL are among them', ['a named import', 'the default import', 'the namespace import', 'require', 'a dynamic import', 'a Buffer path', 'a file URL', 'rm with a callback', 'promises.rm', 'rm from node:fs/promises'].every(word => refused.some(tried => tried.shape.includes(word))), refused.map(tried => tried.shape).join(' · '))
    const first = refused[0]?.error
    check('the refusal is an error a caller can read: its code, the call and the path', first?.code === 'EPROOFGUARD' && first.syscall === 'rmSync' && first.path === standIn, JSON.stringify(first))
    const lines = refusalLines(run.said)
    check('every refusal is also one line on stderr, so an error a cleanup swallows is still read', lines.length === refused.length && lines.some(line => line === `proof guard: rmSync refused: ${join(run.at, 'account')} holds a guarded root (${standIn}); a proof removes, renames and links over only what its own run made`), `${lines.length} lines for ${refused.length} refusals`)
    const stopped = allowed.filter(tried => tried.outcome !== 'went through' || !tried.stands)
    check(`a clean inside a root stays allowed: ${allowed.length} calls inside the root, beside it and on a link to it go through, the root left standing`, allowed.length >= 8 && stopped.length === 0, JSON.stringify(stopped))
    check('the root is empty and still there, the folder beside it and the link to it are gone', existsSync(standIn) && !existsSync(join(standIn, 'kept')) && !existsSync(join(run.at, 'account', 'sibling')) && !existsSync(join(run.at, 'to-root')))
  }

  section("the account's own roots are guarded whatever the environment says, and a stand-in for any of them is not")
  {
    const uid = process.getuid!()
    const record = spawnSync(node, ['-p', "require('node:os').userInfo().homedir"], { encoding: 'utf8' })
    const home = record.stdout.trim()
    const cache = join(home, ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'mercury-nodejs')
    const expected = [join(realpathSync('/tmp'), `mercury-${uid}`), join(realpathSync(home), '.mercury'), cache, join(cache, `mercury-${uid}`)]
    const run = drive('roots', (env, at) => ({ ...env, HOME: join(at, 'stand-in-home'), XDG_CACHE_HOME: join(at, 'stand-in-cache'), MERCURY_CONFIG_DIR: join(at, 'stand-in-home', '.mercury') }))
    const guarded = run.facts?.guarded ?? []
    const realParent = (path: string): string => {
      try {
        return join(realpathSync(resolve(path, '..')), path.slice(resolve(path, '..').length + 1))
      } catch {
        return path
      }
    }
    check("the guard's list opens with the account's temp root, config home, cache home and the session folders inside it, read from the account record and the uid", record.status === 0 && home !== '' && guarded.slice(0, 4).join('\n') === expected.map(realParent).join('\n'), `${JSON.stringify(guarded.slice(0, 4))} against ${JSON.stringify(expected.map(realParent))}`)
    check('the run was started with HOME and XDG_CACHE_HOME pointed at stand-ins, and the list did not follow them', run.facts?.environment?.home === true && run.facts.environment.cache === true && !guarded.some(path => path.startsWith(join(run.at, 'stand-in'))), JSON.stringify(run.facts?.environment))
    check('the two paths the proof named follow the four', guarded.slice(4).join(delimiter) === named(run.at), JSON.stringify(guarded.slice(4)))
    const stopped = (run.facts?.allowed ?? []).filter(tried => tried.outcome !== 'went through')
    check("a stand-in home's config folder, a stand-in cache home, the stand-in home itself and a link under the temp root's name in another folder are the proof's own: every call goes through", run.code === 0 && (run.facts?.allowed ?? []).length === 5 && stopped.length === 0 && refusalLines(run.said).length === 0, `rc=${run.code} ${JSON.stringify(stopped)} ${refusalLines(run.said).join(' | ')}`)
  }

  section('the suite road: a process a suite starts in another folder is guarded through the preload the suite exports, with none of this run\'s own options in its environment')
  {
    const at = world('suite')
    const receipt = join(at, 'suite-receipt')
    const standIn = join(at, 'account', 'root')
    for (const [file, opening] of [['attempt.cjs', "const { realpathSync, rmSync, appendFileSync, existsSync } = require('node:fs'); const { dirname, join, sep } = require('node:path');"], ['attempt.mjs', "import { realpathSync, rmSync, appendFileSync, existsSync } from 'node:fs'; import { dirname, join, sep } from 'node:path';"]] as const) {
      writeFileSync(join(at, file), `${opening}
const [target, world, receipt, name] = process.argv.slice(2)
if (!realpathSync(dirname(target)).startsWith(realpathSync(world) + sep)) process.exit(64)
let outcome = 'went through'
try { rmSync(target, { recursive: true, force: true }) } catch (error) { outcome = error.code === 'EPROOFGUARD' ? 'refused' : 'failed ' + error.code }
appendFileSync(receipt, name + ': ' + outcome + ' · root stands ' + existsSync(join(target, 'kept')) + '\\n')
`)
    }
    const runner = join(at, 'run-all.sh')
    writeFileSync(runner, `#!/usr/bin/env bash\n# gate-class: pure\nset -eu\n. ${JSON.stringify(join(root, 'scripts/lib/suite-env.sh'))}\nsuite_env_guard "$0"\ncd ${JSON.stringify(join(at, 'spare'))}\n${JSON.stringify(node)} ${JSON.stringify(join(at, 'attempt.cjs'))} ${JSON.stringify(standIn)} ${JSON.stringify(at)} ${JSON.stringify(receipt)} 'node, require' || true\n"${process.execPath}" ${JSON.stringify(join(at, 'attempt.cjs'))} ${JSON.stringify(standIn)} ${JSON.stringify(at)} ${JSON.stringify(receipt)} 'bun, require' || true\n"${process.execPath}" ${JSON.stringify(join(at, 'attempt.mjs'))} ${JSON.stringify(standIn)} ${JSON.stringify(at)} ${JSON.stringify(receipt)} 'bun, a named import' || true\n`)
    const run = spawnSync('bash', [runner], { cwd: root, env: { ...clean, TMPDIR: join(at, 'tmp'), MERCURY_SUITE_GUARDED: named(at) }, encoding: 'utf8', timeout: 120_000 })
    const lines = existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n') : []
    check('node and bun, required and named: three removals of the root refused, the root standing', run.status === 0 && lines.length === 3 && lines.every(line => line.endsWith(': refused · root stands true')) && stillStands(at), `rc=${run.status} ${JSON.stringify(lines)} ${run.stderr.slice(-400)}`)
  }

  section('a guard that could not be installed says so, and the process goes on')
  {
    const at = world('unarmed')
    const freeze = join(at, 'freeze.cjs')
    writeFileSync(freeze, "Object.freeze(require('node:fs'))\n")
    const frozen = spawnSync(node, ['--require', freeze, '--require', guard, '-e', "console.log('alive')"], { cwd: at, env: { ...clean, MERCURY_SUITE_OF_ONE: 'held' }, encoding: 'utf8' })
    check('node with a frozen fs: one line on stderr with why and what this process can now do, and the script runs', frozen.status === 0 && frozen.stdout === 'alive\n' && frozen.stderr === "proof guard: not installed (fs.rmSync could not be replaced); this process can remove, rename and link over the account's own temp root, config home and cache home\n", `rc=${frozen.status} ${JSON.stringify(frozen.stdout)} ${frozen.stderr}`)
    const list = "console.log(JSON.stringify(globalThis[Symbol.for('mercury.proof.guard')] ?? null))"
    const homeless = spawnSync(process.execPath, ['-e', list], { cwd: at, env: { ...clean, MERCURY_SUITE_OF_ONE: 'held', MERCURY_SUITE_LIBC: join(at, 'no-such-library'), BUN_OPTIONS: `"--preload=${guard}"` }, encoding: 'utf8' })
    check("bun with no library to read the account record through: one line says the home's two roots are not guarded here, and the temp root still is", homeless.status === 0 && homeless.stderr === `proof guard: the account's home could not be read (${join(at, 'no-such-library')} did not open); its config home and cache home are not guarded in this process\n` && homeless.stdout.trim() === JSON.stringify([join(realpathSync('/tmp'), `mercury-${process.getuid!()}`)]), `rc=${homeless.status} ${homeless.stdout} ${homeless.stderr}`)
    const armed = spawnSync(process.execPath, ['-e', list], { cwd: at, env: { ...clean, MERCURY_SUITE_OF_ONE: 'held', BUN_OPTIONS: `"--preload=${guard}"` }, encoding: 'utf8' })
    check('control: the same start with the library in place says nothing and guards four roots', armed.status === 0 && armed.stderr === '' && (JSON.parse(armed.stdout || 'null') as string[] | null)?.length === 4, `rc=${armed.status} ${armed.stdout} ${armed.stderr}`)
  }

  section('a process that is no proof is left alone: an entry outside scripts/, started with no mark of a proof run')
  {
    const at = world('plain')
    writeFileSync(join(at, 'bunfig.toml'), `preload = [${JSON.stringify(guard)}]\n`)
    writeFileSync(join(at, 'entry.mjs'), `import { realpathSync, rmSync, existsSync } from 'node:fs'
import { dirname, sep } from 'node:path'
const [target, world] = process.argv.slice(2)
if (!realpathSync(dirname(target)).startsWith(realpathSync(world) + sep)) process.exit(64)
rmSync(target, { recursive: true, force: true })
console.log(JSON.stringify({ guarded: globalThis[Symbol.for('mercury.proof.guard')] ?? null, stands: existsSync(target) }))
`)
    const run = spawnSync(process.execPath, [join(at, 'entry.mjs'), join(at, 'account', 'root'), at], { cwd: at, env: { ...clean, MERCURY_SUITE_GUARDED: named(at) }, encoding: 'utf8' })
    check('the guard file is loaded and installs nothing: the removal goes through and nothing is said', run.status === 0 && run.stdout.trim() === JSON.stringify({ guarded: null, stands: false }) && run.stderr === '', `rc=${run.status} ${run.stdout} ${run.stderr}`)
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} proof-guard: ${failures} failed`)
process.exitCode = failures ? 1 : 0

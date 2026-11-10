import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const root = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..'))
const world = mkdtempSync(join(tmpdir(), 'proof-scratch-pin-'))
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const paths = (file: string): string[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
const legacyRoot = ['/private/tmp/mw', '/tmp/mw'].find(candidate => existsSync(candidate))
const runEnv = { ...process.env, ...(legacyRoot ? { TMPDIR: legacyRoot } : {}) }
try {
  for (const mode of ['normal', 'wall', 'term', 'direct'] as const) {
    const dir = join(world, mode)
    mkdirSync(dir)
    const receipt = join(dir, 'paths')
    const nested = join(dir, 'nested')
    const fixture = join(dir, 'fixture.cjs')
    writeFileSync(fixture, `const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const record = p => fs.appendFileSync(${JSON.stringify(receipt)}, p + '\\n');
record(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')));
const nest = path.join(os.tmpdir(), 'nest'); fs.mkdirSync(nest, {recursive:true});
const inner = fs.mkdtempSync(path.join(nest, 'inner-')); record(inner); fs.appendFileSync(${JSON.stringify(nested)}, inner + '\\n');
record(fs.mkdtempSync(path.join(fs.existsSync('/private/tmp/mw') ? '/private/tmp/mw' : os.tmpdir(), 'legacy-')));
fs.mkdtemp(path.join(os.tmpdir(), 'callback-'), (e, p) => { if (e) throw e; record(p) });
fs.promises.mkdtemp(path.join(os.tmpdir(), 'promise-')).then(record);
const buffer = fs.mkdtempSync(Buffer.from(path.join(os.tmpdir(), 'buffer-')), 'buffer');
if (!process.versions.bun && !Buffer.isBuffer(buffer)) throw new Error('sync encoding changed'); record(buffer);
fs.mkdtemp(path.join(os.tmpdir(), 'callback-buffer-'), {encoding:'buffer'}, (e, p) => { if (e) throw e; if (!process.versions.bun && !Buffer.isBuffer(p)) throw new Error('callback encoding changed'); record(p) });
fs.promises.mkdtemp(new URL('file://' + path.join(os.tmpdir(), 'url-')), {encoding:'buffer'}).then(p => { if (!process.versions.bun && !Buffer.isBuffer(p)) throw new Error('promise encoding changed'); record(p) });
let refused = false; try { fs.mkdtemp(path.join(os.tmpdir(), 'invalid-')) } catch { refused = true }
if (!refused) throw new Error('missing callback was not rejected synchronously');
if (process.env.MERCURY_TMPDIR) { const p = path.join(process.env.MERCURY_TMPDIR, 'mercury-product', 'scratchpad'); fs.mkdirSync(p, {recursive:true}); record(p) }
`)
    const runner = join(dir, 'run-all.sh')
    writeFileSync(runner, `#!/usr/bin/env bash\n# gate-class: pure\nset -eu\n. ${JSON.stringify(join(root, 'scripts/lib/suite-env.sh'))}\nsuite_env_guard "$0"\nnode ${JSON.stringify(fixture)}\n"${process.execPath}" ${JSON.stringify(fixture)}\nmissing=0\nwhile IFS= read -r path; do [ -d "$path" ] || missing=1; done < ${JSON.stringify(receipt)}\n[ "$missing" = 1 ] || touch ${JSON.stringify(join(dir, 'handoff'))}\nmktemp -d "\${TMPDIR%/}/shell.XXXXXX" >> ${JSON.stringify(receipt)}\nmkdir -p "\${TMPDIR%/}/nest"\ninner=$(mktemp -d "\${TMPDIR%/}/nest/shell-inner.XXXXXX")\nprintf '%s\\n' "$inner" >> ${JSON.stringify(receipt)}\nprintf '%s\\n' "$inner" >> ${JSON.stringify(nested)}\nif [ -d /private/tmp/mw ]; then mktemp -d /private/tmp/mw/legacy-shell.XXXXXX >> ${JSON.stringify(receipt)}; fi\n${mode === 'wall' || mode === 'term' ? `touch ${JSON.stringify(join(dir, 'ready'))}\nsleep 600 &\nwait` : 'exit 0'}\n`)
    const child = spawn('bash', mode === 'direct' ? [runner] : [join(root, 'scripts/gate/run-suite.sh'), runner, mode === 'wall' ? '4' : '30', dir], { cwd: root, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    const exited = new Promise<number | null>(r => child.on('exit', r))
    if (mode === 'term') {
      const until = Date.now() + 20_000
      while (!existsSync(join(dir, 'ready')) && child.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 25))
      check('TERM fixture reached ready', existsSync(join(dir, 'ready')), output)
      child.kill('SIGTERM')
    }
    const code = await exited
    const made = paths(receipt)
    const left = made.filter(p => existsSync(p))
    const kept = paths(nested)
    check(`${mode} exercised all scratch classes`, made.length >= 10, `made=${made.length}, rc=${code}`)
    check(`${mode} an allocation nested under the run root keeps its directory (run root under ${legacyRoot ?? 'the ambient temp dir'})`, kept.length === 3 && kept.every(p => basename(dirname(p)) === 'nest'), JSON.stringify(kept))
    check(`${mode} the parent can read a child allocation after the child exits`, existsSync(join(dir, 'handoff')))
    check(`${mode} leaves no scratch folders`, left.length === 0, `created=${made.length}, leftovers=${left.length}`)
    check(`${mode} preserves the result`, mode === 'wall' ? code === 137 : mode === 'term' ? code === 143 : code === 0, `rc=${code} ${output}`)
    for (const p of made) rmSync(p, { recursive: true, force: true })
  }
  const boots = join(world, 'boots')
  const emptyBin = join(boots, 'empty-bin')
  mkdirSync(emptyBin, { recursive: true })
  const ledger = join(boots, 'ledger')
  const { NODE_OPTIONS: _options, BUN_OPTIONS: _bunOptions, MERCURY_SUITE_TMPDIR: _root, MERCURY_PROCESS_LEDGER_DIR: _ledger, MERCURY_SUITE_RUNNER_PID: _runner, MERCURY_SUITE_SCRIPT: _script, ...bareEnv } = process.env as Record<string, string>
  const preloadEnv = { ...bareEnv, MERCURY_SUITE_TMPDIR: boots, MERCURY_PROCESS_LEDGER_DIR: ledger, MERCURY_SUITE_RUNNER_PID: String(process.pid), NODE_OPTIONS: `--require=${JSON.stringify(join(root, 'scripts/lib/proofScratch.cjs'))}`, BUN_OPTIONS: `"--preload=${join(root, 'scripts/lib/proofScratch.cjs')}"` }
  const summary = (r: ReturnType<typeof spawnSync>) => JSON.stringify({ status: r.status, signal: r.signal, stdout: String(r.stdout), stderr: String(r.stderr) })
  const entryOf = (pid: number | undefined) => (pid && existsSync(join(ledger, `${pid}.entry`)) ? readFileSync(join(ledger, `${pid}.entry`), 'utf8').trimEnd().split('\t') : [])
  const shapes = {
    'a fresh process whose PATH carries no ps': (runtime: string, env: Record<string, string>) => spawnSync(runtime, ['-e', 'console.log("alive")'], { cwd: root, env: { ...env, PATH: emptyBin }, encoding: 'utf8' }),
    'a process whose folder was deleted': (runtime: string, env: Record<string, string>) => {
      const gone = join(boots, `gone-${Math.random().toString(36).slice(2)}`)
      mkdirSync(gone)
      return spawnSync('bash', ['-c', 'cd "$1" && /bin/rmdir "$1" && exec "$2" -e \'console.log("alive")\'', 'bash', gone, runtime], { env, encoding: 'utf8' })
    },
  }
  for (const runtime of [Bun.which('node') ?? 'node', process.execPath]) {
    for (const [shape, boot] of Object.entries(shapes)) {
      const bare = boot(runtime, bareEnv)
      const loaded = boot(runtime, preloadEnv)
      const label = `${basename(runtime)}: ${shape}`
      check(`${label} boots unchanged under the preload`, summary(loaded) === summary(bare), `preload ${summary(loaded)} vs bare ${summary(bare)}`)
      const entry = entryOf(loaded.pid)
      check(`${label} still registers in the process ledger`, loaded.status !== 0 || (entry.length === 5 && entry[0] === String(loaded.pid) && entry.every(field => field !== '')), `entry ${JSON.stringify(entry)}`)
    }
  }
  if (process.platform === 'win32') {
    console.log('single proof runs: the run root is POSIX only, nothing driven here')
  } else {
    const short = mkdtempSync(join(realpathSync('/tmp'), 'psp-'))
    try {
      const subject = join(root, 'scripts/gate/proofScratchSubject.ts')
      const singleEnv = (temp: string): Record<string, string> => ({
        ...Object.fromEntries(Object.entries(bareEnv).filter(([name]) => !name.startsWith('BASH_FUNC_') && name !== 'MERCURY_TMPDIR')),
        TMPDIR: temp,
      })
      const drive = async (name: string, mode: string, temp: string, signal?: NodeJS.Signals, words: string[] = []): Promise<{ code: number | null; signal: NodeJS.Signals | null; made: string[]; output: string }> => {
        mkdirSync(temp, { recursive: true })
        const receipt = join(world, `single-${name}`)
        const child = spawn(process.execPath, [subject, receipt, mode, ...words], { cwd: root, env: singleEnv(temp), stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', b => { output += b })
        child.stderr.on('data', b => { output += b })
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child.on('exit', (code, sig) => r({ code, signal: sig })))
        if (signal) {
          const until = Date.now() + 20_000
          while (!existsSync(`${receipt}.ready`) && child.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 25))
          child.kill(signal)
        }
        return { ...(await exited), made: paths(receipt), output }
      }
      const isRunRoot = (path: string, base: string): boolean => dirname(path) === base && basename(path).startsWith('mercury-proof-run.')
      for (const mode of ['natural', 'exit'] as const) {
        const temp = join(short, mode)
        const run = await drive(mode, mode, temp)
        const [runRoot, ...made] = run.made
        check(`single ${mode}: the proof's temp dir is one run root under the inherited one`, runRoot !== undefined && isRunRoot(runRoot, temp), `${runRoot} under ${temp}`)
        check(`single ${mode}: a named mkdtempSync import, a plain mkdir and a shell mktemp all land inside it`, made.length === 3 && made.every(p => dirname(p) === runRoot), JSON.stringify(made))
        check(`single ${mode}: nothing is left when the proof ends`, run.code === 0 && readdirSync(temp).length === 0, `rc=${run.code} left=${JSON.stringify(readdirSync(temp))} ${run.output}`)
      }
      {
        const temp = join(short, 'keep')
        const run = await drive('keep', 'keep', temp)
        const [runRoot, named] = run.made
        const left = runRoot && existsSync(runRoot) ? readdirSync(runRoot) : []
        check('single keep: a folder the proof asked to keep stays, its siblings go', run.code === 0 && named !== undefined && left.length === 1 && left[0] === basename(named), `rc=${run.code} left=${JSON.stringify(left)} ${run.output}`)
      }
      for (const [name, mode, words, ending] of [['fail', 'fail', [], 1], ['failing', 'failing', [], 1], ['asked', 'natural', ['--keep'], 0]] as const) {
        const temp = join(short, name)
        const run = await drive(name, mode, temp, undefined, [...words])
        const [runRoot, ...made] = run.made
        check(`single ${name}: ${ending === 0 ? 'a proof run with --keep' : 'a proof that ends red'} keeps its whole run root for reading`, run.code === ending && runRoot !== undefined && made.length === 3 && made.every(p => existsSync(p)), `rc=${run.code} ${JSON.stringify(made.map(p => existsSync(p)))} ${run.output}`)
      }
      {
        const temp = join(short, 'term')
        const run = await drive('term', 'wait', temp, 'SIGTERM')
        check('single TERM: the proof ends 143 through its sweep and leaves nothing', run.code === 143 && readdirSync(temp).length === 0, `rc=${run.code} signal=${run.signal} left=${JSON.stringify(readdirSync(temp))} ${run.output}`)
      }
      {
        const temp = join(short, 'kill')
        const run = await drive('kill', 'wait', temp, 'SIGKILL')
        const left = readdirSync(temp)
        check('single KILL: no sweep can run — one run root is what a killed proof leaves', run.signal === 'SIGKILL' && left.length === 1 && left[0]!.startsWith('mercury-proof-run.'), `rc=${run.code} signal=${run.signal} left=${JSON.stringify(left)}`)
      }
      {
        const temp = join(short, 'l'.repeat(70))
        const run = await drive('long', 'natural', temp)
        const runRoot = run.made[0]
        check('single long temp dir: the run root moves under /tmp so the daemon socket stays within the bound', runRoot !== undefined && isRunRoot(runRoot, realpathSync('/tmp')), `${runRoot}`)
        check('single long temp dir: that root is removed too', run.code === 0 && runRoot !== undefined && !existsSync(runRoot) && readdirSync(temp).length === 0, `rc=${run.code} ${run.output}`)
        if (runRoot && isRunRoot(runRoot, realpathSync('/tmp'))) rmSync(runRoot, { recursive: true, force: true })
      }
      {
        const temp = join(short, 'mercury-proof-run.guest')
        const run = await drive('guest', 'natural', temp)
        const [seen, named] = run.made
        check('single guest: a temp dir that is already a run root is used as it stands', seen === temp, `${seen}`)
        check("single guest: its folders are the owner's to remove", run.code === 0 && named !== undefined && existsSync(named), `rc=${run.code} ${run.output}`)
      }
    } finally {
      rmSync(short, { recursive: true, force: true })
    }
  }
} finally {
  rmSync(world, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0

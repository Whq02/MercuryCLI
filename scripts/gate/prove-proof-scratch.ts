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
  const bash = Bun.which('bash')
  if (bash === null) check('the suite road is driven through bash, and none is on PATH: nothing of it was read (on Windows start this proof from Git Bash)', false)
  if (process.platform === 'win32') console.log('     the TERM leg is POSIX only: Windows ends a process without running its traps')
  const suiteLegs = (['normal', 'wall', 'term', 'direct'] as const).filter(mode => bash !== null && (mode !== 'term' || process.platform !== 'win32'))
  for (const mode of suiteLegs) {
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
    const child = spawn(bash!, mode === 'direct' ? [runner] : [join(root, 'scripts/gate/run-suite.sh'), runner, mode === 'wall' ? '4' : '30', dir], { cwd: root, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    const exited = new Promise<number | null>(r => {
      child.on('exit', r)
      child.on('error', () => r(null))
    })
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
  const preloadEnv = { ...bareEnv, MERCURY_SUITE_TMPDIR: boots, MERCURY_PROCESS_LEDGER_DIR: ledger, MERCURY_SUITE_RUNNER_PID: String(process.pid), NODE_OPTIONS: `--require=${JSON.stringify(join(root, 'scripts/lib/proofScratch.cjs'))}`, BUN_OPTIONS: `"--preload=${join(root, 'scripts/lib/proofScratch.cjs').replaceAll('\\', '/')}"` }
  const summary = (r: ReturnType<typeof spawnSync>) => JSON.stringify({ status: r.status, signal: r.signal, stdout: String(r.stdout), stderr: String(r.stderr) })
  const entries = (): string[] => (existsSync(ledger) ? readdirSync(ledger).filter(name => name.endsWith('.entry')) : [])
  const shapes = {
    'a fresh process whose PATH carries no ps': (runtime: string, env: Record<string, string>) => spawnSync(runtime, ['-e', 'console.log("alive")'], { cwd: root, env: { ...env, PATH: emptyBin }, encoding: 'utf8' }),
    'a process whose folder was deleted': (runtime: string, env: Record<string, string>) => {
      const gone = join(boots, `gone-${Math.random().toString(36).slice(2)}`)
      mkdirSync(gone)
      return spawnSync('bash', ['-c', 'cd "$1" && /bin/rmdir "$1" && exec "$2" -e \'console.log("alive")\'', 'bash', gone, runtime], { env, encoding: 'utf8' })
    },
  }
  for (const runtime of [Bun.which('node') ?? 'node', process.execPath]) {
    for (const [shape, boot] of Object.entries(shapes).filter(([shape]) => bash !== null || !shape.includes('folder was deleted'))) {
      const bare = boot(runtime, bareEnv)
      const stood = new Set(entries())
      const loaded = boot(runtime, preloadEnv)
      const written = entries().filter(name => !stood.has(name))
      const label = `${basename(runtime)}: ${shape}`
      check(`${label} boots unchanged under the preload`, summary(loaded) === summary(bare), `preload ${summary(loaded)} vs bare ${summary(bare)}`)
      const entry = written.length === 1 ? readFileSync(join(ledger, written[0]!), 'utf8').trimEnd().split('\t') : []
      const named = written.length === 1 && entry[0] === basename(written[0]!, '.entry') && (process.platform === 'win32' || entry[0] === String(loaded.pid))
      check(`${label} still registers in the process ledger`, loaded.status !== 0 || (named && entry.length === 5 && entry.every(field => field !== '')), `entry ${JSON.stringify(entry)} in ${JSON.stringify(written)}`)
    }
  }
  {
    const dir = realpathSync(mkdtempSync(join(world, 'as-win32-')))
    const standIn = join(dir, 'stand-in.cjs')
    writeFileSync(standIn, `const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
Object.defineProperty(process, 'platform', { value: 'win32' });
require(${JSON.stringify(join(root, 'scripts/lib/proofScratch.cjs'))}).installProofScratch();
const made = process.env.MERCURY_TMPDIR || '';
if (process.argv[3] !== 'empty' && made !== '') fs.mkdirSync(path.join(made, 'mercury', 'session'), { recursive: true });
fs.writeFileSync(process.argv[2], JSON.stringify({ productTmp: made, tmp: os.tmpdir(), stood: made !== '' && fs.existsSync(made) }));
process.exit(process.argv[3] === 'red' ? 1 : 0);
`)
    const { MERCURY_TMPDIR: _productTmp, MERCURY_SUITE_OF_ONE: _owner, ...plain } = bareEnv
    type Stood = { productTmp: string; tmp: string; stood: boolean }
    const asWin32 = (runtime: string, name: string, mode: string, extra: Record<string, string> = {}): { code: number | null; facts: Stood | undefined; said: string } => {
      const receipt = join(dir, `${basename(runtime)}-${name}.json`)
      const run = spawnSync(runtime, [standIn, receipt, mode], { cwd: dir, env: { ...plain, TMPDIR: dir, TEMP: dir, TMP: dir, ...extra }, encoding: 'utf8' })
      return { code: run.status, facts: existsSync(receipt) ? (JSON.parse(readFileSync(receipt, 'utf8')) as Stood) : undefined, said: `${run.stdout}${run.stderr}` }
    }
    const inTempDir = (path: string): boolean => dirname(path) === dir && basename(path).startsWith('mercury-proof-run.')
    for (const runtime of [Bun.which('node') ?? 'node', process.execPath]) {
      const label = `${basename(runtime)} as win32`
      const green = asWin32(runtime, 'green', 'green')
      check(`${label}: a proof process given no product temp root gets one of its own, a run root under the temp dir, and the temp dir itself is left where it was`, green.code === 0 && green.facts !== undefined && inTempDir(green.facts.productTmp) && green.facts.stood && realpathSync(green.facts.tmp) === dir, `rc=${green.code} ${JSON.stringify(green.facts)} ${green.said}`)
      check(`${label}: that root goes with what the product wrote into it when the proof ends green`, green.facts !== undefined && green.facts.productTmp !== '' && !existsSync(green.facts.productTmp), `${green.facts?.productTmp}`)
      const red = asWin32(runtime, 'red', 'red')
      check(`${label}: it stays for reading when the proof ends red`, red.code === 1 && red.facts !== undefined && inTempDir(red.facts.productTmp) && existsSync(join(red.facts.productTmp, 'mercury', 'session')), `rc=${red.code} ${JSON.stringify(red.facts)}`)
      for (const name of readdirSync(dir).filter(name => name.startsWith('mercury-proof-run.'))) rmSync(join(dir, name), { recursive: true, force: true })
      const given = join(dir, `given-${basename(runtime)}`)
      const kept = asWin32(runtime, 'given', 'empty', { MERCURY_TMPDIR: given })
      check(`${label}: a process that was given a product temp root keeps it and makes none`, kept.code === 0 && kept.facts?.productTmp === given && !readdirSync(dir).some(name => name.startsWith('mercury-proof-run.')), `rc=${kept.code} ${JSON.stringify(kept.facts)} ${JSON.stringify(readdirSync(dir))}`)
    }
  }
  if (process.platform === 'win32') {
    console.log('single proof runs: the run root that moves the temp dir is POSIX only, nothing more driven here')
  } else {
    const short = mkdtempSync(join(realpathSync('/tmp'), 'psp-'))
    try {
      const subject = join(root, 'scripts/gate/proofScratchSubject.ts')
      const singleEnv = (temp: string): Record<string, string> => ({
        ...Object.fromEntries(Object.entries(bareEnv).filter(([name]) => !name.startsWith('BASH_FUNC_') && name !== 'MERCURY_TMPDIR')),
        TMPDIR: temp,
      })
      type Seen = { tmp: string; productTmp: string; home: string; probe: string; colour: string; made: string }
      type Facts = { pid: number; owner: string; own: { tmp: string; productTmp: string; home: string }; child: Seen; nested?: { tmp: string; namedStood: boolean } }
      const drive = async (name: string, mode: string, temp: string, signal?: NodeJS.Signals, words: string[] = [], alter: (env: Record<string, string>) => Record<string, string> = env => env): Promise<{ code: number | null; signal: NodeJS.Signals | null; made: string[]; output: string; pid: number | undefined; facts: Facts | undefined }> => {
        mkdirSync(temp, { recursive: true })
        const receipt = join(world, `single-${name}`)
        const child = spawn(process.execPath, [subject, receipt, mode, ...words], { cwd: root, env: alter(singleEnv(temp)), stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', b => { output += b })
        child.stderr.on('data', b => { output += b })
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(r => child.on('exit', (code, sig) => r({ code, signal: sig })))
        if (signal) {
          const until = Date.now() + 20_000
          while (!existsSync(`${receipt}.ready`) && child.exitCode === null && Date.now() < until) await new Promise(r => setTimeout(r, 25))
          child.kill(signal)
        }
        const ended = await exited
        const facts = existsSync(`${receipt}.facts`) ? JSON.parse(readFileSync(`${receipt}.facts`, 'utf8')) as Facts : undefined
        return { ...ended, made: paths(receipt), output, pid: child.pid, facts }
      }
      const isRunRoot = (path: string, base: string): boolean => dirname(path) === base && basename(path).startsWith('mercury-proof-run.')
      for (const mode of ['natural', 'exit'] as const) {
        const temp = join(short, mode)
        const run = await drive(mode, mode, temp)
        const [runRoot, ...made] = run.made
        check(`single ${mode}: the proof's temp dir is one run root under the inherited one`, runRoot !== undefined && isRunRoot(runRoot, temp), `${runRoot} under ${temp}`)
        check(`single ${mode}: a named mkdtempSync import, a plain mkdir and a shell mktemp all land inside it`, made.length === 3 && made.every(p => dirname(p) === runRoot), JSON.stringify(made))
        check(`single ${mode}: nothing is left when the proof ends`, run.code === 0 && readdirSync(temp).length === 0, `rc=${run.code} left=${JSON.stringify(readdirSync(temp))} ${run.output}`)
        check(`single ${mode}: the proof ran in the process its caller started, as the owner of its run root, with no word about its start`, run.facts !== undefined && run.facts.pid === run.pid && run.facts.owner === String(run.pid) && !run.output.includes('could not be started again'), `started ${run.pid}, ran as ${run.facts?.pid}, owner ${JSON.stringify(run.facts?.owner)} ${run.output}`)
        check(`single ${mode}: a child started with no env option reads the run root as its temp dir and as the product's temp root, as the proof does`, run.facts !== undefined && runRoot !== undefined && run.facts.child.tmp === runRoot && run.facts.child.productTmp === runRoot && run.facts.own.productTmp === runRoot, JSON.stringify(run.facts))
        check(`single ${mode}: a folder that child made lies in the run root and leaves with it`, run.facts !== undefined && runRoot !== undefined && dirname(run.facts.child.made) === runRoot && !existsSync(run.facts.child.made), `${run.facts?.child.made}`)
      }
      {
        const temp = join(short, 'bare')
        const account = join(short, 'account')
        mkdirSync(account)
        const run = await drive('bare', 'natural', temp, undefined, [], env => {
          const { MERCURY_CONFIG_DIR: _home, MERCURY_HOME: _other, MERCURY_LOCAL_PROBE_TARGETS: _probe, ...rest } = env
          return { ...rest, HOME: account, NO_COLOR: '1' }
        })
        const runRoot = run.made[0]
        const own = run.facts?.own.home ?? ''
        check('single bare: with no config home given, the proof and a child started with no env option read one scratch home inside the run root', run.code === 0 && runRoot !== undefined && own !== '' && dirname(own) === runRoot && basename(own).startsWith('mercury-proof-home-') && run.facts?.child.home === own, `rc=${run.code} ${JSON.stringify(run.facts)} ${run.output}`)
        check("single bare: that child reads no local-server probe target and none of the caller's colour switches", run.facts?.child.probe === 'none' && run.facts?.child.colour === '', JSON.stringify(run.facts?.child))
        check("single bare: nothing was made under the account's own home, and the scratch home left with the run root", !existsSync(join(account, '.mercury')) && readdirSync(account).length === 0 && readdirSync(temp).length === 0, `account=${JSON.stringify(readdirSync(account))} temp=${JSON.stringify(readdirSync(temp))}`)
      }
      {
        const bound = Number(/^suite_socket_bound=(\d+)$/m.exec(readFileSync(join(root, 'scripts/lib/suite-env.sh'), 'utf8'))?.[1])
        const temp = join(short, 'b'.repeat(40 - short.length - 1))
        const account = join(short, 'account-b')
        mkdirSync(account)
        const bare = await drive('bound-bare', 'natural', temp, undefined, [], env => {
          const { MERCURY_CONFIG_DIR: _home, MERCURY_HOME: _other, ...rest } = env
          return { ...rest, HOME: account }
        })
        const home = bare.facts?.own.home ?? ''
        const socket = `${home}/daemon/control.sock`
        check(`single bare, a temp dir of ${Buffer.byteLength(temp)} bytes: the scratch home's daemon socket path is within the ${bound}-byte bound, the run root having moved under /tmp to keep it there`, bare.code === 0 && home !== '' && Buffer.byteLength(socket) <= bound && isRunRoot(dirname(home), realpathSync('/tmp')), `rc=${bare.code} ${socket} (${Buffer.byteLength(socket)} bytes)`)
        const moved = bare.made[0]
        if (moved && isRunRoot(moved, realpathSync('/tmp'))) rmSync(moved, { recursive: true, force: true })
        const given = await drive('bound-given', 'natural', temp)
        check('single with a home of its own, the same temp dir: the run root stays where the caller asked', given.code === 0 && given.made[0] !== undefined && isRunRoot(given.made[0], temp), `rc=${given.code} ${given.made[0]}`)
      }
      {
        const temp = join(short, 'nest')
        const run = await drive('nest', 'nest', temp)
        const runRoot = run.made[0]
        check('single nest: a proof started by the proof with no env option is a guest of the same run root, and its folders are the owner\'s to remove', run.code === 0 && runRoot !== undefined && run.facts?.nested?.tmp === runRoot && run.facts.nested.namedStood === true && readdirSync(temp).length === 0, `rc=${run.code} ${JSON.stringify(run.facts?.nested)} left=${JSON.stringify(readdirSync(temp))} ${run.output}`)
      }
      {
        const temp = join(short, 'held')
        const run = await drive('held', 'natural', temp, undefined, [], env => ({ ...env, MERCURY_SUITE_OF_ONE: 'held' }))
        const [runRoot, ...made] = run.made
        check('single held: asked to keep its first process image, the proof keeps it, still gets one run root as its own temp dir and the product\'s, lands its own folders there and removes it', run.code === 0 && run.facts?.owner === 'held' && run.facts.pid === run.pid && runRoot !== undefined && isRunRoot(runRoot, temp) && run.facts.own.productTmp === runRoot && made.length === 3 && made.every(p => dirname(p) === runRoot) && !existsSync(runRoot), `rc=${run.code} ${JSON.stringify(run.facts)} ${JSON.stringify(run.made)} ${run.output}`)
        console.log(`     on that road a child started with no env option read ${run.facts?.child.tmp === runRoot ? 'the run root too' : `its temp dir as ${run.facts?.child.tmp}`}: what this runtime hands such a child is why the first image is replaced`)
      }
      {
        const temp = join(short, 'nolib')
        const run = await drive('nolib', 'natural', temp, undefined, [], env => ({ ...env, MERCURY_SUITE_LIBC: join(short, 'no-such-library') }))
        const runRoot = run.made[0]
        check('single nolib: a proof that cannot be started again says so on stderr, with what its children will read and what to put in front of the run', run.output.includes('could not be started again on its scratch environment') && run.output.includes('no-such-library did not open') && run.output.includes("reads the caller's temp dir and config home") && run.output.includes('MERCURY_TMPDIR and MERCURY_CONFIG_DIR'), run.output.slice(0, 400))
        check('single nolib: it still runs to its end on one run root of its own, the product\'s temp root with it, and removes the root', run.code === 0 && run.facts?.pid === run.pid && runRoot !== undefined && isRunRoot(runRoot, temp) && run.facts.own.productTmp === runRoot && !existsSync(runRoot), `rc=${run.code} ${JSON.stringify(run.facts?.own)} ${runRoot}`)
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
        const temp = join(short, 'failclean')
        const run = await drive('failclean', 'failclean', temp)
        check('single red, nothing left to read: a proof that ends red after removing what it made leaves no empty run root behind', run.code === 1 && run.made.length === 4 && readdirSync(temp).length === 0, `rc=${run.code} left=${JSON.stringify(readdirSync(temp))} ${run.output}`)
        const bareTemp = join(short, 'fb')
        const account = join(short, 'account-c')
        mkdirSync(account)
        const bare = await drive('failclean-bare', 'failclean', bareTemp, undefined, [], env => {
          const { MERCURY_CONFIG_DIR: _home, MERCURY_HOME: _other, ...rest } = env
          return { ...rest, HOME: account }
        })
        check('single red, nothing left to read, its own scratch home inside the root: the root goes, the home with it', bare.code === 1 && bare.made[0] !== undefined && isRunRoot(bare.made[0], bareTemp) && readdirSync(bareTemp).length === 0 && readdirSync(account).length === 0, `rc=${bare.code} root=${bare.made[0]} left=${JSON.stringify(readdirSync(bareTemp))} ${bare.output}`)
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

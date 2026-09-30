import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..'))
const world = mkdtempSync(join(tmpdir(), 'proof-scratch-pin-'))
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const paths = (file: string): string[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
try {
  for (const mode of ['normal', 'wall', 'term', 'direct'] as const) {
    const dir = join(world, mode)
    mkdirSync(dir)
    const receipt = join(dir, 'paths')
    const fixture = join(dir, 'fixture.cjs')
    writeFileSync(fixture, `const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const record = p => fs.appendFileSync(${JSON.stringify(receipt)}, p + '\\n');
record(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')));
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
    writeFileSync(runner, `#!/usr/bin/env bash\n# gate-class: pure\nset -eu\n. ${JSON.stringify(join(root, 'scripts/lib/suite-env.sh'))}\nsuite_env_guard "$0"\nnode ${JSON.stringify(fixture)}\n"${process.execPath}" ${JSON.stringify(fixture)}\nmissing=0\nwhile IFS= read -r path; do [ -d "$path" ] || missing=1; done < ${JSON.stringify(receipt)}\n[ "$missing" = 1 ] || touch ${JSON.stringify(join(dir, 'handoff'))}\nmktemp -d "\${TMPDIR%/}/shell.XXXXXX" >> ${JSON.stringify(receipt)}\nif [ -d /private/tmp/mw ]; then mktemp -d /private/tmp/mw/legacy-shell.XXXXXX >> ${JSON.stringify(receipt)}; fi\n${mode === 'wall' || mode === 'term' ? `touch ${JSON.stringify(join(dir, 'ready'))}\nsleep 600 &\nwait` : 'exit 0'}\n`)
    const child = spawn('bash', mode === 'direct' ? [runner] : [join(root, 'scripts/gate/run-suite.sh'), runner, mode === 'wall' ? '4' : '30', dir], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    check(`${mode} exercised all scratch classes`, made.length >= 10, `made=${made.length}, rc=${code}`)
    check(`${mode} the parent can read a child allocation after the child exits`, existsSync(join(dir, 'handoff')))
    check(`${mode} leaves no scratch folders`, left.length === 0, `created=${made.length}, leftovers=${left.length}`)
    check(`${mode} preserves the result`, mode === 'wall' ? code === 137 : mode === 'term' ? code === 143 : code === 0, `rc=${code} ${output}`)
    for (const p of made) rmSync(p, { recursive: true, force: true })
  }
} finally {
  rmSync(world, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const root = resolve(import.meta.dir, '../..')
const suiteEnv = join(root, 'scripts/lib/suite-env.sh')
const realPreload = join(root, 'scripts/lib/proofScratch.cjs')
const world = mkdtempSync(join(tmpdir(), 'node-preload-path-'))
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
const plainPath = '/usr/bin:/bin'
const fakeBin = join(world, 'fake-bin')
const cygpathCalls = join(world, 'cygpath-calls')
mkdirSync(fakeBin)
writeFileSync(join(fakeBin, 'cygpath'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(cygpathCalls)}
case "$2" in
  /[A-Za-z]/*) printf '%s:%s\\n' "$(printf %s "$2" | cut -c2 | tr a-z A-Z)" "$(printf %s "$2" | cut -c3-)" ;;
  *) printf 'C:/msys64%s\\n' "$2" ;;
esac
`)
writeFileSync(join(fakeBin, 'uname'), '#!/bin/sh\nprintf \'MINGW64_NT-10.0-19045\\n\'\n')
chmodSync(join(fakeBin, 'cygpath'), 0o755)
chmodSync(join(fakeBin, 'uname'), 0o755)

const requireOption = (file: string, os: string, path = plainPath): string => {
  const run = spawnSync('bash', ['-c', '. "$1"; suite_node_require_option "$2" "$3"', 'bash', suiteEnv, file, os], { encoding: 'utf8', env: { ...process.env, PATH: path } })
  return run.status === 0 ? run.stdout : `rc=${run.status} ${run.stderr}`
}
const msysPreload = '/c/src/m43-cand/scripts/lib/proofScratch.cjs'
const mixedPreload = '--require="C:/src/m43-cand/scripts/lib/proofScratch.cjs"'

try {
  console.log('── the --require word for node, by host')
  const posix = requireOption(realPreload, 'Darwin')
  check('a POSIX path keeps the shape every suite has exported so far', posix === `--require="${realPreload}"`, posix)
  const viaCygpath = requireOption(msysPreload, 'MINGW64_NT-10.0-19045', `${fakeBin}:${plainPath}`)
  check('an MSYS drive path under a Windows bash becomes the C:/ spelling node reads, through cygpath -m when the host has one', viaCygpath === mixedPreload, viaCygpath)
  const calls = existsSync(cygpathCalls) ? readFileSync(cygpathCalls, 'utf8') : ''
  check('…and cygpath was the converter consulted', calls.includes(`-m ${msysPreload}`), calls || 'no cygpath call recorded')
  const viaRule = requireOption(msysPreload, 'MSYS_NT-10.0-19045')
  check('without cygpath the same MSYS path converts by the drive-letter rule', viaRule === mixedPreload, viaRule)
  const cygdrive = requireOption('/cygdrive/d/work/proofScratch.cjs', 'CYGWIN_NT-10.0-19045')
  check('a Cygwin /cygdrive path converts the same way', cygdrive === '--require="D:/work/proofScratch.cjs"', cygdrive)
  const backslashes = requireOption('C:\\src\\m43-cand\\scripts\\lib\\proofScratch.cjs', 'MSYS_NT-10.0-19045')
  check('a backslash Windows path comes out with forward slashes, so no backslash meets the quotes', backslashes === mixedPreload, backslashes)

  console.log('── a node child loads the preload through the quoted word')
  const awkward = join(world, 'back\\slash "q" dir')
  mkdirSync(awkward)
  copyFileSync(realPreload, join(awkward, 'proofScratch.cjs'))
  copyFileSync(join(root, 'scripts/lib/proofBrowser.cjs'), join(awkward, 'proofBrowser.cjs'))
  const awkwardPreload = join(awkward, 'proofScratch.cjs')
  const option = requireOption(awkwardPreload, 'Darwin')
  check('a backslash and a quote inside the path are escaped the way node unquotes NODE_OPTIONS', option === `--require="${awkwardPreload.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`, option)
  const runRoot = join(world, 'run-root')
  const ledger = join(world, 'ledger')
  mkdirSync(runRoot)
  const { NODE_OPTIONS: _options, MERCURY_SUITE_TMPDIR: _root, MERCURY_PROCESS_LEDGER_DIR: _ledger, MERCURY_SUITE_RUNNER_PID: _runner, MERCURY_SUITE_SCRIPT: _script, ...bareEnv } = process.env as Record<string, string>
  const childEnv = { ...bareEnv, MERCURY_SUITE_TMPDIR: runRoot, MERCURY_PROCESS_LEDGER_DIR: ledger, MERCURY_SUITE_RUNNER_PID: String(process.pid) }
  const probe = "const fs = require('node:fs'); const made = fs.mkdtempSync('/tmp/mw/probe-'); process.stdout.write(made); fs.rmdirSync(made)"
  const loaded = spawnSync('node', ['-e', probe], { cwd: root, encoding: 'utf8', env: { ...childEnv, NODE_OPTIONS: option } })
  check('node starts under the word', loaded.status === 0, `rc=${loaded.status} ${loaded.stderr}`)
  check('…and the preload is live in it: a /tmp/mw allocation lands under the run root', loaded.stdout.startsWith(runRoot + '/'), loaded.stdout)
  check('…and the child wrote its process-ledger entry', loaded.pid !== undefined && existsSync(join(ledger, `${loaded.pid}.entry`)), `pid=${loaded.pid}`)
  const naive = spawnSync('node', ['-e', probe], { cwd: root, encoding: 'utf8', env: { ...childEnv, NODE_OPTIONS: `--require="${awkwardPreload}"` } })
  const eaten = join(world, 'backslash q dir', 'proofScratch.cjs')
  check('control — the same path quoted without the escapes dies before the script runs, naming the module with its backslash eaten (the round-23 shape)', naive.status !== 0 && naive.stderr.includes(`Cannot find module '${eaten}'`), `rc=${naive.status} ${naive.stderr.split('\n').find(line => line.includes('Cannot find module')) ?? naive.stderr.slice(0, 200)}`)

  console.log('── suite_scratch_init on a Windows bash exports the converted word')
  const nodeOptionsAfterInit = (path: string): string => {
    const home = join(world, 'home')
    const temp = join(world, 'tmp')
    mkdirSync(home, { recursive: true })
    mkdirSync(temp, { recursive: true })
    const run = spawnSync('bash', ['-c', '. "$1"; suite_scratch_init "$2" >/dev/null 2>&1; printf %s "$NODE_OPTIONS"', 'bash', suiteEnv, join(world, 'synth-run-all.sh')], {
      encoding: 'utf8',
      env: { PATH: path, HOME: home, TMPDIR: temp, MERCURY_CONFIG_DIR: home, MERCURY_LOCAL_PROBE_TARGETS: 'none' },
    })
    return run.status === 0 ? run.stdout : `rc=${run.status} ${run.stderr}`
  }
  const windowsInit = nodeOptionsAfterInit(`${fakeBin}:${plainPath}`)
  check('under uname MINGW64_NT with cygpath on PATH, NODE_OPTIONS carries the preload as cygpath -m spells it', windowsInit === `--require="C:/msys64${realPreload}"`, windowsInit)
  const hostInit = nodeOptionsAfterInit(plainPath)
  check('on this host the exported word is the POSIX path, unchanged', hostInit === `--require="${realPreload}"`, hostInit)
} finally {
  removeScratch(world)
}
console.log(failures === 0 ? 'NODE PRELOAD PATH: ALL PASS' : `NODE PRELOAD PATH: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

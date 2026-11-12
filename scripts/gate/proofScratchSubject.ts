import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepProofScratch } from '../lib/proofScratch.cjs'

const receipt = process.argv[2]!
const mode = process.argv[3] ?? 'natural'
const record = (line: string): void => appendFileSync(receipt, line + '\n')
record(tmpdir())
const named = mkdtempSync(join(tmpdir(), 'named-'))
record(named)
const plain = join(tmpdir(), 'plain')
mkdirSync(plain)
record(plain)
record(spawnSync('/bin/sh', ['-c', 'command mktemp -d "$TMPDIR/shell-XXXXXX"'], { encoding: 'utf8', env: process.env }).stdout.trim())
const asInherited = (script: string): string => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).stdout.trim()
const facts: Record<string, unknown> = {
  pid: process.pid,
  owner: process.env.MERCURY_SUITE_OF_ONE ?? '',
  own: { tmp: tmpdir(), productTmp: process.env.MERCURY_TMPDIR ?? '', home: process.env.MERCURY_CONFIG_DIR ?? '' },
  child: {
    tmp: asInherited('printf %s "$TMPDIR"'),
    productTmp: asInherited('printf %s "${MERCURY_TMPDIR:-}"'),
    home: asInherited('printf %s "${MERCURY_CONFIG_DIR:-}"'),
    probe: asInherited('printf %s "${MERCURY_LOCAL_PROBE_TARGETS:-}"'),
    colour: asInherited('printf %s "${NO_COLOR:-}${FORCE_COLOR:-}"'),
    made: asInherited('command mktemp -d "$TMPDIR/inherited-XXXXXX"'),
  },
}
if (mode === 'nest') {
  spawnSync(process.execPath, [import.meta.path, `${receipt}.nested`, 'natural'], { encoding: 'utf8' })
  const [nestedTmp, nestedNamed] = existsSync(`${receipt}.nested`) ? readFileSync(`${receipt}.nested`, 'utf8').trim().split('\n') : []
  facts.nested = { tmp: nestedTmp ?? '', namedStood: nestedNamed !== undefined && existsSync(nestedNamed) }
}
writeFileSync(`${receipt}.facts`, JSON.stringify(facts))
if (mode === 'keep') keepProofScratch(named)
if (mode === 'exit') process.exit(0)
if (mode === 'fail') process.exit(1)
if (mode === 'failclean') {
  for (const made of [named, plain, ...readFileSync(receipt, 'utf8').trim().split('\n').slice(3), (facts.child as { made: string }).made]) rmSync(made, { recursive: true, force: true })
  process.exit(1)
}
if (mode === 'failing') process.exitCode = 1
if (mode === 'wait') {
  writeFileSync(`${receipt}.ready`, '')
  setInterval(() => {}, 1000)
}
if (mode === 'dying-daemon') {
  const { spawn } = await import('node:child_process')
  const daemonDir = join(named, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const writerCode = [
    "const fs = require('node:fs'), path = require('node:path');",
    'const dir = process.argv[1], tag = process.argv[2];',
    'const writeLate = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, tag), String(process.pid)); } catch {} };',
    "process.on('SIGTERM', () => { setTimeout(() => { writeLate(); process.exit(0); }, 80); });",
    'const iv = setInterval(writeLate, 60);',
    'setTimeout(() => { clearInterval(iv); process.exit(0); }, 4000);',
  ].join(' ')
  const d = spawn(process.execPath, ['-e', writerCode, daemonDir, 'daemon-late.txt'], { detached: true, stdio: 'ignore' })
  const w = spawn(process.execPath, ['-e', writerCode, daemonDir, 'worker-late.txt'], { detached: true, stdio: 'ignore' })
  d.unref()
  w.unref()
  writeFileSync(join(daemonDir, 'daemon.json'), JSON.stringify({ pid: d.pid }))
  writeFileSync(join(daemonDir, 'concourse-workers.json'), JSON.stringify({ 'concourse-w1': { pid: w.pid } }))
  facts.dyingPids = [d.pid, w.pid]
  writeFileSync(`${receipt}.facts`, JSON.stringify(facts))
}

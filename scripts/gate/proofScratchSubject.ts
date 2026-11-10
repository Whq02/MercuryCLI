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

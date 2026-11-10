import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
if (mode === 'keep') keepProofScratch(named)
if (mode === 'exit') process.exit(0)
if (mode === 'fail') process.exit(1)
if (mode === 'failing') process.exitCode = 1
if (mode === 'wait') {
  writeFileSync(`${receipt}.ready`, '')
  setInterval(() => {}, 1000)
}

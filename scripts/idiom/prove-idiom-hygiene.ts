#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' hygiene — the canonical pruner and the coordination spelling (C19/C21)')
console.log('============================================================')

const loading = readFileSync(join(ROOT, 'src/utils/sessionStorage/loading.ts'), 'utf8')
const reader = readFileSync(join(ROOT, 'src/utils/sessionStorage/transcriptReader.ts'), 'utf8')
const prunerAt = reader.indexOf('export function pruneRecordBranchesBeforeParse(')
const pruner = prunerAt === -1 ? '' : reader.slice(prunerAt, reader.indexOf('\nexport ', prunerAt + 1))
check(
  'C21: the canonical pruner keys on the record envelope and parses its links',
  loading.includes('pruneRecordBranchesBeforeParse') &&
    reader.includes('{"schemaVersion":1,"recordId":"') &&
    pruner.includes('decodeTranscriptBuffer<Record<string, unknown>>(') &&
    pruner.includes("const parent = typeof cur.parentUuid === 'string' && cur.parentUuid ? cur.parentUuid : null"),
)

const coordProver = readFileSync(join(ROOT, 'scripts/substrate/prove-coordination-server.ts'), 'utf8')
check('C19: coordination-server prover pins the MERCURY_* primary spelling', coordProver.includes("process.env.MERCURY_COORDINATION_MCP = '1'"))

console.log(failures === 0 ? '\n ✅ HYGIENE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

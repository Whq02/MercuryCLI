#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const IMPORT_RE = /(^|\n)\s*(import|export)[^;']*from\s+'@anthropic-ai\/sdk[^']*'/

function sdkImporters(): string[] {
  const raw = execSync(
    `grep -rl "from '@anthropic-ai/sdk" src --include='*.ts' --include='*.tsx' --include='*.d.ts' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
  return raw
    .split('\n')
    .filter(Boolean)
    .filter(f => IMPORT_RE.test(readFileSync(join(ROOT, f), 'utf8')))
    .sort()
}

const ALLOWLIST: string[] = []

section('§A the exact SDK-importer allowlist (B01)')
{
  const actual = sdkImporters()
  const extra = actual.filter(f => !ALLOWLIST.includes(f))
  const gone = ALLOWLIST.filter(f => !actual.includes(f))
  check('no SDK importer outside the named transport leaves', extra.length === 0, extra.join(', ') + ' (each listed file under src/ imports @anthropic-ai/sdk: remove that import and use the Mercury types; adding it to ALLOWLIST in scripts/idiom/prove-import-fence.ts is not the fix)')
  check(
    'the allowlist is exact (a file leaving it must be removed here — shrink-only)',
    gone.length === 0,
    `stale rows: ${gone.join(', ')} (these ALLOWLIST entries in scripts/idiom/prove-import-fence.ts no longer import the SDK: delete them from ALLOWLIST)`,
  )
  console.log(`  fence population: ${actual.length} leaf file(s)`)
}

section('§B provider lanes are direct codecs (B03/B04)')
{
  const ANTHROPIC_HOME = 'src/models/roads/anthropic/'
  const hits = execSync(
    `grep -rln "@anthropic-ai/sdk" src/models/roads --include='*.ts' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  const routed = hits.filter(f => !f.startsWith(ANTHROPIC_HOME))
  check('zero SDK references under src/models/roads/** outside the Anthropic transport', routed.length === 0, routed.join(', ') + ' (each listed file under src/models/roads mentions @anthropic-ai/sdk: remove the reference and use a direct codec)')
  const transport = hits.filter(f => f.startsWith(ANTHROPIC_HOME))
  check(
    'the Anthropic transport also has zero SDK references',
    transport.length === 0,
    transport.join(', ') + ' (each listed file under src/models/roads/anthropic mentions @anthropic-ai/sdk: remove the reference and use a direct codec)',
  )
}

section('§C renderers consume Mercury types only (E01)')
{
  const hits = execSync(
    `grep -rln "from '@anthropic-ai/sdk" src/components src/screens --include='*.ts' --include='*.tsx' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  check('zero SDK imports under src/components/** + src/screens/**', hits.length === 0, hits.join(', ') + ' (each listed file under src/components or src/screens imports @anthropic-ai/sdk: import the Mercury type instead)')
}

section('§F the versioned machine contract + the named projection (E03/E04), on the live homes')
{
  for (const home of ['src/daemon/runner-wire', 'src/engine/rows']) check(`${home} exists`, existsSync(join(ROOT, home)) && statSync(join(ROOT, home)).isDirectory())
  const { ROWS_SCHEMA } = await import('../../src/engine/rows/vocabulary.ts')
  const { RUNNER_PROTOCOL } = await import('../../src/daemon/runner-wire/methods.ts')
  const { itemRowsOf, outcomeRow } = await import('../../src/engine/rows/project.ts')
  const { parseRow } = await import('../../src/engine/rows/read.ts')
  check('the row contract is VERSIONED (ROWS_SCHEMA exported as a literal)', typeof ROWS_SCHEMA === 'number' && Number.isInteger(ROWS_SCHEMA) && ROWS_SCHEMA >= 1, String(ROWS_SCHEMA) + ' (export ROWS_SCHEMA as an integer of at least 1 from src/engine/rows/vocabulary.ts)')
  check('the wire contract is VERSIONED (RUNNER_PROTOCOL exported as a literal)', typeof RUNNER_PROTOCOL === 'number' && Number.isInteger(RUNNER_PROTOCOL) && RUNNER_PROTOCOL >= 1, String(RUNNER_PROTOCOL) + ' (export RUNNER_PROTOCOL as an integer of at least 1 from src/daemon/runner-wire/methods.ts)')
  const projected = itemRowsOf({ session_id: 's1', turn: 1 }, 'm1', 'hello')
  const parsedItem = projected.length === 1 ? parseRow(JSON.stringify(projected[0])) : null
  const out = outcomeRow({ session_id: 's1', turn: 1 }, {
    turnId: 't1',
    status: 'completed',
    steps: 1,
    wallMs: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as never,
    models: {},
    denials: [],
    stopReason: 'end_turn',
  })
  const parsedOutcome = parseRow(JSON.stringify(out))
  check(
    'the row stream is a NAMED projection both ways (project.ts emits the rows, read.ts parses them)',
    parsedItem?.type === 'text' && parsedItem.text === 'hello' && parsedOutcome?.type === 'outcome' && parsedOutcome.schema === ROWS_SCHEMA,
    'itemRowsOf and outcomeRow in src/engine/rows/project.ts must emit rows that parseRow in src/engine/rows/read.ts reads back: a text row of hello and an outcome row stamped with ROWS_SCHEMA',
  )
  const sdkHits = execSync(
    `grep -rln "from '@anthropic-ai/sdk" src/engine/rows src/daemon/runner-wire --include='*.ts' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  check('the machine surface imports no provider SDK (Mercury-native)', sdkHits.length === 0, sdkHits.join(', ') + ' (each listed file under src/engine/rows or src/daemon/runner-wire mentions @anthropic-ai/sdk: remove the reference)')
}

console.log(failures === 0 ? '\n ✅ IMPORT FENCE HOLDS' : `\n ❌ ${failures} FENCE BREAK(S)`)
process.exit(failures === 0 ? 0 : 1)

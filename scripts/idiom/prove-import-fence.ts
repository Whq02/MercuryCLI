#!/usr/bin/env bun
// ============================================================================
//  scripts/idiom/prove-import-fence.ts — B01/B03/B04/B07/E01: the
//  provider-SDK import fence.
//
//  The Mercury wire vocabulary (src/types/wire.ts) is the app-wide spelling
//  of API shapes; '@anthropic-ai/sdk' meets the tree ONLY inside the named
//  transport leaves. This gate pins that architecture:
//    §A the EXACT allowlist — a new SDK importer is a fence break, and
//       a file leaving the list shrinks it (ratchet by exactness);
//    §B provider lanes are DIRECT codecs: zero SDK imports under
//       src/services/providers/** (OpenAI · ZAI);
//    §C renderers consume Mercury types only: zero SDK imports under
//       src/components/** and src/screens/** (E01);
//    §D the vocabulary is self-contained: types/wire.ts imports NOTHING
//       (an SDK upgrade can only land inside the leaves);
//    §E sdkErrors.ts imports ONLY the SDK (the zero-dependency runtime
//       error-identity leaf — the module-cycle law).
// ============================================================================
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

// Import statements only — comments documenting the fence don't count.
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

/** The named transport leaves — the ONLY files allowed to import the SDK. */
const ALLOWLIST = [
  'src/services/providers/anthropic/cacheAndUsage.ts',
  'src/services/providers/anthropic/requestParams.ts',
  'src/services/providers/anthropic/streamCore.ts',
  'src/services/api/client.ts',
  'src/services/api/dumpPrompts.ts',
  'src/services/api/errors.ts',
  'src/services/api/errorUtils.ts',
  'src/services/api/logging.ts',
  'src/services/api/sdkErrors.ts',
  'src/services/api/withRetry.ts',
  'src/services/rateLimitMocking.ts',
  'src/services/tokenEstimation.ts',
  'src/services/vcr.ts',
  'src/utils/model/validateModel.ts',
].sort()

section('§A the exact SDK-importer allowlist (B01)')
{
  const actual = sdkImporters()
  const extra = actual.filter(f => !ALLOWLIST.includes(f))
  const gone = ALLOWLIST.filter(f => !actual.includes(f))
  check('no SDK importer outside the named transport leaves', extra.length === 0, extra.join(', '))
  check(
    'the allowlist is exact (a file leaving it must be removed here — shrink-only)',
    gone.length === 0,
    `stale rows: ${gone.join(', ')}`,
  )
  console.log(`  fence population: ${actual.length} leaf file(s)`)
}

section('§B provider lanes are direct codecs (B03/B04)')
{
  // The routed families are direct codecs over fetch/SSE. The Anthropic
  // family's own transport (src/services/providers/anthropic/) is the
  // SDK-backed lane by design: its SDK importers are exactly the §A
  // allowlist's transport leaves, and nothing else under providers/** may
  // reach for the SDK.
  const ANTHROPIC_HOME = 'src/services/providers/anthropic/'
  const hits = execSync(
    `grep -rln "@anthropic-ai/sdk" src/services/providers --include='*.ts' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  const routed = hits.filter(f => !f.startsWith(ANTHROPIC_HOME))
  check('zero SDK references under src/services/providers/** outside the Anthropic transport', routed.length === 0, routed.join(', '))
  const transport = hits.filter(f => f.startsWith(ANTHROPIC_HOME))
  check(
    "the Anthropic transport's SDK importers are exactly the §A transport leaves",
    transport.length > 0 && transport.every(f => ALLOWLIST.includes(f)),
    transport.join(', '),
  )
  const forging = execSync(
    `grep -rln "anthropicBridge\\|AnthropicishMessage" src scripts --include='*.ts' --include='*.tsx' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .filter(f => f !== 'scripts/idiom/prove-import-fence.ts')
  check('the anthropicBridge forging vocabulary is gone at zero callers (B04)', forging.length === 0, forging.join(', '))
}

section('§C renderers consume Mercury types only (E01)')
{
  const hits = execSync(
    `grep -rln "from '@anthropic-ai/sdk" src/components src/screens --include='*.ts' --include='*.tsx' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  check('zero SDK imports under src/components/** + src/screens/**', hits.length === 0, hits.join(', '))
}

section('§D the wire vocabulary is self-contained (B07)')
{
  const wire = readFileSync(join(ROOT, 'src/types/wire.ts'), 'utf8')
  const imports = wire.match(/(^|\n)\s*import[^;]*from\s+'[^']*'/g) ?? []
  check('types/wire.ts imports NOTHING (structural clones only)', imports.length === 0, imports.join(' | '))
}

section('§E sdkErrors.ts is the zero-dependency identity leaf')
{
  const src = readFileSync(join(ROOT, 'src/services/api/sdkErrors.ts'), 'utf8')
  const nonSdk = (src.match(/(^|\n)\s*(import|export)[^;]*from\s+'[^']*'/g) ?? []).filter(
    stmt => !stmt.includes("'@anthropic-ai/sdk'"),
  )
  check('sdkErrors.ts imports/re-exports ONLY from the SDK', nonSdk.length === 0, nonSdk.join(' | '))
}

section('§F the versioned SDK contract + the named compat projection (E03/E04)')
{
  const core = readFileSync(join(ROOT, 'src/entrypoints/sdk/coreTypes.ts'), 'utf8')
  check(
    'the Mercury SDK contract is VERSIONED (MERCURY_SDK_CONTRACT_VERSION exported)',
    /export const MERCURY_SDK_CONTRACT_VERSION = \d+/.test(core),
  )
  const mappers = readFileSync(join(ROOT, 'src/utils/messages/mappers.ts'), 'utf8')
  check(
    'the Mercury stream yield is a NAMED projection (mappers.ts declares it)',
    mappers.includes('THE MERCURY STREAM PROJECTION'),
  )
  const sdkHits = execSync(
    `grep -rln "from '@anthropic-ai/sdk" src/entrypoints/sdk --include='*.ts' || true`,
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
  check('the public SDK entrypoint imports no provider SDK (Mercury-native default)', sdkHits.length === 0, sdkHits.join(', '))
}

console.log(failures === 0 ? '\n ✅ IMPORT FENCE HOLDS' : `\n ❌ ${failures} FENCE BREAK(S)`)
process.exit(failures === 0 ? 0 : 1)

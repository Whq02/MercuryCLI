#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { buildToolCensus } = await import('../../src/utils/capability/census.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { TOOL_CAPABILITY_DECLARATIONS } = await import(
  '../../src/utils/capability/declarations.ts'
)
const { CAPABILITY_UNITS } = await import('../../src/utils/capability/census.ts')

console.log('── builtin-tools constitution gate ──')

const census = buildToolCensus()

const undeclared = census.rows.filter(r => r.declared === null).map(r => r.name)
check('every production tool declares a capability contract', undeclared.length === 0, undeclared.join(', '))

const invalid: string[] = []
for (const [name, cap] of Object.entries(TOOL_CAPABILITY_DECLARATIONS)) {
  const v = validateToolCapability(cap)
  if (!v.ok) invalid.push(`${name}: ${v.problems.join('; ')}`)
}
check('every estate declaration is structurally valid', invalid.length === 0, invalid.join(' · '))

const rowNames = new Set(census.rows.map(r => r.name))
const stale = Object.keys(TOOL_CAPABILITY_DECLARATIONS).filter(n => !rowNames.has(n))
check('no stale estate declarations (dead tool names)', stale.length === 0, stale.join(', '))

const unitSet = new Set<string>(CAPABILITY_UNITS)
const badUnits = census.rows
  .flatMap(r => (r.declared?.units ?? []).map(u => ({ name: r.name, u })))
  .filter(({ u }) => !unitSet.has(u))
  .map(({ name, u }) => `${name} → ${u}`)
check('declared units are in the closed vocabulary', badUnits.length === 0, badUnits.join('; '))

const opMismatch: string[] = []
for (const row of census.rows) {
  const d = row.declared
  if (!d?.operations) continue
}
const { getAllBaseTools } = await import('../../src/tools.ts')
const { toolMatchesName } = await import('../../src/Tool.ts')
const catalog = getAllBaseTools()
function extractOps(tool: { inputSchema: unknown }): string[] | null {
  try {
    const schema = tool.inputSchema as {
      shape?: Record<string, unknown> | (() => Record<string, unknown>)
    }
    const shapeRaw = schema?.shape
    const shape = typeof shapeRaw === 'function' ? shapeRaw() : shapeRaw
    let node = shape?.op as
      | { options?: unknown; unwrap?: () => unknown; _def?: { innerType?: unknown } }
      | undefined
    for (let i = 0; i < 4 && node; i++) {
      if (Array.isArray(node.options)) {
        return node.options.filter((o): o is string => typeof o === 'string')
      }
      node = (node._def?.innerType ?? node.unwrap?.()) as typeof node
    }
    return null
  } catch {
    return null
  }
}
for (const row of census.rows) {
  const d = row.declared
  if (!d?.operations) continue
  const tool = catalog.find(t => toolMatchesName(t, row.name))
  if (!tool) continue
  const zodOps = extractOps(tool)
  if (!zodOps) continue
  const declaredSet = [...d.operations].sort().join(',')
  const zodSet = [...zodOps].sort().join(',')
  if (declaredSet !== zodSet) {
    opMismatch.push(`${row.name}: declared [${declaredSet}] ≠ schema [${zodSet}]`)
  }
}
check('declared op vocabularies match the zod schema', opMismatch.length === 0, opMismatch.join(' · '))

const execGaps = census.rows
  .filter(r => r.declared?.class === 'execution' && !r.declared.execution)
  .map(r => r.name)
check("class 'execution' declares its execution integration", execGaps.length === 0, execGaps.join(', '))

const txnGaps = census.rows
  .filter(
    r =>
      r.declared?.class === 'mutation' &&
      r.declared.units.some(u => u === 'text-mutation' || u === 'structural-mutation') &&
      !r.declared.transaction,
  )
  .map(r => r.name)
check('file-mutating tools declare transactions', txnGaps.length === 0, txnGaps.join(', '))

const { resourceAdapterKinds } = await import('../../src/services/resources/registry.ts')
const kinds = new Set(resourceAdapterKinds().map((k: { kind: string }) => k.kind))
const resGaps = census.rows
  .flatMap(r => (r.declared?.resources ?? []).map(kind => ({ name: r.name, kind })))
  .filter(({ kind }) => !kinds.has(kind))
  .map(({ name, kind }) => `${name} → ${kind}`)
check('declared resource kinds are registered', resGaps.length === 0, resGaps.join('; '))

const gatedOut = census.rows.filter(r => !r.inCatalogNow)
check(
  'gated-out tools read unavailable (never silently absent, never empty)',
  gatedOut.every(r => r.support === 'unavailable'),
  gatedOut.filter(r => r.support !== 'unavailable').map(r => `${r.name}=${r.support}`).join(', '),
)
const conditioned = census.rows.filter(
  r => r.inCatalogNow && r.enabledNow && (r.declared?.conditions?.length ?? 0) > 0,
)
check(
  'condition-bearing enabled tools read conditional, not available',
  conditioned.every(r => r.support === 'conditional'),
  conditioned.filter(r => r.support !== 'conditional').map(r => `${r.name}=${r.support}`).join(', '),
)

const { existsSync } = await import('node:fs')
const { join, resolve } = await import('node:path')
const repoRoot = resolve(import.meta.dir, '..', '..')
for (const carrier of [
  'scripts/builtin-tools/prove-builtin-tools-census.ts',
]) {
  check(`graduation carrier exists: ${carrier}`, existsSync(join(repoRoot, carrier)))
}

console.log(
  failures === 0 ? 'builtin-tools constitution: ALL GREEN' : `builtin-tools constitution: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)

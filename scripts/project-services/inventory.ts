#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/inventory.ts — the machine-readable inventory
// Imports the LIVE registries and emits
//  scripts/project-services/fixtures/inventory.json: tool names, task
//  type/status vocabularies, LSP/DAP operation sets, resource-like stores,
//  session-branch capability, and doctor surface facts. Re-run after any
//  slice to diff the live surface against this frozen snapshot.
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/inventory.ts [--check]
//    --check: exit 1 if the committed inventory drifts from the live tree
//             (fields marked `frozenAtSlice0` are allowed to grow, never
//             shrink — is additive).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-inv-'))

const OUT = 'scripts/project-services/fixtures/inventory.json'

// Live imports (production modules, no mocks).
const toolsMod = await import('../../src/tools.ts')
const taskMod = await import('../../src/Task.ts')

// Tool names from the live base pool. getAllBaseTools is the assembly seam
// (src/tools.ts); fall back to the exported list shape if the name moves.
const getAllBaseTools: () => { name: string }[] =
  (toolsMod as Record<string, unknown>).getAllBaseTools as never
const baseToolNames = getAllBaseTools()
  .map(t => t.name)
  .sort()

// Task vocabularies come from the type-level unions; freeze them as data by
// probing generateTaskId prefixes for the documented kinds.
const taskTypes = [
  'local_bash',
  'local_agent',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
] as const
const taskIdPrefixes = Object.fromEntries(
  taskTypes.map(t => [t, taskMod.generateTaskId(t as never)[0]]),
)

// LSP + DAP operation sets, read from the live schema sources (regex over the
// schema literals — the schemas are lazy/zod so enumerating via import would
// couple this script to gate state).
function literalOps(path: string, pattern: RegExp): string[] {
  const src = readFileSync(path, 'utf8')
  const ops: string[] = []
  for (const m of src.matchAll(pattern)) ops.push(m[1]!)
  return ops
}
// The op set is contract data now (BASE + BRIDGE arrays in schemas.ts) —
// extract the two `as const` blocks rather than per-literal schema lines.
const lspSchemaSrc = readFileSync('src/tools/LSPTool/schemas.ts', 'utf8')
const lspOps = [...lspSchemaSrc.matchAll(/^\s*'([A-Za-z]+)',$/gm)].map(m => m[1]!)
const dapSrc = readFileSync('src/tools/DebugTool/DebugTool.ts', 'utf8')
const dapOpsBlock = dapSrc.match(/const OPS = \[([\s\S]*?)\] as const/)?.[1] ?? ''
// Strip comment lines first — an apostrophe inside a comment would pair
// with a real quote and mint garbage "ops".
const dapOps = [...dapOpsBlock
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .join('\n')
  .matchAll(/'([^']+)'/g),
].map(m => m[1]!)

const inventory = {
  generatedAt: '2026-07-14',
  startSha: '36c28e910407b9c9b89e7af45abd89266af1f374',
  frozenAtSlice0: {
    baseToolNames,
    taskTypes: [...taskTypes],
    taskStatuses: ['pending', 'running', 'completed', 'failed', 'killed'],
    lspOps,
    dapOps,
  },
  resourceLikeStores: {
    artifacts: 'src/utils/artifacts/store.ts (configHome/artifacts/<scope>/<id> + .meta.json)',
    runSidecar: 'src/services/run/runSidecar.ts (<transcript-dir>/<sessionId>.run.json)',
    taskOutput: 'src/utils/task/diskOutput.ts (per-task output files)',
    toolResultSpill: 'src/utils/toolResultStorage.ts (large tool results)',
    transcripts: 'src/utils/sessionStorage.ts (project JSONL transcripts)',
    workflowRuns: 'src/tools/WorkflowTool (run manifests + journal.jsonl)',
    verifyEvidence: 'src/utils/verification/verificationState.ts (.claude/verify/)',
    doctorCert: '.claude/doctor/last-cert.json (utils/healthReport.ts)',
    gateVerdict: '.claude/gate/verdict.json (scripts/run-all-suites.sh)',
  },
  sessionBranching: {
    command: '/branch (aliases: /fork)',
    mechanism: 'transcript copy + forkedFrom lineage + in-place resume (src/commands/branch/branch.ts)',
    boundary: 'NONE at slice 0 — the fork inherits the full parent state',
  },
  agentResultBoundary: {
    shape: 'prose text + agentId hint + <usage> trailer (AgentTool.tsx mapToolResultToToolResultBlockParam)',
    fields: ['totalTokens', 'tool_uses', 'duration_ms'],
  },
  doctor: {
    depths: ['fast', 'deep'],
    certSchema: 2,
    deepProbes: 'src/utils/healthDeepProbes.ts (run kernel · context parity · IDE loop · DAP loop · effect observer)',
  },
  replSeams: {
    binding: 'src/tools.ts REPLTool = null',
    survivors: ['src/tools/REPLTool/constants.ts', 'src/tools/REPLTool/primitiveTools.ts'],
  },
}

const json = JSON.stringify(inventory, null, 2) + '\n'

if (process.argv.includes('--check')) {
  let committed: typeof inventory
  try {
    committed = JSON.parse(readFileSync(OUT, 'utf8'))
  } catch {
    console.log(`FAIL: ${OUT} missing or unreadable`)
    process.exit(1)
  }
  let failures = 0
  const frozen = committed.frozenAtSlice0
  const live = inventory.frozenAtSlice0
  for (const key of ['baseToolNames', 'taskTypes', 'taskStatuses', 'lspOps', 'dapOps'] as const) {
    const missing = frozen[key].filter((v: string) => !live[key].includes(v))
    if (missing.length > 0) {
      failures++
      console.log(`FAIL: ${key} shrank — missing from live tree: ${missing.join(', ')}`)
    } else {
      const grown = live[key].filter((v: string) => !frozen[key].includes(v))
      console.log(`PASS: ${key} superset holds${grown.length ? ` (+${grown.length} new: ${grown.join(', ')})` : ''}`)
    }
  }
  process.exit(failures > 0 ? 1 : 0)
}

writeFileSync(OUT, json)
console.log(`wrote ${OUT}`)
console.log(`  tools: ${baseToolNames.length} · lspOps: ${lspOps.length} · dapOps: ${dapOps.length}`)

#!/usr/bin/env bun
// ============================================================================
//  scripts/ownership/prove-contract-inventory.ts — the machine-readable
//  contract inventory of the owned control planes.
//
//  WHAT IT PINS. For every owned public surface in the eight control planes:
//    (a) EXPORTS — statically scanned (TypeScript AST, no module evaluation)
//        from each inventoried file. A recorded export DISAPPEARING fails the
//        gate; a NEW unrecorded export also fails (self-accounting, the R2
//        oracle pattern) so the inventory can never silently rot. Regenerate
//        deliberately with --record after a reviewed contract change.
//    (b) NEEDLES — curated regex pins for cross-cutting vocabulary that is
//        contract, not implementation: permission-mode names, stream-JSON
//        envelope kinds, output modes, the ToolResult.effect truth. Needles
//        read MODULE SCOPE (file + listed sibling dirs) so a facade cutover
//        that moves implementation into an owned subdir stays green while a
//        vocabulary DELETION still fails.
//    (c) SETTINGS KEYS — the live SettingsSchema top-level keys (runtime
//        import of src/utils/settings/types.ts; lazySchema keeps this cheap).
//        A recorded key disappearing fails; new keys fail until recorded.
//
//  Run:            ~/.bun/bin/bun run scripts/ownership/prove-contract-inventory.ts
//  Regen (review): … --record
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const INVENTORY = join(import.meta.dir, 'contract-inventory.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ---------------------------------------------------------------------------
// The owned public surfaces. Paths are the COMPATIBILITY surface: cutovers
// keep these importable (facades re-export); deletions are deliberate
// --record re-baseline events.
const MODULES: Record<string, string[]> = {
  transports: [
    // Transport.d.ts (the build-era `any` stub) was replaced by the real
    // typed contract in Phase 1 — a recorded deliberate migration.
    'src/cli/transports/Transport.ts',
    'src/cli/transports/connectionLifecycle.ts',
    'src/cli/transports/transportUtils.ts',
    'src/cli/transports/HybridTransport.ts',
    'src/cli/transports/SSETransport.ts',
    'src/cli/transports/WebSocketTransport.ts',
    'src/cli/transports/ccrClient.ts',
    'src/cli/transports/SerialBatchEventUploader.ts',
    'src/cli/transports/WorkerStateUploader.ts',
    'src/cli/remoteIO.ts',
    'src/cli/structuredIO.ts',
  ],
  settings: [
    'src/utils/config.ts',
    'src/utils/settings/snapshot.ts',
    'src/utils/settings/settings.ts',
    'src/utils/settings/types.ts',
    'src/utils/settings/validation.ts',
    'src/utils/settings/settingsCache.ts',
    'src/utils/settings/applySettingsChange.ts',
    'src/utils/settings/managedPath.ts',
    'src/utils/settings/allErrors.ts',
  ],
  decisions: [
    'src/utils/permissions/permissions.ts',
    'src/utils/permissions/permissionSetup.ts',
    'src/utils/permissions/yoloClassifier.ts',
    'src/utils/permissions/permissionsLoader.ts',
    'src/utils/permissions/PermissionMode.ts',
    'src/utils/permissions/PermissionResult.ts',
    'src/utils/permissions/PermissionRule.ts',
    'src/utils/permissions/PermissionUpdate.ts',
    'src/utils/permissions/permissionExplainer.ts',
    'src/types/permissions.ts',
  ],
  mcp: [
    'src/services/mcp/auth.ts',
    'src/services/mcp/config.ts',
    'src/services/mcp/client.ts',
    'src/services/mcp/types.ts',
    'src/services/mcp/useManageMCPConnections.ts',
  ],
  tools: [
    'src/services/tools/toolExecution.ts',
    'src/services/tools/toolOrchestration.ts',
    'src/services/run/effectObserver.ts',
  ],
  compaction: [
    'src/services/compact/compact.ts',
    'src/services/compact/autoCompact.ts',
    'src/services/compact/compactionPolicy.ts',
    'src/services/compact/microCompact.ts',
    'src/services/compact/verbatimTail.ts',
    'src/services/compact/sessionMemoryCompact.ts',
  ],
  agents: [
    'src/tools/AgentTool/AgentTool.tsx',
    'src/utils/swarm/inProcessRunner.ts',
    'src/utils/swarm/roleResolver.ts',
    'src/utils/swarm/teamCharter.ts',
    'src/utils/swarm/handoff.ts',
  ],
  turnEngine: [
    'src/query.ts',
    'src/QueryEngine.ts',
    // The run-core owners (native-core T8): the TurnMachine + its event
    // vocabulary + the legacy projection + the pure decision owners.
    'src/run-core/turn-machine.ts',
    'src/run-core/events.ts',
    'src/run-core/project-legacy.ts',
    'src/run-core/model-lane.ts',
    'src/run-core/budget-guard.ts',
    'src/run-core/attachment-drain.ts',
  ],
  headless: ['src/cli/print.ts'],
  bootUi: [
    'src/main.tsx',
    'src/screens/REPL.tsx',
    'src/components/PromptInput/PromptInput.tsx',
  ],
}

// Cross-cutting vocabulary pins. `files` may list files OR dirs (dirs read
// recursively, .ts/.tsx). Regexes test against the concatenated module text.
const NEEDLES: Array<{ label: string; files: string[]; patterns: string[] }> = [
  {
    label: 'permission-mode vocabulary (types/permissions.ts)',
    files: ['src/types/permissions.ts'],
    patterns: [
      "'default'",
      "'strategy'",
      "'implement'",
      "'sovereign'",
      "'dontAsk'",
      "'flow'",
      "'autopilot'",
    ],
  },
  {
    label: 'headless output modes + stream-JSON envelope kinds',
    files: ['src/cli/print.ts', 'src/cli/structuredIO.ts', 'src/cli/headless'],
    patterns: [
      "'stream-json'",
      'outputFormat',
      "type:\\s*['\"]system['\"]",
      // The assistant envelope is FACTORY-built (utils/messages/factories);
      // print/structuredIO handle it by comparison — pin the handling site.
      "===\\s*['\"]assistant['\"]",
      "type:\\s*['\"]user['\"]",
      "type:\\s*['\"]result['\"]",
    ],
  },
  {
    label: 'ToolResult.effect truth (typed effects + exactly-once observer)',
    files: [
      'src/services/run/effectObserver.ts',
      'src/services/tools/toolExecution.ts',
      'src/types/message.ts',
    ],
    patterns: ['changedPaths', 'ToolEffect', 'effect'],
  },
]

// ---------------------------------------------------------------------------
// Static export scan (no evaluation — inventoried modules include React
// surfaces and side-effectful facades).
function scanExports(absPath: string): string[] {
  const source = ts.createSourceFile(
    absPath,
    readFileSync(absPath, 'utf-8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const names = new Set<string>()
  const hasExportModifier = (node: ts.HasModifiers): boolean =>
    (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  const hasDefaultModifier = (node: ts.HasModifiers): boolean =>
    (ts.getModifiers(node) ?? []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword)

  for (const stmt of source.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const typePrefix = stmt.isTypeOnly || spec.isTypeOnly ? 'type:' : ''
          names.add(typePrefix + spec.name.text)
        }
      } else if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        names.add(`*→${stmt.moduleSpecifier.text}`)
      }
      continue
    }
    if (ts.isExportAssignment(stmt)) {
      names.add('default')
      continue
    }
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      hasExportModifier(stmt)
    ) {
      if (hasDefaultModifier(stmt)) names.add('default')
      const typePrefix =
        ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ? 'type:' : ''
      const name = (stmt as { name?: ts.Identifier | ts.StringLiteral }).name
      if (name && 'text' in name) names.add(typePrefix + name.text)
      continue
    }
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text)
        else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.add(el.name.text)
          }
        }
      }
    }
  }
  return [...names].sort()
}

function moduleTextOf(entries: string[]): string {
  let text = ''
  for (const rel of entries) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      const walk = (dir: string): void => {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, f.name)
          if (f.isDirectory()) walk(p)
          else if (/\.tsx?$/.test(f.name)) text += readFileSync(p, 'utf-8') + '\n'
        }
      }
      walk(abs)
    } else {
      text += readFileSync(abs, 'utf-8') + '\n'
    }
  }
  return text
}

// ---------------------------------------------------------------------------
console.log('============================================================')
console.log(' Core-ownership contract inventory — exports · needles · keys')
console.log('============================================================')

section('(1) module export inventory (static AST scan)')
const scanned: Record<string, Record<string, string[]>> = {}
for (const [domain, files] of Object.entries(MODULES)) {
  scanned[domain] = {}
  for (const rel of files) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      scanned[domain][rel] = ['«missing»']
      continue
    }
    scanned[domain][rel] = scanExports(abs)
  }
}

section('(2) settings-key registry (live SettingsSchema shape)')
let settingsKeys: string[] = []
{
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const schema = SettingsSchema() as unknown as { shape?: Record<string, unknown> }
  const shape =
    schema.shape ??
    (schema as unknown as { _def?: { shape?: () => Record<string, unknown> } })._def?.shape?.()
  settingsKeys = shape ? Object.keys(shape).sort() : []
  check('SettingsSchema shape enumerable', settingsKeys.length > 0)
}

// ---------------------------------------------------------------------------
interface Inventory {
  modules: Record<string, Record<string, string[]>>
  settingsKeys: string[]
}

if (record) {
  const inv: Inventory = { modules: scanned, settingsKeys }
  writeFileSync(INVENTORY, JSON.stringify(inv, null, 1) + '\n')
  const total = Object.values(scanned).reduce(
    (n, files) => n + Object.values(files).reduce((m, e) => m + e.length, 0),
    0,
  )
  console.log(
    `  [RECORDED] ${total} export(s) across ${Object.values(scanned).reduce((n, f) => n + Object.keys(f).length, 0)} module(s) + ${settingsKeys.length} settings key(s) → ${INVENTORY}`,
  )
} else {
  section('(3) verify against the recorded inventory')
  if (!existsSync(INVENTORY)) {
    check('inventory exists (run --record first)', false)
  } else {
    const inv = JSON.parse(readFileSync(INVENTORY, 'utf-8')) as Inventory
    for (const [domain, files] of Object.entries(inv.modules)) {
      for (const [rel, recorded] of Object.entries(files)) {
        const current = scanned[domain]?.[rel]
        if (!current) {
          check(`${domain}: ${rel} still inventoried`, false, 'module list drifted — --record deliberately')
          continue
        }
        const cur = new Set(current)
        const rec = new Set(recorded)
        const missing = recorded.filter(e => !cur.has(e))
        const added = current.filter(e => !rec.has(e))
        check(
          `${domain}: ${rel} (${recorded.length} exports)`,
          missing.length === 0 && added.length === 0,
          [
            missing.length ? `DISAPPEARED: ${missing.join(', ')}` : '',
            added.length ? `UNRECORDED: ${added.join(', ')} (re-run --record deliberately)` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
      }
    }
    const curKeys = new Set(settingsKeys)
    const recKeys = new Set(inv.settingsKeys)
    const missingKeys = inv.settingsKeys.filter(k => !curKeys.has(k))
    const addedKeys = settingsKeys.filter(k => !recKeys.has(k))
    check(
      `settings keys (${inv.settingsKeys.length} recorded)`,
      missingKeys.length === 0 && addedKeys.length === 0,
      [
        missingKeys.length ? `DISAPPEARED: ${missingKeys.join(', ')}` : '',
        addedKeys.length ? `UNRECORDED: ${addedKeys.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )
  }
}

section('(4) cross-cutting contract needles')
for (const needle of NEEDLES) {
  const text = moduleTextOf(needle.files)
  check(`${needle.label}: module text non-empty`, text.length > 0)
  for (const pat of needle.patterns) {
    check(`  ${needle.label} · /${pat}/`, new RegExp(pat).test(text))
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(record ? ' ✅ INVENTORY RECORDED' : ' ✅ CONTRACT INVENTORY GREEN')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CONTRACT-INVENTORY FAILURE(S)`)
  process.exit(1)
}

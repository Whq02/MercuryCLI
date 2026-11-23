#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { FILE_TOOL_SPELLINGS } from '../identity/forbidden-file-tool.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const repoRoot = resolve(import.meta.dir, '..', '..')

const { toolCensus } = await import('./census-gen.ts')
const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
const { EXECUTION_DOMAIN_CENSUS } = await import(
  '../../src/engine/runtime-kernel/executionCensus.ts'
)
const { isMutationOperation } = await import(
  '../../src/tools/engines/change-transaction/contracts.ts'
)
const { resourceAdapterKinds } = await import('../../src/integrations/resources/registry.ts')

console.log('── arsenal census drift gate ──')

const { census } = toolCensus()

const missingProofs = census.rows
  .filter(r => r.proof !== null && !existsSync(join(repoRoot, r.proof)))
  .map(r => `${r.name} → ${r.proof}`)
check('every claimed proof path exists', missingProofs.length === 0, `${missingProofs.join('; ')} — point the tool's declared proof (src/permissions/capability/contract.ts) or PROOF_MAP (src/permissions/capability-census/census.ts) at a script that exists`)

const flagNames = new Set(FLAG_REGISTRY.map((f: { env: string }) => f.env))
const executionKinds = new Set(
  EXECUTION_DOMAIN_CENSUS.map((e: { kind?: string }) => e.kind).filter(Boolean),
)
const resourceKinds = new Set((await resourceAdapterKinds()).map((k: { kind: string }) => k.kind))

const badFlags: string[] = []
const badExecution: string[] = []
const badResources: string[] = []
const badTransactions: string[] = []
for (const row of census.rows) {
  const d = row.declared
  if (!d) continue
  if (d.gate && !flagNames.has(d.gate)) badFlags.push(`${row.name} → ${d.gate}`)
  if (d.execution && !executionKinds.has(d.execution.kind)) {
    badExecution.push(`${row.name} → ${d.execution.kind}`)
  }
  for (const kind of d.resources ?? []) {
    if (!resourceKinds.has(kind)) badResources.push(`${row.name} → ${kind}`)
  }
  if (d.transaction?.receipts && !isMutationOperation(`${d.transaction.kind}.probe`)) {
    badTransactions.push(`${row.name} → ${d.transaction.kind}`)
  }
}
check('declared gate flags exist in flagRegistry', badFlags.length === 0, `${badFlags.join('; ')} — fix the tool's declared gate, or add the flag to FLAG_REGISTRY in the flag registry`)
check(
  'declared execution kinds are census-classified',
  badExecution.length === 0,
  `${badExecution.join('; ')} — fix the tool's declared execution kind, or classify the kind in EXECUTION_DOMAIN_CENSUS (src/engine/runtime-kernel/executionCensus.ts)`,
)
check(
  'declared resource kinds are registered adapters',
  badResources.length === 0,
  `${badResources.join('; ')} — fix the tool's declared resource kind, or register the adapter in src/integrations/resources/registry.ts`,
)
check(
  'declared receipt-minting transaction kinds are in the receipt vocabulary',
  badTransactions.length === 0,
  `${badTransactions.join('; ')} — fix the tool's declared transaction kind, or add it to the mutation operations in src/tools/engines/change-transaction/contracts.ts`,
)

const ACKNOWLEDGED_UNDECLARED: string[] = [
]
const undeclared = census.rows.filter(r => r.declared === null).map(r => r.name)
const newUndeclared = undeclared.filter(n => !ACKNOWLEDGED_UNDECLARED.includes(n))
check(
  'no production tool without a declared capability contract (beyond the ratchet)',
  newUndeclared.length === 0,
  `undeclared: ${newUndeclared.join(', ')} — give each tool a declared capability (declaredCapability in src/permissions/capability/contract.ts)`,
)

type RetiredTool = { name: string; covered: string; aliases: string[]; references: RegExp[] }
const RETIRED_TOOLS: RetiredTool[] = [
  { name: FILE_TOOL_SPELLINGS[0], covered: 'the reply names a local file by its path', aliases: [], references: FILE_TOOL_SPELLINGS.map(name => new RegExp(name)) },
  { name: 'RememberLesson', covered: 'plain memory writing and RecordConvention cover it', aliases: [], references: [/RememberLesson/] },
  { name: 'LaunchFleet', covered: 'TaskCreate once per subtask covers it', aliases: [], references: [/LaunchFleet/] },
  {
    name: 'TaskOutput',
    covered: 'reading the task output file with Read covers it',
    aliases: ['AgentOutputTool', 'BashOutputTool'],
    references: [
      /\bTaskOutputTool\b/,
      /TASK_OUTPUT_TOOL_NAME/,
      /['"`]TaskOutput['"`]/,
      /^\s*TaskOutput\s*:/m,
      /^\| TaskOutput \|/m,
      /\b(?:AgentOutputTool|BashOutputTool)\b/,
      /\bTaskOutput (?:tool|shows|reads)\b/,
    ],
  },
  {
    name: 'SendUserMessage',
    covered: 'the reply itself reaches the operator; no courier tool and no brief mode',
    aliases: ['Brief'],
    references: [
      /\bSendUserMessage\b/,
      /(?<!Team)BriefTool\b/,
      /(?<!CREW_)BRIEF_TOOL_NAME\b/,
      /['"`]Brief['"`]/,
      /^\s*(?:Brief|SendUserMessage)\s*:/m,
      /^\| SendUserMessage \|/m,
      /\bisBriefOnly\b/,
      /\bbriefFilters\b/,
      /\bBriefIdleStatus\b/,
      /\bMERCURY_BRIEF\b/,
      /\bMERCURY_AUGUR/,
      /[Uu]serMsgOptIn/,
      /DISABLE_BRIEF_MODE_STOP_HOOK/,
      /brief[- ]mode|brief-only|brief-terminal|briefTerminalTurn/i,
    ],
  },
]
const RETIRED_SCAN_ROOTS = ['src', 'docs', 'scripts', 'design-system']
const RETIRED_SCAN_HISTORY =
  /^(?:src\/commands\/update-notes\/changelog\.ts|docs\/releases\/|scripts\/edit-tools\/fixtures\/baseline\.json|scripts\/builtin-tools\/prove-builtin-tools-census\.ts|scripts\/identity\/forbidden-file-tool\.ts|scripts\/transcript-rows\/prove-retired-tool-rows\.ts|scripts\/core-runtime\/prove-runloop-contract\.ts)/
const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|md|txt|sh|ya?ml|tsv|csv)$/
const trackedFiles = new Set(execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(rel => join(repoRoot, rel)))
function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      walk(path, out)
    } else if (TEXT_FILE.test(entry.name) && trackedFiles.has(path)) {
      out.push(path)
    }
  }
  return out
}
const survivors: string[] = []
for (const root of RETIRED_SCAN_ROOTS) {
  const dir = join(repoRoot, root)
  if (!existsSync(dir)) continue
  for (const file of walk(dir, [])) {
    const rel = file.slice(repoRoot.length + 1).split(sep).join('/')
    if (RETIRED_SCAN_HISTORY.test(rel)) continue
    const text = readFileSync(file, 'utf8')
    const hits = RETIRED_TOOLS.filter(t => t.references.some(re => re.test(rel) || re.test(text))).map(t => t.name)
    if (hits.length > 0) survivors.push(`${rel} (${hits.join(', ')})`)
  }
}
check(
  `no retired tool is referenced in src/, docs/, scripts/ or design-system/ (history pages aside): ${RETIRED_TOOLS.map(t => `${t.name} (${t.covered})`).join('; ')}`,
  survivors.length === 0,
  `${survivors.length} file(s): ${survivors.join('; ')} — delete the reference to the retired tool from each file listed`,
)
const retiredNames = new Set(RETIRED_TOOLS.flatMap(t => [t.name, ...t.aliases]))
check(
  'the live census rows name no retired tool',
  !census.rows.some(r => retiredNames.has(r.name)),
  `${census.rows.filter(r => retiredNames.has(r.name)).map(r => r.name).join(', ')} — remove the retired tool from getAllBaseTools in src/tools/kit/toolList.ts`,
)
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { findToolByName } = await import('../../src/tools/kit/tool.ts')
const { ALL_AGENT_DISALLOWED_TOOLS } = await import(
  '../../src/tools/kit/crewmateBarredTools.ts'
)
const catalogue = getAllBaseTools()
const offered = [...retiredNames].filter(n => findToolByName(catalogue, n) !== undefined)
check(
  'no route offers a retired tool or one of its old spellings: the catalogue resolves none of them',
  offered.length === 0,
  `resolved: ${offered.join(', ')} — remove the tool from getAllBaseTools in src/tools/kit/toolList.ts`,
)
const inAgentSets = [...retiredNames].filter(n => ALL_AGENT_DISALLOWED_TOOLS.has(n))
check('the crewmate barred set names no retired tool', inAgentSets.length === 0, `${inAgentSets.join(', ')} — remove the name from CREWMATE_BARRED_TOOLS in src/tools/kit/crewmateBarredTools.ts`)
const { getTools } = await import('../../src/tools/kit/toolList.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getIsInteractive, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
const interactiveBefore = getIsInteractive()
const briefBefore = process.env.MERCURY_BRIEF
process.env.MERCURY_BRIEF = '1'
const courierUnderSwitch: string[] = []
for (const interactive of [true, false]) {
  setIsInteractive(interactive)
  const pool = getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
  for (const name of ['SendUserMessage', 'Brief']) {
    if (findToolByName(pool, name) !== undefined) courierUnderSwitch.push(`${name} (${interactive ? 'interactive' : 'non-interactive'})`)
  }
}
setIsInteractive(interactiveBefore)
if (briefBefore === undefined) delete process.env.MERCURY_BRIEF
else process.env.MERCURY_BRIEF = briefBefore
check(
  'the switch that used to force the courier offers nothing: with MERCURY_BRIEF=1 the session pool holds neither SendUserMessage nor Brief in either posture',
  courierUnderSwitch.length === 0,
  `offered: ${courierUnderSwitch.join(', ')} — stop getTools in src/tools/kit/toolList.ts from offering the tool under MERCURY_BRIEF`,
)
check(
  'the census counts 71 production tools, including the separate ResumeCrewmate verb, the seven language-service tools, the Journal verb, the Video tool, the Document tool and the CrewBoard behind its swarm switch',
  census.summary.tools === 71,
  `live census: ${census.summary.tools} tools — if the tool set changed on purpose, update the count in this check, otherwise fix getAllBaseTools in src/tools/kit/toolList.ts`,
)

console.log(failures === 0 ? 'builtin-tools census: ALL GREEN' : `builtin-tools census: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

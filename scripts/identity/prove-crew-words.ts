#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const REPORT = process.argv.includes('--report')
const J = (...parts: string[]): string => parts.join('')

const WORD = new RegExp(J('(?<![\\w/:.<@-])', 'team', '(?:mate)?s?', '(?![\\w/<>@-])(?!\\.\\w)(?!:\\S)'), 'i')
const DOOR = new RegExp(J('(?<![\\w/:.<@-])/', 'team', 'mates\\b'))
const CAPITAL_LABEL = new RegExp(J('^', 'Team', '(?:mate)?s?$'))
const NOT_THE_CREW: Array<[RegExp, string]> = [
  [new RegExp(J('Claude ', 'Team')), 'the plan of that name'],
  [new RegExp(J('API ', 'team')), "the provider's own people"],
  [new RegExp(J('\\bred[ -]', 'team', '\\b'), 'i'), 'the adversarial verb'],
]

const WORKFLOW_HOME = 'src/tools/WorkflowTool/'
const OLD_TRANSCRIPT_RENDERERS = [
  'src/components/messages/UserTeammateMessage.tsx',
  'src/components/messages/AttachmentMessage.tsx',
  'src/components/messages/PlanApprovalMessage.tsx',
  'src/components/messages/nullRenderingAttachments.ts',
  'src/components/prompts-panel/rows.ts',
  'src/components/messages/ShutdownMessage.tsx',
  'src/utils/collapseTeammateShutdowns.ts',
]
const LOG_CALLEE = /^(?:logForDebugging|logError|logEvent|logWarn|logInfo|debugLog|console\.(?:log|error|warn|info|debug|trace))$/

type Row = { path: string; fragment: string | null; why: string }
const ALLOW: Row[] = [
  { path: 'src/tools/', fragment: null, why: "a tool's prompt.ts is its instructions to the model, not a screen" },
  { path: 'src/tools/SendMessageTool/', fragment: null, why: 'SendMessage keeps working exactly as it does now: its schema, words and results are frozen' },
  { path: 'src/tools/AgentTool/AgentTool.tsx', fragment: null, why: "the Agent tool's schema words, launch refusals and receipts are the model's; the one start road rewrites them" },
  { path: 'src/tools/AgentTool/agentMemory.ts', fragment: null, why: "the memory file's own header speaks of the people's team, not the crew" },
  { path: 'src/tools/ExitPlanModeTool/', fragment: null, why: "plan-mode tool results are the model's" },
  { path: 'src/tools/InspectTool/InspectTool.ts', fragment: null, why: 'the ref kinds it lists (mercury://team/…) are the wire' },
  { path: 'src/tools/TeamCreateTool/', fragment: null, why: 'the create step leaves with the team system' },
  { path: 'src/tools/TeamDeleteTool/', fragment: null, why: 'the delete step leaves with the team system' },
  { path: 'src/tools/TeamBriefTool/', fragment: null, why: 'the brief becomes live communication under its own name' },
  { path: 'src/tools/shared/spawnMultiAgent.ts', fragment: null, why: "the team spawn road's own errors; the crew's one start road replaces it" },
  { path: 'src/utils/swarm/', fragment: null, why: "the team system's own road — roster, mailbox, charter, panes, governance — rebuilt by the crew and renamed last" },
  { path: 'src/utils/messages/attachmentText.ts', fragment: null, why: 'attachment text is the model\'s' },
  { path: 'src/utils/cockpit/runtimePosture.ts', fragment: null, why: "the runtime-posture block is the model's system prompt" },
  { path: 'src/utils/cockpit/harnessMap.ts', fragment: 'mercury://<kind>/<id>', why: 'the ref kinds it lists are the wire' },
  { path: 'src/utils/tasks.ts', fragment: 'reassign them to', why: "a task tool's result is the model's" },
  { path: 'src/utils/permissions/filesystem.ts', fragment: null, why: 'permission rule patterns are paths' },
  { path: 'src/utils/vulcan/optable.generated.ts', fragment: null, why: 'generated from the coordination tools\' descriptions; follows its source' },
  { path: 'src/services/mcp/coordinationServer.ts', fragment: null, why: "MCP tool descriptions and results are the model's; the store beneath them moves to live communication" },
  { path: 'src/services/coordination/coordinationService.ts', fragment: null, why: 'the same coordination road' },
  { path: 'src/services/resources/adapters/team.ts', fragment: null, why: 'the mercury://team/ adapter renders for the Inspect tool, and its kind is the ref' },
  { path: 'src/entrypoints/sdk/coreSchemas.ts', fragment: null, why: "the SDK's hook payload fields keep their names and the words that describe them" },
  { path: 'src/cli/print.ts', fragment: null, why: "system reminders to a headless session are the model's" },
  { path: 'src/daemon/crewSpawn.ts', fragment: null, why: "the seat's system prompt and its roster record on disk" },
  { path: 'src/skills/bundled/', fragment: null, why: 'skill prompts are the model\'s' },
  { path: 'src/main.tsx', fragment: null, why: "the hidden spawn-identity options an older build's spawner passes; --help never shows them" },
  { path: 'src/constants/changelog.ts', fragment: null, why: 'past release notes stay as published' },
  { path: 'src/substrate/durableOperationMatrix.ts', fragment: null, why: 'names the on-disk paths and journal kinds an older build wrote, as written' },
  { path: 'src/substrate/recoveryOrchestrator.ts', fragment: null, why: 'recovery names the journal an older build wrote' },
  { path: 'src/commands/run/runInspectorModel.ts', fragment: 'journal:', why: 'the run inspector names that same journal' },
  { path: 'src/utils/healthReport.ts', fragment: 'daemon journals', why: 'the same journal in the health row' },
  { path: 'src/components/Settings/Config.tsx', fragment: 'Teammate mode', why: "the pane option's row leaves with it" },
  { path: 'src/components/Settings/Config.tsx', fragment: 'set teammate mode to', why: 'the same row\'s receipt' },
  { path: 'src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx', fragment: 'team-creation tool', why: 'the implement-the-plan turn is sent to the model; its create-step hint leaves with the create step' },
  { path: 'src/utils/capability/declarations.ts', fragment: 'charter', why: 'the rows of the create, delete and brief tools leave with them' },
  { path: 'src/components/TrustDialog/TrustDialog.tsx', fragment: 'your own code, your team', why: "the trust question speaks of the people's team, not the crew" },
  { path: 'src/commands/insights.ts', fragment: 'Team feedback', why: "the insights report's section for the people's team, not the crew" },
]

type Hit = { rel: string; line: number; text: string; allowed: Row | null }

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
}

function calleeText(node: ts.CallExpression): string {
  const e = node.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return `${ts.isIdentifier(e.expression) ? e.expression.text : '?'}.${e.name.text}`
  return '?'
}

function insideLog(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur !== undefined) {
    if (ts.isCallExpression(cur) && LOG_CALLEE.test(calleeText(cur))) return true
    if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return false
    cur = cur.parent
  }
  return false
}

function isModulePath(node: ts.Node): boolean {
  const p = node.parent
  if (p === undefined) return false
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true
  if (ts.isCallExpression(p) && (p.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(p.expression) && p.expression.text === 'require'))) return true
  return false
}

function isCopy(text: string, node?: ts.Node): boolean {
  if (node !== undefined && node.parent !== undefined && ts.isCallExpression(node.parent) && ts.isIdentifier(node.parent.expression) && /^plural/.test(node.parent.expression.text)) return true
  return /\s/.test(text) || CAPITAL_LABEL.test(text.trim())
}

function saysTeam(text: string): boolean {
  if (!(WORD.test(text) || DOOR.test(text))) return false
  let rest = text
  for (const [re] of NOT_THE_CREW) rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ')
  return WORD.test(rest) || DOOR.test(rest)
}

export function scanSource(rel: string, source: string): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Array<{ line: number; text: string }> = []
  const note = (node: ts.Node, text: string): void => {
    if (!isCopy(text, node) || !saysTeam(text)) return
    if (insideLog(node)) return
    out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.replace(/\s+/g, ' ').trim() })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModulePath(node)) note(node, node.text)
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      note(node, node.text)
    } else if (ts.isJsxText(node)) {
      note(node, node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' crew words — no product string says team or teammate')
console.log('============================================================')

console.log('— §0 the scanner bites (poison control) —')
{
  const poison = [
    "const a = 'no teammates yet';",
    'const t = <Text>this team has no members</Text>;',
    'const b = `${n} teammate${s} running`;',
    "const c = { group: 'Teammate' };",
    "const d = 'open the crew view (/teammates) and stop one';",
    'const e = `${who} joined the team`;',
    "const f = kind === 'teammate';",
    "const g = '--team-name <name>';",
    "const h = 'mercury://team/<name>';",
    "logForDebugging(`teammate ${name}: poll failed`);",
    "const i = 'Claude Team';",
    "const j = 'the red-team verifier';",
    "import x from './teamHelpers.js';",
    "const k = 'Payload: the teammate name and team name.';",
    "const l = 'the team-lead requested it';",
    "const m = plural(n, 'teammate');",
    "const o = 'reassign them to idle teammates.';",
    "const q = 'read src/utils/team.ts and teamHelpers.ts';",
    "const r = 'brief a chartered team';",
  ].join('\n')
  const lines = scanSource('poison.tsx', poison).map(h => h.line)
  const caught = [1, 2, 3, 4, 5, 6, 14, 16, 17, 19]
  check(`the sentences are caught (${caught.join(',')})`, caught.every(l => lines.includes(l)), lines.join(','))
  check('a kind token, a flag, a ref, a log line, the plan name, the verb, a module path and a hyphenated name never count', lines.every(l => caught.includes(l)), lines.filter(l => !caught.includes(l)).join(','))
}

console.log('— §1 the census —')
const files: string[] = []
walk(join(ROOT, 'src'), files)
const hits: Hit[] = []
let scanned = 0
for (const full of files) {
  const rel = relative(ROOT, full).split('\\').join('/')
  if (rel.startsWith(WORKFLOW_HOME)) continue
  if (OLD_TRANSCRIPT_RENDERERS.includes(rel)) continue
  scanned++
  const source = readFileSync(full, 'utf8')
  if (!/team/i.test(source)) continue
  for (const found of scanSource(rel, source)) {
    const row = ALLOW.find(r => (rel === r.path || rel.startsWith(r.path)) && (r.fragment === null || found.text.includes(r.fragment)) && (r.path !== 'src/tools/' || /\/prompt\.ts$/.test(rel))) ?? null
    hits.push({ rel, line: found.line, text: found.text, allowed: row })
  }
}
const unallowed = hits.filter(h => h.allowed === null)
const allowed = hits.filter(h => h.allowed !== null)
console.log(`  scanned ${scanned} files; ${hits.length} strings say the word, ${allowed.length} of them under a named reason`)
check(
  'no product string says team or teammate outside the workflow files and the old-transcript renderers',
  unallowed.length === 0,
  `${unallowed.length} found:` + unallowed.slice(0, 80).map(h => `\n      ${h.rel}:${h.line} ${h.text.slice(0, 110)}`).join('') + (unallowed.length > 80 ? `\n      … and ${unallowed.length - 80} more` : ''),
)
if (REPORT) {
  for (const row of ALLOW) {
    const under = allowed.filter(h => h.allowed === row)
    console.log(`  ${row.path}${row.fragment ? ` [${row.fragment}]` : ''} — ${row.why}: ${under.length}`)
    for (const h of under) console.log(`      ${h.rel}:${h.line} ${h.text.slice(0, 120)}`)
  }
}

console.log('— §2 the allow rows (a row whose path is gone is moot, never red: the merge deletes and renames these roads fold by fold) —')
const moot = ALLOW.filter(r => !existsSync(join(ROOT, r.path)))
const idle = ALLOW.filter(r => existsSync(join(ROOT, r.path)) && !allowed.some(h => h.allowed === r))
console.log(`  ${ALLOW.length} rows; ${moot.length} moot (path gone)${moot.length ? ': ' + moot.map(r => r.path).join(', ') : ''}; ${idle.length} idle (nothing left under them)${idle.length ? ': ' + idle.map(r => r.path + (r.fragment ? ` [${r.fragment}]` : '')).join(', ') : ''}`)
check('every allow row carries its reason', ALLOW.every(r => r.why.trim().length > 0))

console.log(failures === 0 ? '\nprove-crew-words: green' : `\nprove-crew-words: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

type Why = { why: string }
type Generator = { command: string[]; touches: string[] } & Why

const SELF = 'scripts/dev/rename-agent-tool-to-crewmate.ts'

const OLD_TOOL = 'Agent'
const NEW_TOOL = 'Crewmate'
const OLD_RESUME = 'ResumeAgent'
const NEW_RESUME = 'ResumeCrewmate'
const OLD_FIELD = 'subagent_type'
const NEW_FIELD = 'crewmate_type'

const SCOPE_ROOTS = ['src/', 'scripts/', 'docs/', 'design-system/', 'assets/', 'integrations/', 'sdk/']
const SCOPE_TOP_FILES = ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md']

const EXCLUDED_PATHS: Array<{ prefix: string } & Why> = [
  { prefix: 'docs/releases/', why: 'published release pages are history' },
  { prefix: 'src/constants/changelog.ts', why: 'past release notes stay as published' },
  { prefix: 'scripts/mission-runner/corpus/', why: 'fixture repositories of foreign source' },
  { prefix: 'scripts/interview/baselines/', why: 'frozen journey capture records keep their recorded bytes' },
  { prefix: 'scripts/visual-contract/baselines/', why: 'frozen capture records of earlier screens' },
  { prefix: 'scripts/agent-experience/baselines/', why: 'frozen mechanical baselines of earlier prompts: the tool names a past run offered' },
  { prefix: 'scripts/search/fixtures/', why: 'recorded web pages and search answers of other sites' },
  { prefix: SELF, why: 'the script itself carries both spellings by design' },
]

const FROZEN_FILES: Array<{ path: string } & Why> = [
  { path: 'scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', why: "an older build's transcript rows, unedited by design: the pin proves an old row reads as itself" },
  { path: 'scripts/bash/parser-corpus-parity.json', why: 'a parser corpus: each recorded command text is parsed again and compared to its recorded tree; the word is data to the parser' },
  { path: 'scripts/identity/prove-crewmate-tool-name.ts', why: 'the census composes the old names it hunts' },
  { path: 'scripts/crew/prove-old-tool-name-rows.ts', why: 'the pin drives an old transcript row under the old name by design' },
]

type FileRule = { path: string; protect: string[] } & Why
const FILE_RULES: FileRule[] = [
  { path: 'src/utils/hooks/hooksSettings.ts', protect: [OLD_TOOL], why: "the short word for a hook that came from an agent definition's frontmatter (beside Extension and Skill), not the tool" },
  { path: 'src/utils/model/agentModelPicker.ts', protect: [OLD_TOOL], why: "the agent model picker's group label for the agent definition being edited, not the tool" },
  { path: 'scripts/api/node-transport-lane.mjs', protect: [OLD_TOOL], why: "undici's dispatcher class, compared by its constructor name, not the tool" },
]

const EXPLICIT: Array<{ from: string; to: string } & Why> = [
  { from: 'with Agent if the work is still wanted', to: 'with Crewmate if the work is still wanted', why: "the resume verb's refusal names the launch tool" },
  { from: 'Agent starts a new crewmate with no context', to: 'Crewmate starts a new crewmate with no context', why: "the resume verb's prompt names the launch tool" },
  { from: 'the Agent model parameter', to: 'the Crewmate model parameter', why: "the provider usability note names the tool's parameter" },
  { from: "the Agent 'gpt' grammar", to: "the Crewmate 'gpt' grammar", why: "the sign-in note names the tool's model grammar" },
  { from: 'starts with Agent, Bash, Glob', to: 'starts with Crewmate, Bash, Glob', why: "the sessions page lists the first request's tools in roster order" },
  { from: 'No such tool available: Agent', to: 'No such tool available: Crewmate', why: 'the refusal of a tool outside the pool, with the tool named after the colon' },
  { from: '^Agent[+-]$', to: '^Crewmate[+-]$', why: "the deferral marks of the sent-prefix census, the tool name with its sign" },
  { from: 'Launch a crewmate (a sub-agent) to work through', to: 'Launch a crewmate to work through', why: 'the tool prompt the model reads: one word for the thing it launches' },
  { from: 'delegate a task to a crewmate (a sub-agent) that works on its own', to: 'delegate a task to a crewmate that works on its own', why: 'the search hint the model reads' },
  { from: 'Delegate a task to a crewmate (a sub-agent): a new agent that handles complex, multi-step work on its own', to: 'Delegate a task to a crewmate: a new agent that handles complex, multi-step work on its own', why: 'the description sentence the model reads, and every record of it' },
  { from: 'delegate a task to a crewmate (a sub-agent)', to: 'delegate a task to a crewmate', why: 'the ToolSearch intent the model searches by' },
  { from: 'handle single delegations with one sub-agent launch', to: 'handle single delegations with one crewmate launch', why: 'the Workflow tool prompt the model reads' },
  { from: 'Omitted, the configured sub-agent default applies', to: 'Omitted, the configured crewmate default applies', why: 'the Workflow tool prompt the model reads' },
  { from: 'same tool box as a background sub-agent', to: 'same tool box as a background crewmate', why: 'the Workflow tool prompt the model reads, and the proof that quotes it' },
  { from: 'coordinates a fleet of subagents with deterministic control flow', to: 'coordinates a fleet of crewmates with deterministic control flow', why: 'the Workflow tool prompt the model reads' },
  { from: 'fan out subagents', to: 'fan out crewmates', why: "the Workflow tool prompt's example of the operator's words" },
  { from: 'dispatch one subagent.', to: 'dispatch one crewmate.', why: 'the Workflow tool prompt the model reads' },
  { from: 'dispatch a custom subagent type', to: 'dispatch a custom crewmate type', why: 'the Workflow tool prompt the model reads' },
  { from: 'Directory where subagent transcripts are written during execution', to: 'Directory where crewmate transcripts are written during execution', why: "the Workflow tool's schema text the model reads" },
  { from: 'orchestrate subagents with deterministic JavaScript workflow', to: 'orchestrate crewmates with deterministic JavaScript workflow', why: "the Workflow tool's search hint" },
  { from: 'orchestrate many subagents deterministically', to: 'orchestrate many crewmates deterministically', why: "the Workflow tool's ToolSearch intent" },
  { from: 'run one subagent (options:', to: 'run one crewmate (options:', why: 'the Eval tool prompt the model reads' },
  { from: 'Delegation (subagents/workflows) is available', to: 'Delegation (crewmates/workflows) is available', why: 'the background-launch line the model reads' },
]

const PHRASES: Array<{ re: RegExp; to: string } & Why> = [
  { re: /(?<![\w$.\-/])([Aa])n Agent(?=[ -](?:call|launch|tool)(?![\w$-])|\((?=[A-Za-z*_{-]))/g, to: '$1 Crewmate', why: 'a call, launch, rule or mention of the tool with its article, which the new name changes' },
  { re: /(?<![\w$.\-/])Agent (call|launch|launched)(?![\w$-])/g, to: 'Crewmate $1', why: 'a call or launch of the tool, and the launch receipt\'s first line "Agent launched in the background."' },
  { re: /(?<![\w$.\-/])Agent(\s+)tool(?![\w$-])/g, to: 'Crewmate$1tool', why: 'the tool named by its name' },
  { re: /(?<![\w$.\-/])Agent-tool(?![\w$])/g, to: 'Crewmate-tool', why: 'the tool named by its name, hyphenated' },
  { re: /(?<![\w$.\-/])Agent (and|or) Workflow(?=\s+tool)/g, to: 'Crewmate $1 Workflow', why: 'the two spawn tools named together' },
  { re: /(?<!new )(?<![\w$.\-/])Agent\((?=[A-Za-z*_{-])/g, to: 'Crewmate(', why: 'the permission rule form Tool(content) and a call written out; never a constructor call (new Agent(…) is the undici class)' },
  { re: /(["'`])Agent\1/g, to: '$1Crewmate$1', why: 'the quoted tool name' },
  { re: /(?<![\w$.\-/])ResumeAgent(?![\w$])/g, to: NEW_RESUME, why: 'the resume verb named by its name' },
  { re: /(?<![\w$])subagent_type(?![\w$])/g, to: NEW_FIELD, why: 'the launch parameter the model writes' },
]

const COMMENT_SKIP_RE = /(?<![\w$.\-/])Agent(?:\s+tool|-tool| call| launch| launched|\s+(?:and|or) Workflow|\()|(["'`])Agent\1|(?<![\w$.\-/])ResumeAgent(?![\w$])/

const GENERATORS: Generator[] = [
  { command: ['scripts/builtin-tools/census-gen.ts'], touches: ['scripts/builtin-tools/fixtures/tool-census.json', 'scripts/builtin-tools/fixtures/tool-census.md'], why: 'the tool census lists every tool by name' },
  { command: ['scripts/project-services/inventory.ts'], touches: ['scripts/project-services/fixtures/inventory.json'], why: 'the inventory lists the tool names sorted' },
  { command: ['scripts/permissions/prove-flow-shortcuts-unchanged.ts', '--record'], touches: ['scripts/permissions/fixtures/flow-shortcuts.json'], why: 'the flow-shortcut record is keyed by tool name' },
  { command: ['scripts/splash/bake-menu.mjs'], touches: ['assets/splash/splash-core.mjs'], why: "the splash bakes the boot menu's summaries, which name the tool" },
]

const OWED_AFTER_COMMIT = [
  'bun scripts/tool-economy/prove-definition-corpus-parity.ts — the recorded corpus is rewritten textually above; green means the rewrite equals a fresh record. Red means another definition moved: record it again with --record (its recorder refuses an uncommitted src tree)',
]

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '.jsonl', '.md', '.txt', '.tsv', '.csv', '.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.sed', '.html', '.css', '.svg', '.xml', '.plist', '.ps1', '.cfg', '.ini'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'])

const HASH_COMMENT_EXTENSIONS = new Set(['.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.sed', '.ps1'])
const KEEP_HASH_RE = /^\s*#\s*(!|-\*-|gate-(class|watch|env|inputs):|shellcheck|type:|noqa|pragma|pylint|fmt:|ruff:|mypy:|flake8:)/

const OLD_RE = /Agent|subagent|sub-agent/

type Skip = { reason: string; text: string }
type Tally = { renamed: Map<string, number>; skips: Skip[] }
const tally = (): Tally => ({ renamed: new Map(), skips: [] })
function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}
function mergeTally(into: Tally, from: Tally, label: string): void {
  for (const [k, v] of from.renamed) bump(into.renamed, k, v)
  for (const s of from.skips) into.skips.push({ ...s, text: `${label}: ${s.text}` })
}

class Rewriter {
  protect = new Set<string>()

  forFile(rel: string): void {
    this.protect = new Set()
    for (const r of FILE_RULES) {
      if (r.path !== rel) continue
      for (const n of r.protect) this.protect.add(n)
    }
  }

  hashCommented(text: string, t: Tally): string {
    return text
      .split('\n')
      .map(line => (/^\s*#/.test(line) && !KEEP_HASH_RE.test(line) ? this.comment(line, t) : this.prose(line, t)))
      .join('\n')
  }

  wholeWord(word: string, t: Tally, context: string): string | null {
    if (word === OLD_TOOL) {
      if (this.protect.has(OLD_TOOL)) {
        t.skips.push({ reason: 'protected in this file (not the tool)', text: `${context}: ${word}` })
        return null
      }
      bump(t.renamed, `${OLD_TOOL}→${NEW_TOOL}`)
      return NEW_TOOL
    }
    if (word === OLD_RESUME) {
      bump(t.renamed, `${OLD_RESUME}→${NEW_RESUME}`)
      return NEW_RESUME
    }
    if (word === OLD_FIELD) {
      bump(t.renamed, `${OLD_FIELD}→${NEW_FIELD}`)
      return NEW_FIELD
    }
    return null
  }

  prose(text: string, t: Tally): string {
    if (!OLD_RE.test(text)) return text
    let out = text
    for (const e of EXPLICIT) {
      if (!out.includes(e.from)) continue
      out = out.split(e.from).join(e.to)
      bump(t.renamed, `${e.from}→${e.to}`)
    }
    for (const p of PHRASES) {
      const re = new RegExp(p.re.source, p.re.flags)
      out = out.replace(re, (match, ...rest) => {
        if (match === `'${OLD_TOOL}'` || match === `"${OLD_TOOL}"` || match === `\`${OLD_TOOL}\``) {
          if (this.protect.has(OLD_TOOL)) {
            t.skips.push({ reason: 'protected in this file (not the tool)', text: match })
            return match
          }
        }
        const groups = rest.slice(0, -2) as string[]
        const replaced = p.to.replace(/\$(\d)/g, (_, n: string) => groups[Number(n) - 1] ?? '')
        bump(t.renamed, `${match.replace(/\s+/g, ' ')}→${replaced.replace(/\s+/g, ' ')}`)
        return replaced
      })
    }
    return out
  }

  stringBody(body: string, t: Tally): string {
    if (body === OLD_TOOL || body === OLD_RESUME || body === OLD_FIELD) return this.wholeWord(body, t, 'string') ?? body
    return this.prose(body, t)
  }

  comment(text: string, t: Tally): string {
    if (!OLD_RE.test(text)) return text
    const hit = COMMENT_SKIP_RE.exec(text)
    if (hit !== null) t.skips.push({ reason: 'a comment names the old tool: not model-facing, and the commit hook refuses grown comment bytes', text: text.trim().split('\n').find(l => COMMENT_SKIP_RE.test(l))?.trim().slice(0, 120) ?? hit[0] })
    const re = new RegExp(PHRASES[PHRASES.length - 1]!.re.source, 'g')
    return text.replace(re, () => {
      bump(t.renamed, `${OLD_FIELD}→${NEW_FIELD}`)
      return NEW_FIELD
    })
  }
}

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })

function inScope(rel: string): boolean {
  return SCOPE_TOP_FILES.includes(rel) || SCOPE_ROOTS.some(r => rel.startsWith(r))
}
function excluded(rel: string): string | null {
  for (const e of EXCLUDED_PATHS) if (rel === e.prefix || rel.startsWith(e.prefix)) return e.why
  return null
}
function frozen(rel: string): string | null {
  for (const f of FROZEN_FILES) if (rel === f.path) return f.why
  return null
}

function scriptKindOf(rel: string): ts.ScriptKind {
  const ext = extname(rel)
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.jsx') return ts.ScriptKind.JSX
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

type LeafKind = 'identifier' | 'key' | 'string' | 'jsx' | 'regex'
type Leaf = { start: number; end: number; kind: LeafKind; open: number; close: number }

function delimiters(k: ts.SyntaxKind): [number, number] {
  if (k === ts.SyntaxKind.TemplateHead) return [1, 2]
  if (k === ts.SyntaxKind.TemplateMiddle) return [1, 2]
  if (k === ts.SyntaxKind.TemplateTail) return [1, 1]
  return [1, 1]
}

function keyName(node: ts.Node): boolean {
  const p = node.parent
  if (p === undefined) return false
  return (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isShorthandPropertyAssignment(p) || ts.isEnumMember(p) || ts.isMethodSignature(p)) && p.name === node
}

function leavesOf(sf: ts.SourceFile): Leaf[] {
  const out: Leaf[] = []
  const visit = (node: ts.Node): void => {
    let hasChild = false
    ts.forEachChild(node, child => {
      hasChild = true
      visit(child)
    })
    if (hasChild) return
    const k = node.kind
    let kind: LeafKind | null = null
    if (k === ts.SyntaxKind.Identifier) kind = keyName(node) ? 'key' : 'identifier'
    else if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead || k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail) kind = 'string'
    else if (k === ts.SyntaxKind.JsxText) kind = 'jsx'
    else if (k === ts.SyntaxKind.RegularExpressionLiteral) kind = 'regex'
    if (kind === null) return
    const [open, close] = delimiters(k)
    out.push({ start: node.getStart(sf), end: node.getEnd(), kind, open, close })
  }
  visit(sf)
  return out.sort((a, b) => a.start - b.start)
}

type FilePlan = { rel: string; text: string; newText: string; replacements: number }

class Planner {
  readonly rewriter = new Rewriter()
  readonly plans: FilePlan[] = []
  readonly t = tally()
  readonly perFile = new Map<string, number>()
  readonly files: string[]

  constructor(readonly root: string) {
    this.files = git(root, 'ls-files', '-z').split('\0').filter(Boolean)
  }

  private rewriteCode(rel: string, text: string, t: Tally): string {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel))
    const leaves = leavesOf(sf)
    let out = ''
    let last = 0
    const between = (a: number, b: number): string => this.rewriter.comment(text.slice(a, b), t)
    for (const leaf of leaves) {
      if (leaf.start < last) continue
      out += between(last, leaf.start)
      const raw = text.slice(leaf.start, leaf.end)
      if (leaf.kind === 'string') {
        const opener = raw.slice(0, leaf.open)
        const closer = raw.slice(raw.length - leaf.close)
        const body = raw.slice(leaf.open, raw.length - leaf.close)
        out += opener + this.rewriter.stringBody(body, t) + closer
      } else if (leaf.kind === 'key') {
        out += this.rewriter.wholeWord(raw, t, 'key') ?? raw
      } else if (leaf.kind === 'identifier') {
        out += raw === OLD_FIELD ? this.rewriter.wholeWord(raw, t, 'identifier') ?? raw : raw
      } else if (leaf.kind === 'regex') {
        const flagsAt = raw.lastIndexOf('/')
        out += '/' + this.rewriter.prose(raw.slice(1, flagsAt), t) + raw.slice(flagsAt)
      } else {
        out += this.rewriter.prose(raw, t)
      }
      last = leaf.end
    }
    return out + between(last, text.length)
  }

  planContents(): void {
    for (const rel of this.files) {
      if (!inScope(rel) || excluded(rel) !== null) continue
      const textual = TEXT_EXTENSIONS.has(extname(rel)) || rel.endsWith('run-all.sh') || rel.endsWith('members.txt')
      if (!textual || frozen(rel) !== null) continue
      const text = readFileSync(join(this.root, rel), 'utf8')
      if (!OLD_RE.test(text)) continue
      const t = tally()
      this.rewriter.forFile(rel)
      const ext = extname(rel)
      const newText = CODE_EXTENSIONS.has(ext) ? this.rewriteCode(rel, text, t) : HASH_COMMENT_EXTENSIONS.has(ext) ? this.rewriter.hashCommented(text, t) : this.rewriter.prose(text, t)
      let replacements = 0
      for (const n of t.renamed.values()) replacements += n
      mergeTally(this.t, t, rel)
      if (newText !== text) {
        this.plans.push({ rel, text, newText, replacements })
        this.perFile.set(rel, replacements)
      }
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const reportAt = args.indexOf('--report')
  const reportPath = reportAt !== -1 ? args[reportAt + 1] : undefined
  const rootAt = args.indexOf('--root')
  const root = resolve(rootAt !== -1 ? args[rootAt + 1]! : join(import.meta.dir, '..', '..'))
  const skipGenerators = args.includes('--no-generators')
  const showSkips = args.includes('--skips')

  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no').trim()
  if (dirty !== '') {
    console.error(`refused: the tree at ${root} has uncommitted changes to tracked files:\n${dirty}`)
    process.exit(2)
  }
  const head = git(root, 'rev-parse', 'HEAD').trim()
  const lines: string[] = []
  const say = (s: string): void => {
    lines.push(s)
    console.log(s)
  }
  say(`# rename the launch tool ${OLD_TOOL} → ${NEW_TOOL} (${OLD_RESUME} → ${NEW_RESUME}, ${OLD_FIELD} → ${NEW_FIELD}) — ${apply ? 'APPLY' : 'PLAN'} on ${root} at ${head}`)

  const planner = new Planner(root)
  planner.planContents()

  let total = 0
  for (const n of planner.perFile.values()) total += n
  say('')
  say(`## contents: ${planner.plans.length} files rewritten, ${total} replacements`)
  say('### distinct replacements (count, old→new)')
  for (const [k, v] of [...planner.t.renamed].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  say('### replacements per file')
  for (const [k, v] of [...planner.perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) say(`  ${v}\t${k}`)
  const reasons = new Map<string, number>()
  for (const s of planner.t.skips) bump(reasons, s.reason)
  say(`### skipped by reason (${planner.t.skips.length})`)
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  if (showSkips) {
    say('### every skip')
    for (const s of planner.t.skips) say(`  [${s.reason}] ${s.text}`)
  }
  say('')
  say('## the rules')
  say(`  a string, a JSON value, a Markdown line or a shell line: the whole word ${OLD_TOOL} in quotes, the forms "${OLD_TOOL} tool", "${OLD_TOOL}-tool", "an ${OLD_TOOL} call/launch", "${OLD_TOOL} and/or Workflow tool", the rule form ${OLD_TOOL}(…), the word ${OLD_RESUME}, the field ${OLD_FIELD}; an object or type key named ${OLD_TOOL} or ${OLD_RESUME}; the identifier ${OLD_FIELD} in every position`)
  say(`  never: the ordinary word agent, an identifier or folder carrying ${OLD_TOOL} (AgentTool, AGENT_TOOL_NAME, agentId, ResumeAgentTool), the undici class, mercury://agent/ refs, "${OLD_TOOL} Studio", "${OLD_TOOL} Client Protocol", a sentence that begins with the noun ("${OLD_TOOL} \\"name\\" was stopped")`)
  say(`  a comment: only ${OLD_FIELD} → ${NEW_FIELD} (the same length); every other old name in a comment is listed as a skip — the commit hook refuses a file whose comment bytes grow`)
  for (const p of PHRASES) say(`  phrase: ${p.re.source} → ${p.to} — ${p.why}`)
  for (const e of EXPLICIT) say(`  explicit: ${JSON.stringify(e.from)} → ${JSON.stringify(e.to)} — ${e.why}`)
  say('## exclusions')
  for (const e of EXCLUDED_PATHS) say(`  never touched: ${e.prefix} — ${e.why}`)
  for (const f of FROZEN_FILES) say(`  content kept: ${f.path} — ${f.why}`)
  for (const r of FILE_RULES) say(`  in ${r.path}: kept ${r.protect.join(', ')} — ${r.why}`)
  say('## generators run after the rewrite')
  for (const g of GENERATORS) say(`  ${g.command.join(' ')} → ${g.touches.join(', ')} — ${g.why}`)
  say('## owed after the apply is committed')
  for (const o of OWED_AFTER_COMMIT) say(`  ${o}`)

  if (!apply) {
    if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
    return
  }

  say('')
  say('## applying')
  const touched: string[] = []
  for (const p of planner.plans) {
    writeFileSync(join(root, p.rel), p.newText)
    touched.push(p.rel)
  }
  say(`  wrote ${planner.plans.length} files`)
  if (!skipGenerators) {
    for (const g of GENERATORS) {
      const cmd = g.command[0]!
      const abs = join(root, cmd)
      if (!existsSync(abs)) {
        say(`  generator absent: ${cmd}`)
        continue
      }
      try {
        execFileSync(process.execPath, ['run', abs, ...g.command.slice(1)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, env: { ...process.env, MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR ?? join(root, '.mercury', 'rename-scratch-home') } })
        say(`  regenerated: ${g.touches.join(', ')} — ${g.why}`)
      } catch (error) {
        say(`  GENERATOR FAILED: ${cmd} — ${String((error as Error).message).split('\n')[0]}`)
      }
      touched.push(...g.touches)
    }
  }
  const unique = [...new Set(touched)].filter(p => existsSync(join(root, p)))
  for (let i = 0; i < unique.length; i += 200) git(root, 'add', '--', ...unique.slice(i, i + 200))

  say('')
  say('## after')
  const status = git(root, 'status', '--porcelain', '-z').split('\0').filter(Boolean)
  const changed = status.map(s => s.slice(3))
  const forbidden = changed.filter(p => EXCLUDED_PATHS.some(e => (p === e.prefix || p.startsWith(e.prefix)) && e.prefix !== SELF))
  say(`  changed paths: ${status.length}`)
  say(`  paths changed inside an excluded area: ${forbidden.length}${forbidden.length > 0 ? ' — ' + forbidden.join(', ') : ''}`)
  const again = new Planner(root)
  again.planContents()
  say(`  a second pass would change: ${again.plans.length} (0 means the rewrite is idempotent)`)
  for (const p of again.plans.slice(0, 20)) say(`    ${p.rel}`)
  if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
  if (forbidden.length > 0 || again.plans.length > 0) process.exit(4)
}

main()

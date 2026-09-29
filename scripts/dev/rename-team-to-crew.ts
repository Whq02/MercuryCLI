#!/usr/bin/env bun
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, resolve } from 'node:path'

type Why = { why: string }
type Rule = { name: string } & Why
type Explicit = { from: string; to: string; re: RegExp } & Why
type AliasPatch = { file: string; find: string; replace: string; already: string } & Why
type Generator = { command: string[]; touches: string[] } & Why

const SELF = 'scripts/dev/rename-team-to-crew.ts'

const SCOPE_ROOTS = ['src/', 'scripts/', 'docs/', 'design-system/', 'assets/', 'integrations/']
const SCOPE_TOP_FILES = ['README.md', 'AGENTS.md', 'MERCURY.md', 'BUILD-NOTES.md', 'CONTRIBUTING.md', 'CLAUDE.md']

const EXCLUDED_PATHS: Array<{ prefix: string } & Why> = [
  { prefix: 'src/tools/WorkflowTool/', why: 'workflows do not change in any way: not their code' },
  { prefix: 'scripts/workflows/', why: 'workflows do not change in any way: not their proofs' },
  { prefix: 'docs/releases/', why: 'published release pages are history' },
  { prefix: 'scripts/mission-runner/corpus/', why: 'fixture repositories of foreign source' },
  { prefix: SELF, why: 'the script itself carries both spellings by design' },
]

const FROZEN_FILES: Array<{ path: string } & Why> = [
  { path: 'src/migrations/migrateConfigSpellings.ts', why: 'the table of retired global-config spellings names old keys by design' },
  { path: 'src/migrations/migrateSettingsSpellings.ts', why: 'the table of retired settings spellings names old keys by design' },
  { path: 'scripts/settings/prove-old-settings-keys-read.ts', why: 'the pin writes the old keys by design' },
  { path: 'scripts/substrate/prove-old-env-spellings-read.ts', why: 'the pin sets the old env spellings by design' },
  { path: 'scripts/sessionStorage/prove-old-transcript-kinds-parse.ts', why: 'the pin holds old transcript rows by design' },
]

const PINNED_PATHS: Array<{ path: string } & Why> = [
  { path: 'scripts/crew/team-world.ts', why: 'a workflow proof imports it by this path and workflow proofs do not change' },
  { path: 'src/commands/team/', why: 'the /team command is a public door beside /crew; its file keeps the command name' },
  { path: 'src/services/resources/adapters/team.ts', why: 'the mercury://team resource kind keeps its file beside the crew adapter that already exists' },
]

const PROTECTED_PATTERNS: Array<{ re: RegExp } & Why> = [
  { re: /formerly: '[^']*'/g, why: 'a flag row names the spelling an older build wrote' },
]

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.json', '.jsonl', '.md', '.txt', '.tsv', '.csv', '.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.sed', '.html', '.css', '.svg', '.xml', '.plist', '.ps1', '.cfg', '.ini'])
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'])

const PROTECTED_IDENTIFIERS: Rule[] = [
  { name: 'teamName', why: 'a key on every saved transcript row and session record (the writer stamps it; the picker classes by it)' },
  { name: 'isTeammate', why: 'a key on every saved session record' },
  { name: 'teamConfigPath', why: 'a key of the saved team_context attachment' },
  { name: 'team_name', why: 'the Agent tool parameter the model sends and old transcripts hold' },
  { name: 'teamAdapter', why: 'the mercury://team resource adapter beside the crew adapter that already exists' },
]

const PROTECTED_WORDS: Rule[] = [
  { name: 'TeamBrief', why: 'the old tool name an old transcript row carries; the reader keeps it as an alias' },
  { name: 'TeamCreate', why: 'the old tool name an old transcript row carries' },
  { name: 'TeamDelete', why: 'the old tool name an old transcript row carries' },
  { name: 'TeamMem', why: 'team memory is the human team of a repository, not the crew' },
  { name: 'TEAMMEM', why: 'the feature word of team memory' },
]

const PROTECTED_PREFIXES: Rule[] = [
  { name: 'teamMemory', why: 'team memory is the human team of a repository, not the crew' },
]

const PROTECTED_LITERALS: Rule[] = [
  { name: 'app:toggleTeammatePreview', why: 'a keybinding action id saved in operator keybinding files' },
  { name: 'teams', why: 'the folder name under the config home that saved teams live in' },
]

type FileRule = { path: string; protect?: string[]; map?: Record<string, string> } & Why
const FILE_RULES: FileRule[] = [
  { path: 'src/commands.ts', protect: ['team'], why: 'the /team command binding beside the crew command' },
  { path: 'src/commands/team/index.ts', protect: ['team'], why: 'the /team command binding' },
  { path: 'src/utils/auth.ts', protect: ['team'], why: 'the Claude Team plan tier keyed by its wire value' },
  { path: 'src/utils/cockpit/fleetGauge.ts', protect: ['teamRows'], why: 'the team-file rows beside the crew rows the gauge already lists' },
  { path: 'src/components/PromptInput/PromptInput.tsx', map: { viewedTeammate: 'viewedCrewmateTask' }, why: 'the viewed in-process task beside the viewed crewmate of the crew view' },
]

const explicit = (from: string, to: string, re: string, why: string): Explicit => ({ from, to, re: new RegExp(re, 'g'), why })
const EXPLICIT: Explicit[] = [
  explicit('TEAMS.md', 'CREW.md', '(?<![A-Za-z0-9])TEAMS\\.md(?![A-Za-z0-9])', 'the crew page name the brief names'),
]

const COLLAPSE: Array<[string, string]> = [
  ['CrewCrewmate', 'Crewmate'],
  ['crewCrewmate', 'crewmate'],
  ['CREW_CREWMATE', 'CREWMATE'],
  ['CrewCrew', 'Crew'],
  ['crewCrew', 'crew'],
  ['CREW_CREW', 'CREW'],
]

const ALIAS_PATCHES: AliasPatch[] = [
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'a flag spec may name the spelling an older build wrote',
    find: '  /** The env spelling. */\n  env: string\n',
    replace: '  /** The env spelling. */\n  env: string\n  formerly?: string\n',
    already: '  formerly?: string\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the one bounded reader honours the former spelling when the registered one is absent',
    find: '  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return process.env[spec.env]\n',
    replace: '  if (!spec) throw new Error(`flagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return process.env[spec.env] ?? (spec.formerly === undefined ? undefined : process.env[spec.formerly])\n',
    already: '  return process.env[spec.env] ?? (spec.formerly === undefined ? undefined : process.env[spec.formerly])\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'stampers and scrubbers carry both spellings so a child of an older build still reads the flag',
    find: '  if (!spec) throw new Error(`flagSpellings: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return [spec.env]\n',
    replace: '  if (!spec) throw new Error(`flagSpellings: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  return spec.formerly === undefined ? [spec.env] : [spec.env, spec.formerly]\n',
    already: '  return spec.formerly === undefined ? [spec.env] : [spec.env, spec.formerly]\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the paired delete removes both spellings',
    find: '  if (!spec) throw new Error(`deleteFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  delete process.env[spec.env]\n',
    replace: '  if (!spec) throw new Error(`deleteFlagEnv: unregistered flag ${env} — add it to FLAG_REGISTRY`)\n  for (const spelling of flagSpellings(env)) delete process.env[spelling]\n',
    already: '  for (const spelling of flagSpellings(env)) delete process.env[spelling]\n',
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the saved-crews home flag honours the spelling saved shells and older builds set',
    find: "  { env: 'MERCURY_CREWS_DIR', kind: 'value',",
    replace: "  { env: 'MERCURY_CREWS_DIR', formerly: 'MERCURY_TEAMS_DIR', kind: 'value',",
    already: "  { env: 'MERCURY_CREWS_DIR', formerly: 'MERCURY_TEAMS_DIR',",
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the crewmate surfaces flag honours the spelling saved shells and older builds set',
    find: "  { env: 'MERCURY_CREWMATES', kind: 'value',",
    replace: "  { env: 'MERCURY_CREWMATES', formerly: 'MERCURY_TEAMMATES', kind: 'value',",
    already: "  { env: 'MERCURY_CREWMATES', formerly: 'MERCURY_TEAMMATES',",
  },
  {
    file: 'src/substrate/flagRegistry.ts',
    why: 'the crewmate launch command flag honours the spelling saved shells and older builds set',
    find: "  { env: 'MERCURY_CREWMATE_COMMAND', kind: 'value',",
    replace: "  { env: 'MERCURY_CREWMATE_COMMAND', formerly: 'MERCURY_TEAMMATE_COMMAND', kind: 'value',",
    already: "  { env: 'MERCURY_CREWMATE_COMMAND', formerly: 'MERCURY_TEAMMATE_COMMAND',",
  },
  {
    file: 'src/migrations/migrateConfigSpellings.ts',
    why: 'a saved global config written under the old keys is read as the current keys',
    find: 'export const RETIRED_GLOBAL_CONFIG_KEYS: Readonly<Record<string, string>> = {\n',
    replace: "export const RETIRED_GLOBAL_CONFIG_KEYS: Readonly<Record<string, string>> = {\n  teammateMode: 'crewmateMode',\n  teammateDefaultModel: 'crewmateDefaultModel',\n",
    already: "  teammateMode: 'crewmateMode',\n",
  },
  {
    file: 'src/migrations/migrateSettingsSpellings.ts',
    why: 'a settings file with hooks under the old event key is read as the current key',
    find: 'export const RETIRED_SETTINGS_KEYS: readonly KeyRename[] = [\n',
    replace: "export const RETIRED_SETTINGS_KEYS: readonly KeyRename[] = [\n  { from: ['hooks', 'TeammateIdle'], to: ['hooks', 'CrewmateIdle'], value: 'same' },\n",
    already: "  { from: ['hooks', 'TeammateIdle'], to: ['hooks', 'CrewmateIdle'], value: 'same' },\n",
  },
]

const GENERATORS: Generator[] = [
  { command: ['scripts/ownership/prove-contract-inventory.ts', '--record'], touches: ['scripts/ownership/contract-inventory.json'], why: 'the export inventory is sorted by name' },
  { command: ['scripts/consistency-census/gen-basename-census.ts'], touches: ['scripts/consistency-census/basename-census.json'], why: 'the basename census is sorted' },
  { command: ['scripts/settings/gen-settings-schema.ts', '--out', 'scripts/settings/settings-schema.json'], touches: ['scripts/settings/settings-schema.json'], why: 'the settings schema follows the hook event key' },
  { command: ['scripts/engine-durability/prove-write-route-ratchet.ts', '--regen'], touches: ['scripts/engine-durability/write-routes.baseline.json'], why: 'the write-route baseline is keyed by file path' },
]

const TOKEN_RE = /TEAMMATES|TEAMMATE|TEAMS|TEAM|Teammates|Teammate|Teams|Team|teammates|teammate|teams|team/g
const TOKEN_TO: Record<string, string> = {
  TEAMMATES: 'CREWMATES',
  TEAMMATE: 'CREWMATE',
  TEAMS: 'CREWS',
  TEAM: 'CREW',
  Teammates: 'Crewmates',
  Teammate: 'Crewmate',
  Teams: 'Crews',
  Team: 'Crew',
  teammates: 'crewmates',
  teammate: 'crewmate',
  teams: 'crews',
  team: 'crew',
}

type Context = 'identifier' | 'string' | 'prose' | 'filename'

const isLower = (c: string): boolean => c >= 'a' && c <= 'z'
const isUpper = (c: string): boolean => c >= 'A' && c <= 'Z'
const isLetter = (c: string): boolean => isLower(c) || isUpper(c)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isAlnum = (c: string): boolean => isLetter(c) || isDigit(c)
const isWordChar = (c: string): boolean => isAlnum(c) || c === '_'
const isRunChar = (c: string): boolean => isWordChar(c) || c === '-'

function runAround(text: string, start: number, end: number, pred: (c: string) => boolean): [number, number] {
  let lo = start
  while (lo > 0 && pred(text[lo - 1]!)) lo--
  let hi = end
  while (hi < text.length && pred(text[hi]!)) hi++
  return [lo, hi]
}

type Skip = { reason: string; token: string; run: string }
type Tally = { renamed: Map<string, number>; skipped: Map<string, number>; skips: Skip[] }

const tally = (): Tally => ({ renamed: new Map(), skipped: new Map(), skips: [] })

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by)
}

function mergeTally(into: Tally, from: Tally, label: string): void {
  for (const [k, v] of from.renamed) bump(into.renamed, k, v)
  for (const [k, v] of from.skipped) bump(into.skipped, k, v)
  for (const s of from.skips) into.skips.push({ ...s, run: `${label}: ${s.run}` })
}

function applyExplicit(text: string, t: Tally): string {
  if (!text.includes('TEAMS.md')) return text
  let out = text
  for (const e of EXPLICIT) {
    out = out.replace(e.re, () => {
      bump(t.renamed, `${e.from}→${e.to}`)
      return e.to
    })
  }
  return out
}

function collapse(run: string): string {
  let out = run
  for (const [from, to] of COLLAPSE) if (out.includes(from)) out = out.split(from).join(to)
  return out
}

class Renamer {
  readonly kebabNames = new Set<string>()
  fileProtect = new Set<string>()
  fileMap: Record<string, string> = {}

  forFile(rel: string): void {
    this.fileProtect = new Set()
    this.fileMap = {}
    for (const r of FILE_RULES) {
      if (r.path !== rel) continue
      for (const n of r.protect ?? []) this.fileProtect.add(n)
      Object.assign(this.fileMap, r.map ?? {})
    }
  }
  readonly protectedIdentifiers = new Set(PROTECTED_IDENTIFIERS.map(r => r.name))
  readonly protectedWords = new Set(PROTECTED_WORDS.map(r => r.name))
  readonly protectedPrefixes = PROTECTED_PREFIXES.map(r => r.name)
  readonly protectedLiterals = new Set(PROTECTED_LITERALS.map(r => r.name))

  rewrite(text: string, ctx: Context, t: Tally): string {
    if (!/team/i.test(text)) return text
    let out = ''
    let last = 0
    const re = new RegExp(TOKEN_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index < last) continue
      const [lo, hi] = runAround(text, m.index, m.index + m[0].length, isRunChar)
      const run = text.slice(lo, hi)
      const newRun = this.rewriteRun(run, ctx, t)
      out += text.slice(last, lo) + newRun
      last = hi
      re.lastIndex = hi
    }
    return out + text.slice(last)
  }

  private rewriteRun(run: string, ctx: Context, t: Tally): string {
    const mapped = this.fileMap[run]
    if (mapped !== undefined && ctx === 'identifier') {
      bump(t.renamed, `${run}→${mapped}`)
      return mapped
    }
    let out = ''
    let last = 0
    let changed = false
    const re = new RegExp(TOKEN_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(run)) !== null) {
      const token = m[0]
      const start = m.index
      const end = start + token.length
      const verdict = this.decide(run, start, end, token, ctx)
      if (verdict.to === null) {
        bump(t.skipped, token)
        t.skips.push({ reason: verdict.reason, token, run })
        continue
      }
      out += run.slice(last, start) + verdict.to
      last = end
      changed = true
      bump(t.renamed, `${token}→${verdict.to}`)
    }
    if (!changed) return run
    return collapse(out + run.slice(last))
  }

  private decide(run: string, start: number, end: number, token: string, ctx: Context): { to: string | null; reason: string } {
    const prev = start > 0 ? run[start - 1]! : ''
    const next = end < run.length ? run[end]! : ''
    const form = token === token.toUpperCase() ? 'upper' : token[0] === 'T' ? 'cap' : 'lower'
    const no = (reason: string): { to: null; reason: string } => ({ to: null, reason })
    if (form === 'lower' && (isLetter(prev) || isLower(next))) return no('inside another word')
    if (form === 'cap' && isLower(next)) return no('inside another word')
    if (form === 'upper' && (isUpper(prev) || isUpper(next))) return no('inside another word')
    const [wlo, whi] = runAround(run, start, end, isWordChar)
    const word = run.slice(wlo, whi)
    if (this.fileProtect.has(word)) return no(`protected in this file: ${word}`)
    if (this.protectedIdentifiers.has(word)) return no(`protected identifier ${word}`)
    if (this.protectedWords.has(word)) return no(`protected word ${word}`)
    for (const p of this.protectedPrefixes) if (word.startsWith(p)) return no(`protected prefix ${p}`)
    if (ctx === 'filename') return { to: TOKEN_TO[token]!, reason: '' }
    if (form !== 'upper' && (prev === '_' || next === '_')) return no('a snake_case key stays')
    if (ctx === 'identifier') return { to: TOKEN_TO[token]!, reason: '' }
    if (prev === '-' || next === '-' || run.includes('-')) {
      if (this.kebabNames.has(run)) return { to: TOKEN_TO[token]!, reason: '' }
      return no('a dashed name that is not a renamed file')
    }
    const compound = isAlnum(prev) || isAlnum(next) || (form === 'upper' && (prev === '_' || next === '_'))
    if (!compound) return no(ctx === 'string' ? 'a bare word in a string' : 'a bare word in prose')
    return { to: TOKEN_TO[token]!, reason: '' }
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

function pinned(rel: string): string | null {
  for (const p of PINNED_PATHS) if (rel === p.path || rel.startsWith(p.path)) return p.why
  return null
}

function renamePath(rel: string, renamer: Renamer, t: Tally): string {
  if (pinned(rel) !== null) return rel
  const parts = rel.split('/')
  return parts
    .map((segment, i) => {
      const isFile = i === parts.length - 1
      const ext = isFile ? extname(segment) : ''
      const stem = isFile ? segment.slice(0, segment.length - ext.length) : segment
      const viaExplicit = applyExplicit(segment, t)
      if (viaExplicit !== segment) return viaExplicit
      return renamer.rewrite(stem, 'filename', t) + ext
    })
    .join('/')
}

type FilePlan = { rel: string; newRel: string; text: string | null; newText: string | null; replacements: number }

function scriptKindOf(rel: string): ts.ScriptKind {
  const ext = extname(rel)
  if (ext === '.tsx') return ts.ScriptKind.TSX
  if (ext === '.jsx') return ts.ScriptKind.JSX
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

type Leaf = { start: number; end: number; ctx: Context }

const KEY_TYPES = new Set(['Pick', 'Omit', 'Extract', 'Exclude'])

function keyPosition(node: ts.Node): boolean {
  const p = node.parent
  if (p === undefined) return false
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === node) return true
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InKeyword && p.left === node) return true
  if (!ts.isLiteralTypeNode(p)) return false
  let t: ts.Node = p
  while (t.parent !== undefined && (ts.isUnionTypeNode(t.parent) || ts.isParenthesizedTypeNode(t.parent))) t = t.parent
  const q = t.parent
  if (q === undefined) return false
  if (ts.isIndexedAccessTypeNode(q) && q.indexType === t) return true
  if (ts.isTypeReferenceNode(q) && q.typeArguments !== undefined && ts.isIdentifier(q.typeName)) {
    const idx = q.typeArguments.indexOf(t as ts.TypeNode)
    if (KEY_TYPES.has(q.typeName.text) && idx === 1) return true
    if (q.typeName.text === 'Record' && idx === 0) return true
  }
  return false
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
    let ctx: Context | null = null
    if (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.PrivateIdentifier) ctx = 'identifier'
    else if (k === ts.SyntaxKind.StringLiteral && keyPosition(node)) ctx = 'identifier'
    else if (
      k === ts.SyntaxKind.StringLiteral ||
      k === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle ||
      k === ts.SyntaxKind.TemplateTail ||
      k === ts.SyntaxKind.RegularExpressionLiteral
    ) ctx = 'string'
    else if (k === ts.SyntaxKind.JsxText) ctx = 'prose'
    if (ctx === null) return
    out.push({ start: node.getStart(sf), end: node.getEnd(), ctx })
  }
  visit(sf)
  return out.sort((a, b) => a.start - b.start)
}

const REPO_PATH_RE = /^(\.\.?\/|src\/|scripts\/|docs\/|design-system\/|assets\/|integrations\/)/
const TEXT_PATH_RE = /(?:\.\.?\/|(?<![A-Za-z0-9_./-])(?:src|scripts|docs|design-system|assets|integrations)\/)[A-Za-z0-9_./*-]+/g

class Planner {
  readonly renamer = new Renamer()
  readonly renameMap = new Map<string, string>()
  readonly dirMap = new Map<string, string>()
  readonly plans: FilePlan[] = []
  readonly t = tally()
  readonly perFile = new Map<string, number>()
  readonly files: string[]
  readonly collisions: string[] = []

  constructor(readonly root: string) {
    this.files = git(root, 'ls-files', '-z').split('\0').filter(Boolean)
  }

  planRenames(): void {
    const existing = new Set(this.files)
    const targets = new Map<string, string>()
    for (const rel of this.files) {
      if (!inScope(rel) || excluded(rel) !== null) continue
      const newRel = renamePath(rel, this.renamer, tally())
      if (newRel === rel) continue
      this.renameMap.set(rel, newRel)
      const stem = basename(rel, extname(rel))
      if (stem.includes('-')) this.renamer.kebabNames.add(stem)
      if (targets.has(newRel)) this.collisions.push(`${rel} and ${targets.get(newRel)} both become ${newRel}`)
      targets.set(newRel, rel)
      let from = posix.dirname(rel)
      let to = posix.dirname(newRel)
      while (from !== '.' && from !== to) {
        this.dirMap.set(from, to)
        from = posix.dirname(from)
        to = posix.dirname(to)
      }
    }
    for (const [from, to] of this.renameMap) {
      if (existing.has(to) && !this.renameMap.has(to)) this.collisions.push(`${from} would become ${to}, which exists`)
    }
  }

  private mapRepoPath(path: string): string {
    const exact = this.renameMap.get(path)
    if (exact !== undefined) return exact
    const star = path.indexOf('*')
    if (star !== -1) {
      const head = path.slice(0, star)
      const slash = head.lastIndexOf('/')
      const dirPart = slash === -1 ? '' : head.slice(0, slash)
      const stemPart = head.slice(slash + 1)
      const mappedDir = dirPart === '' ? '' : this.mapDir(dirPart)
      const renamedStem = stemPart !== '' && [...this.renameMap].some(([from]) => posix.dirname(from) === dirPart && basename(from).startsWith(stemPart))
      const stem = renamedStem ? this.renamer.rewrite(applyExplicit(stemPart, tally()), 'filename', tally()) : stemPart
      return (mappedDir === '' ? '' : `${mappedDir}/`) + stem + path.slice(star)
    }
    return this.mapDir(path)
  }

  private mapDir(path: string): string {
    let best: [string, string] | null = null
    for (const [from, to] of this.dirMap) {
      if (path === from || path.startsWith(`${from}/`)) if (best === null || from.length > best[0].length) best = [from, to]
    }
    if (best !== null) return best[1] + path.slice(best[0].length)
    return path
  }

  private mapPathString(raw: string, fromRel: string): string {
    if (!raw.includes('/') || !REPO_PATH_RE.test(raw)) return raw
    if (!raw.startsWith('.')) return this.mapRepoPath(raw)
    const dir = posix.dirname(fromRel)
    const target = posix.normalize(posix.join(dir, raw))
    const ext = extname(raw)
    const stems = ext === '.js' ? ['.ts', '.tsx', '.js'] : ext === '.mjs' ? ['.mts', '.mjs'] : ext === '' ? ['', '.ts', '.tsx'] : [ext]
    const bare = ext === '' ? target : target.slice(0, target.length - ext.length)
    for (const s of stems) {
      const mapped = this.renameMap.get(bare + s)
      if (mapped === undefined) continue
      const mappedBare = s === '' ? mapped : mapped.slice(0, mapped.length - extname(mapped).length)
      const back = posix.relative(dir, mappedBare) + ext
      return back.startsWith('.') ? back : `./${back}`
    }
    const mappedDir = this.mapRepoPath(target)
    if (mappedDir !== target) {
      const back = posix.relative(dir, mappedDir)
      return back.startsWith('.') ? back : `./${back}`
    }
    return raw
  }

  private resolvesToPinned(raw: string, fromRel: string): boolean {
    if (!raw.includes('/')) return false
    const target = raw.startsWith('.') ? posix.normalize(posix.join(posix.dirname(fromRel), raw)) : raw
    return pinned(target) !== null
  }

  private rewriteString(literal: string, fromRel: string, t: Tally): string {
    const q = literal[0]!
    const quoted = q === '\'' || q === '"' || q === '`'
    const body = quoted ? literal.slice(1, -1) : literal
    if (this.renamer.protectedLiterals.has(body)) {
      bump(t.skipped, `'${body}'`)
      t.skips.push({ reason: 'protected literal', token: body, run: body })
      return literal
    }
    if (this.resolvesToPinned(body, fromRel)) {
      t.skips.push({ reason: 'a path to a pinned file', token: body, run: body })
      return literal
    }
    const mapped = this.mapPathString(body, fromRel)
    const rewritten = this.renamer.rewrite(applyExplicit(mapped, t), 'string', t)
    return quoted ? q + rewritten + literal[literal.length - 1]! : rewritten
  }

  private masks(text: string): Array<[number, number]> {
    const out: Array<[number, number]> = []
    for (const p of PROTECTED_PATTERNS) {
      const re = new RegExp(p.re.source, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length])
    }
    return out
  }

  private rewriteCode(rel: string, text: string, t: Tally): string {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel))
    const leaves = leavesOf(sf)
    const masks = this.masks(text)
    const masked = (a: number, b: number): boolean => masks.some(([lo, hi]) => a < hi && b > lo)
    let out = ''
    let last = 0
    const piece = (a: number, b: number, ctx: Context): string => {
      const raw = text.slice(a, b)
      if (masked(a, b)) return raw
      if (ctx === 'string') return this.rewriteString(raw, rel, t)
      return this.renamer.rewrite(applyExplicit(raw, t), ctx, t)
    }
    for (const leaf of leaves) {
      if (leaf.start < last) continue
      out += piece(last, leaf.start, 'prose')
      out += piece(leaf.start, leaf.end, leaf.ctx)
      last = leaf.end
    }
    return out + piece(last, text.length, 'prose')
  }

  private rewriteText(rel: string, text: string, t: Tally): string {
    let out = ''
    let last = 0
    const re = new RegExp(TEXT_PATH_RE.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      out += this.renamer.rewrite(applyExplicit(text.slice(last, m.index), t), 'prose', t)
      out += this.rewriteString(m[0], rel, t)
      last = m.index + m[0].length
    }
    return out + this.renamer.rewrite(applyExplicit(text.slice(last), t), 'prose', t)
  }

  planContents(): void {
    for (const rel of this.files) {
      if (!inScope(rel) || excluded(rel) !== null) continue
      const newRel = this.renameMap.get(rel) ?? rel
      const textual = TEXT_EXTENSIONS.has(extname(rel)) || rel.endsWith('members.txt') || rel.endsWith('run-all.sh')
      if (!textual || frozen(rel) !== null) {
        if (newRel !== rel) this.plans.push({ rel, newRel, text: null, newText: null, replacements: 0 })
        continue
      }
      const text = readFileSync(join(this.root, rel), 'utf8')
      if (!/team/i.test(text)) {
        if (newRel !== rel) this.plans.push({ rel, newRel, text, newText: text, replacements: 0 })
        continue
      }
      const t = tally()
      this.renamer.forFile(rel)
      const newText = CODE_EXTENSIONS.has(extname(rel)) ? this.rewriteCode(rel, text, t) : this.rewriteText(rel, text, t)
      let replacements = 0
      for (const n of t.renamed.values()) replacements += n
      mergeTally(this.t, t, rel)
      if (newText !== text || newRel !== rel) {
        this.plans.push({ rel, newRel, text, newText, replacements })
        if (replacements > 0) this.perFile.set(rel, replacements)
      }
    }
  }
}

function applyAliasPatches(root: string, renameMap: Map<string, string>, log: string[]): { applied: number; already: number; missing: string[] } {
  let applied = 0
  let already = 0
  const missing: string[] = []
  for (const p of ALIAS_PATCHES) {
    const rel = renameMap.get(p.file) ?? p.file
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      missing.push(`${p.file}: file absent (${p.why})`)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    if (text.includes(p.already)) {
      already++
      continue
    }
    const at = text.indexOf(p.find)
    if (at === -1 || text.indexOf(p.find, at + 1) !== -1) {
      missing.push(`${p.file}: anchor ${at === -1 ? 'absent' : 'ambiguous'} for: ${p.why}`)
      continue
    }
    writeFileSync(abs, text.slice(0, at) + p.replace + text.slice(at + p.find.length))
    applied++
    log.push(`  patched ${rel}: ${p.why}`)
  }
  return { applied, already, missing }
}

function pruneEmptyDirs(root: string, rels: Iterable<string>): void {
  const dirs = new Set<string>()
  for (const rel of rels) {
    let d = posix.dirname(rel)
    while (d !== '.' && d !== '') {
      dirs.add(d)
      d = posix.dirname(d)
    }
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(root, d)
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs)
    } catch {
      continue
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
  say(`# rename team → crew — ${apply ? 'APPLY' : 'PLAN'} on ${root} at ${head}`)

  const planner = new Planner(root)
  planner.planRenames()
  planner.planContents()

  say('')
  say(`## files renamed: ${planner.renameMap.size}`)
  for (const [from, to] of [...planner.renameMap].sort()) say(`  ${from} → ${to}`)
  if (planner.collisions.length > 0) {
    say('## collisions')
    for (const c of planner.collisions) say(`  ${c}`)
  }
  const contentPlans = planner.plans.filter(p => p.newText !== null && p.newText !== p.text)
  let total = 0
  for (const n of planner.perFile.values()) total += n
  say('')
  say(`## contents: ${contentPlans.length} files rewritten, ${total} token replacements`)
  say('### distinct replacements (count, old→new)')
  for (const [k, v] of [...planner.t.renamed].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  say('### replacements per file')
  for (const [k, v] of [...planner.perFile].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  say('### skipped (token, count)')
  for (const [k, v] of [...planner.t.skipped].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  const reasons = new Map<string, number>()
  for (const s of planner.t.skips) bump(reasons, s.reason)
  say('### skipped by reason')
  for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1])) say(`  ${v}\t${k}`)
  if (showSkips) {
    say('### every skip')
    for (const s of planner.t.skips) say(`  [${s.reason}] ${s.run}`)
  }
  say('')
  say('## keys and flags')
  say('  settings.json: hooks.TeammateIdle → hooks.CrewmateIdle (a RETIRED_SETTINGS_KEYS row: the old key is read and rewritten once)')
  say('  global config: teammateMode → crewmateMode, teammateDefaultModel → crewmateDefaultModel (RETIRED_GLOBAL_CONFIG_KEYS rows: the old keys are read)')
  say('  env: MERCURY_TEAMS_DIR → MERCURY_CREWS_DIR (MERCURY_CREW_DIR already names the crew store), MERCURY_TEAMMATES → MERCURY_CREWMATES, MERCURY_TEAMMATE_COMMAND → MERCURY_CREWMATE_COMMAND (the former spelling is read when the current one is unset; stamps carry both)')
  say('## exclusions')
  for (const e of EXCLUDED_PATHS) say(`  never touched: ${e.prefix} — ${e.why}`)
  for (const f of FROZEN_FILES) say(`  content kept: ${f.path} — ${f.why}`)
  for (const p of PINNED_PATHS) say(`  name kept: ${p.path} — ${p.why}`)
  for (const r of PROTECTED_IDENTIFIERS) say(`  identifier kept: ${r.name} — ${r.why}`)
  for (const r of PROTECTED_WORDS) say(`  word kept: ${r.name} — ${r.why}`)
  for (const r of PROTECTED_PREFIXES) say(`  prefix kept: ${r.name}* — ${r.why}`)
  for (const r of PROTECTED_LITERALS) say(`  literal kept: '${r.name}' — ${r.why}`)
  for (const p of PROTECTED_PATTERNS) say(`  pattern kept: ${p.re.source} — ${p.why}`)
  for (const r of FILE_RULES) say(`  in ${r.path}: ${r.protect ? `kept ${r.protect.join(', ')}` : ''}${r.map ? Object.entries(r.map).map(([a, b]) => `${a} → ${b}`).join(', ') : ''} — ${r.why}`)
  say('  snake_case keys (team_context, teammate_mailbox, in_process_teammate, team_name, teammate_id, …) stay: saved rows and wire fields')
  say("  bare words in strings and prose stay (kinds such as 'teammate', the plan tier 'team', docs prose): the words on screen are changed where they are spoken, not here")
  say('  dashed names in strings and prose change only when they name a renamed file (CLI flags such as --team-name stay)')

  if (planner.collisions.length > 0) {
    say('refused: rename collisions above')
    if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
    process.exit(3)
  }
  if (!apply) {
    if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
    return
  }

  say('')
  say('## applying')
  const touched: string[] = []
  for (const [from, to] of planner.renameMap) {
    mkdirSync(dirname(join(root, to)), { recursive: true })
    git(root, 'mv', '-k', from, to)
    touched.push(to)
  }
  pruneEmptyDirs(root, planner.renameMap.keys())
  for (const p of planner.plans) {
    if (p.newText === null || p.newText === p.text) continue
    writeFileSync(join(root, p.newRel), p.newText)
    touched.push(p.newRel)
  }
  const patchLog: string[] = []
  const patches = applyAliasPatches(root, planner.renameMap, patchLog)
  for (const l of patchLog) say(l)
  say(`  alias patches: ${patches.applied} applied, ${patches.already} already present, ${patches.missing.length} missing`)
  for (const m of patches.missing) say(`  MISSING ANCHOR: ${m}`)
  for (const p of ALIAS_PATCHES) touched.push(planner.renameMap.get(p.file) ?? p.file)
  if (!skipGenerators) {
    for (const g of GENERATORS) {
      const cmd = g.command[0]!
      const abs = join(root, cmd)
      if (!existsSync(abs)) {
        say(`  generator absent: ${cmd}`)
        continue
      }
      try {
        execFileSync(process.execPath, ['run', abs, ...g.command.slice(1)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })
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
  const forbidden = changed.filter(p => EXCLUDED_PATHS.some(e => p.startsWith(e.prefix) && e.prefix !== SELF))
  say(`  changed paths: ${status.length}`)
  say(`  paths changed inside an excluded area: ${forbidden.length}${forbidden.length > 0 ? ' — ' + forbidden.join(', ') : ''}`)
  const again = new Planner(root)
  again.planRenames()
  again.planContents()
  const againChanges = again.plans.filter(p => p.newText !== null && p.newText !== p.text).length + again.renameMap.size
  say(`  a second pass would change: ${againChanges} (0 means the rewrite is idempotent)`)
  if (againChanges > 0) for (const p of again.plans.slice(0, 20)) say(`    ${p.rel}${p.newRel !== p.rel ? ` → ${p.newRel}` : ''}`)
  if (reportPath !== undefined) writeFileSync(reportPath, lines.join('\n') + '\n')
  if (forbidden.length > 0 || patches.missing.length > 0 || againChanges > 0) process.exit(4)
}

main()

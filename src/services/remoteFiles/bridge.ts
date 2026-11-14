import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { getEmptyToolPermissionContext, type ToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { parseRichFormatTarget } from '../../tools/FileReadTool/readRichFormats.js'
import type { PermissionDecision, PermissionRule } from '../../types/permissions.js'
import { getPathsForPermissionCheck } from '../../utils/fsOperations.js'
import {
  checkReadPermissionForTool,
  checkWritePermissionForTool,
  generateSuggestions,
  getMercuryTempDir,
  matchingRuleForInput,
  matchingRulesForInput,
  remoteFloorRefusal,
  ruleMatcherFor,
} from '../../utils/permissions/filesystem.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import { expandRuleBraces } from '../../utils/permissions/ruleBraces.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import { detectLineEndingsForString, type LineEndingType } from '../../utils/fileRead.js'
import type { ReadFileRangeResult } from '../../utils/readFileInRange.js'
import { notAFileRefusal } from '../../utils/regularFile.js'
import { resolveRemoteAuthority } from './connection.js'
import { remoteHostNames, renderRemoteHosts, sshUserConfigPath } from './hosts.js'
import {
  remoteAbsolutePath,
  remoteCat,
  remoteCommit,
  remoteFetch,
  remoteHas,
  remoteHasRipgrep,
  remoteIsThisMachine,
  remoteList,
  remoteMatching,
  remoteReadBytes,
  remoteReadRange,
  remoteRealPath,
  remoteStat,
  remoteWalk,
  RemoteFileError,
  type RemoteEntry,
  type RemoteKind,
  type RemoteLeaf,
} from './ops.js'
import {
  authorityText,
  formatRemotePath,
  parseRemotePath,
  REMOTE_FILE_NOT_FOUND,
  REMOTE_RULE_ROOT,
  remoteChild,
  remoteRuleAuthority,
  RemotePathError,
  type RemoteAuthority,
  type RemoteTarget,
} from './target.js'

type ToolType = 'read' | 'edit'

type Validation = { result: true } | { result: false; message: string; errorCode: number }

type RemoteAsk = ((path: string) => Promise<PermissionDecision>) | null

export type RemoteRead =
  | { kind: 'hosts'; path: string; content: string; numLines: number }
  | { kind: 'folder'; path: string; names: string[] | null; failure: string }
  | { kind: 'file'; path: string; size: number; lead: string; ranges?: string[] }

const HOSTS_ONLY_IN_READ = 'ssh:// alone is the list of hosts, which Read shows; a search needs a host: ssh://<host>/<folder>.'
const HOSTS_NOT_A_FILE = 'ssh:// alone is the list of hosts, which Read shows; Write and Edit need a file: ssh://<host>/<path>.'
const REMOTE_RULE = /\(\s*ssh:\/\//i
const READ_RULE_TOOLS: ReadonlySet<string> = new Set(['Glob', 'NotebookRead', 'Read'])

function remoteRulePatterns(rules: ToolPermissionContext): string[] {
  const patterns: string[] = []
  for (const bySource of [rules.alwaysAllowRules, rules.alwaysDenyRules, rules.alwaysAskRules]) {
    for (const list of Object.values(bySource ?? {})) {
      for (const rule of list ?? []) {
        if (!REMOTE_RULE.test(rule)) continue
        const content = permissionRuleValueFromString(rule).ruleContent
        if (content !== undefined) patterns.push(...expandRuleBraces(content, true))
      }
    }
  }
  return patterns
}

async function resolveNames(rules: ToolPermissionContext, authority: RemoteAuthority, signal: AbortSignal | undefined): Promise<void> {
  const named = new Map<string, RemoteAuthority>([[authorityText(authority), authority]])
  for (const pattern of remoteRulePatterns(rules)) {
    const strict = remoteRuleAuthority(pattern)
    if (strict !== null) named.set(authorityText(strict), strict)
  }
  await Promise.all([...named.values()].map(one => resolveRemoteAuthority(one, signal).catch(() => undefined)))
}

function judge(toolName: string, path: string, input: unknown, rules: ToolPermissionContext, toolType: ToolType): PermissionDecision {
  const tool = { name: toolName, getPath: () => path }
  return toolType === 'read' ? checkReadPermissionForTool(tool, input, rules) : checkWritePermissionForTool(tool, input, rules)
}

export async function remoteValidation(
  written: string,
  also: string | null,
  toolType: ToolType,
  verb: string,
  context: ToolUseContext,
  hostList = false,
): Promise<Validation> {
  let target: RemoteTarget | null
  try {
    target = parseRemotePath(written)
    if (also !== null) parseRemotePath(also)
  } catch (error) {
    if (!(error instanceof RemotePathError)) throw error
    return { result: false, message: error.message, errorCode: 1 }
  }
  if (target === null) return hostList ? { result: true } : { result: false, message: toolType === 'edit' ? HOSTS_NOT_A_FILE : HOSTS_ONLY_IN_READ, errorCode: 1 }
  const rules = context.getAppState().toolPermissionContext
  for (const form of also === null ? [written] : [written, also]) {
    const denied = matchingRuleForInput(form, rules, toolType, 'deny')
    if (denied) return { result: false, message: ruleSentence(`${verb} ${written.trim()}`, 'deny', denied), errorCode: 1 }
  }
  return { result: true }
}

function hostListPermission(input: unknown, rules: ToolPermissionContext): PermissionDecision {
  const decision = checkReadPermissionForTool({ name: 'Read', getPath: () => sshUserConfigPath() }, input, rules)
  if (decision.behavior !== 'ask' || decision.decisionReason?.type !== 'workingDir') return decision
  return { ...decision, decisionReason: { type: 'workingDir', reason: 'the host list is read from ~/.ssh/config' }, suggestions: [] }
}

export async function remotePermission(
  toolName: string,
  written: string,
  also: string | null,
  input: unknown,
  context: ToolUseContext,
  toolType: ToolType,
): Promise<PermissionDecision> {
  const rules = context.getAppState().toolPermissionContext
  let target: RemoteTarget | null
  try {
    target = parseRemotePath(written)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { behavior: 'deny', message, decisionReason: { type: 'other', reason: message } }
  }
  if (target === null) return hostListPermission(input, rules)
  const decisions = (also === null ? [written] : [written, also]).map(form => judge(toolName, form, input, rules, toolType))
  return decisions.find(decision => decision.behavior === 'deny') ?? decisions.find(decision => decision.behavior === 'ask') ?? decisions[0]!
}

function spelled(authority: RemoteAuthority, paths: readonly string[], home: string): string[][] {
  return [...new Set(paths)].map(path => {
    const forms = [formatRemotePath({ authority, home: null, path, folder: false })]
    if (home !== '/' && (path === home || path.startsWith(`${home}/`))) {
      forms.push(formatRemotePath({ authority, home: '', path: path.slice(home.length + 1), folder: false }))
    }
    return forms
  })
}

function homeOf(authority: RemoteAuthority, signal: AbortSignal | undefined): Promise<string> {
  return remoteAbsolutePath({ authority, home: '', path: '', folder: false }, signal)
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.source} ${JSON.stringify(rule.ruleValue)}`
}

function narrowingDenial(decision: PermissionDecision): boolean {
  return decision.behavior === 'deny' && decision.decisionReason.type === 'rule' && decision.decisionReason.rule.ruleBehavior === 'allow'
}

async function gate(
  toolName: string,
  target: RemoteTarget,
  toolType: ToolType,
  context: ToolUseContext,
  ask: RemoteAsk,
  signal: AbortSignal | undefined,
): Promise<{ here: boolean; spellings: string[][] }> {
  const rules = context.getAppState().toolPermissionContext
  const written = formatRemotePath(target)
  const answered = new Set(matchingRulesForInput(written, rules, toolType, 'ask').map(ruleKey))
  await resolveNames(rules, target.authority, signal)
  const decision = judge(toolName, written, {}, rules, toolType)
  if (decision.behavior === 'deny') throw new Error(decision.message)
  const reason = decision.decisionReason
  if (decision.behavior === 'ask' && reason?.type === 'rule' && !answered.has(ruleKey(reason.rule))) {
    answered.add(ruleKey(reason.rule))
    const answer = ask === null ? decision : await ask(written)
    if (answer.behavior !== 'allow') throw new Error((answer as { message?: string }).message ?? decision.message)
  }
  const here = await remoteIsThisMachine(target.authority, signal)
  const absolute = await remoteAbsolutePath(target, signal)
  const ruled = remoteRulePatterns(rules).length > 0
  const real = here || ruled ? await remoteRealPath(target, signal) : absolute
  const spellings = spelled(target.authority, [absolute, real], await homeOf(target.authority, signal))
  for (const forms of spellings) {
    if (here) {
      for (const form of forms) {
        const floor = remoteFloorRefusal(form, toolType, rules, true)
        if (floor !== null) throw new Error(floor)
      }
    }
    if (!ruled) continue
    const verdicts = forms.map(form => ({ form, decision: judge(toolName, form, {}, rules, toolType) }))
    const refused = verdicts.find(({ decision }) => decision.behavior === 'deny' && !narrowingDenial(decision))
    if (refused !== undefined) throw new Error((refused.decision as { message: string }).message)
    if (verdicts.every(({ decision }) => narrowingDenial(decision))) throw new Error((verdicts[0]!.decision as { message: string }).message)
    for (const { form, decision } of verdicts) {
      const reason = decision.decisionReason
      if (decision.behavior !== 'ask' || reason?.type !== 'rule' || answered.has(ruleKey(reason.rule))) continue
      answered.add(ruleKey(reason.rule))
      const answer = ask === null ? decision : await ask(form)
      if (answer.behavior !== 'allow') throw new Error((answer as { message?: string }).message ?? decision.message)
    }
  }
  return { here, spellings }
}

function narrowedTo(rules: ToolPermissionContext): ToolPermissionContext | null {
  const narrowing = rules.alwaysAllowRules.toolsNarrowing ?? []
  const reads = narrowing.some(rule => {
    const value = permissionRuleValueFromString(rule)
    return value.ruleContent !== undefined && READ_RULE_TOOLS.has(value.toolName)
  })
  return reads ? { ...rules, alwaysAllowRules: { toolsNarrowing: narrowing } } : null
}

function remoteReadFilter(rules: ToolPermissionContext, here: boolean): (forms: readonly string[]) => boolean {
  const denies = ruleMatcherFor(rules, 'read', 'deny')
  const narrowed = narrowedTo(rules)
  const allows = narrowed === null ? null : ruleMatcherFor(narrowed, 'read', 'allow')
  return forms => {
    if (forms.some(form => remoteFloorRefusal(form, 'read', rules, here) !== null)) return true
    if (denies !== null && forms.some(form => denies(form).length > 0)) return true
    if (narrowed === null) return false
    return !(allows !== null && forms.some(form => allows(form).length > 0))
  }
}

function childForms(folders: readonly string[][], name: string): string[] {
  return folders.flat().map(folder => {
    const target = parseRemotePath(folder)
    return target === null ? folder : formatRemotePath(remoteChild(target, name))
  })
}

function entryForms(authority: RemoteAuthority, folders: readonly string[][], entry: RemoteEntry, home: string): string[] {
  const forms = childForms(folders, entry.name)
  return entry.real === undefined ? forms : [...forms, ...spelled(authority, [entry.real], home).flat()]
}

function parentOf(target: RemoteTarget): RemoteTarget | null {
  if (target.path === '' || target.path === '/') return null
  const cut = target.path.lastIndexOf('/')
  if (target.home !== null) return { ...target, path: cut === -1 ? '' : target.path.slice(0, cut), folder: true }
  return { ...target, path: cut <= 0 ? '/' : target.path.slice(0, cut), folder: true }
}

function stemOf(name: string): string {
  return name.replace(/(?!^)\.[^.]*$/, '')
}

function plainName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
}

async function missingWords(target: RemoteTarget, here: boolean, context: ToolUseContext, signal: AbortSignal | undefined): Promise<string> {
  const words = `${REMOTE_FILE_NOT_FOUND} ${authorityText(target.authority)}.`
  const parent = parentOf(target)
  if (parent === null) return words
  try {
    const rules = context.getAppState().toolPermissionContext
    const name = target.path.slice(target.path.lastIndexOf('/') + 1)
    const refused = remoteReadFilter(rules, here)
    const folders = spelled(parent.authority, [await remoteAbsolutePath(parent, signal)], await homeOf(parent.authority, signal))
    const near = (await remoteList(parent, signal)).filter(
      entry => entry.name !== name && (stemOf(entry.name) === stemOf(name) || plainName(entry.name) === plainName(name)) && !refused(childForms(folders, entry.name)),
    )
    return near.length === 1 ? `${words} Did you mean ${formatRemotePath(remoteChild(parent, near[0]!.name))}?` : words
  } catch {
    return words
  }
}

function sshConfigReadable(file: string, rules: ToolPermissionContext): boolean {
  return getPathsForPermissionCheck(file).every(form => checkReadPermissionForTool({ name: 'Read', getPath: () => form }, {}, rules).behavior !== 'deny')
}

export async function remoteReadTarget(
  written: string,
  selector: { path: string; ranges: string[] } | null,
  context: ToolUseContext,
  ask: RemoteAsk,
  listFolders: boolean,
): Promise<RemoteRead> {
  const signal = context.abortController.signal
  const rules = context.getAppState().toolPermissionContext
  let target = parseRemotePath(written)
  if (target === null) return { kind: 'hosts', path: REMOTE_RULE_ROOT, ...renderRemoteHosts(remoteHostNames(file => sshConfigReadable(file, rules))) }
  let gated = await gate('Read', target, 'read', context, ask, signal)
  let stat = await remoteStat(target, signal, true)
  let ranges: string[] | undefined
  const stripped = stat === null && selector !== null ? parseRemotePath(selector.path) : null
  if (stripped !== null) {
    target = stripped
    ranges = selector!.ranges
    gated = await gate('Read', target, 'read', context, ask, signal)
    stat = await remoteStat(target, signal, true)
  }
  const path = formatRemotePath(target)
  if (stat === null || stat.kind === 'dangling') throw new Error(await missingWords(target, gated.here, context, signal))
  if (stat.kind === 'folder') {
    if (!listFolders) throw new RemoteFileError('EISDIR', `EISDIR: illegal operation on a directory, read '${path}'`)
    const refused = remoteReadFilter(rules, gated.here)
    const linked = gated.here || remoteRulePatterns(rules).length > 0
    let entries: RemoteEntry[]
    try {
      entries = await remoteList(target, signal, linked)
    } catch (error) {
      if (!(error instanceof RemoteFileError)) throw error
      return { kind: 'folder', path, names: null, failure: error.message }
    }
    const home = await homeOf(target.authority, signal)
    const names = entries
      .filter(entry => !refused(entryForms(target!.authority, gated.spellings, entry, home)))
      .map(entry => (entry.kind === 'folder' ? `${entry.name}/` : entry.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return { kind: 'folder', path, names, failure: '' }
  }
  if (stat.kind !== 'file') throw new Error(notAFileRefusal(path, stat.kind === 'other' ? 'a device' : stat.kind))
  return { kind: 'file', path, size: stat.size, lead: stat.lead, ...(ranges === undefined ? {} : { ranges }) }
}

function privateFolder(): string {
  const base = join(getMercuryTempDir(), 'remote-files')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  return mkdtempSync(join(base, `copy-${process.pid}-`))
}

function localName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (/^[A-Za-z0-9][A-Za-z0-9._ -]{0,118}$/.test(name) && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) return name
  const ending = /(?:\.tar)?\.[A-Za-z0-9]{1,12}$/.exec(name)?.[0] ?? ''
  return `remote${ending.toLowerCase()}`
}

export function remoteLeadLooks<Answer>(path: string, lead: string, look: (file: string) => Answer): Answer {
  const folder = privateFolder()
  try {
    const file = join(folder, localName(path))
    writeFileSync(file, Buffer.from(lead, 'hex'), { mode: 0o600 })
    return look(file)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

export async function remoteCopy<Answer>(path: string, signal: AbortSignal | undefined, read: (file: string) => Promise<Answer>): Promise<Answer> {
  const target = parseRemotePath(path)
  if (target === null) throw new RemotePathError(`${path} names no host.`)
  const folder = privateFolder()
  try {
    const file = join(folder, localName(path))
    await remoteFetch(target, file, signal)
    return await read(file)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const IGNORE_FILES = ['.gitignore', '.ignore', '.rgignore']
const VCS_FOLDERS: ReadonlySet<string> = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
const SNIFFED_ABOVE = 1024 * 1024

type RemoteMirror = {
  dir: string
  host: string
  deeper: boolean
  ripgrep: boolean
  rules: ToolPermissionContext
  matching(how: { ignoreCase: boolean; literal: boolean; multiline: boolean }, pattern: string, local: readonly string[]): Promise<string[] | null>
  pull(local: readonly string[], whole: ReadonlySet<string>): Promise<{ files: number; bytes: number }>
  rename<Value>(value: Value): Value
  close(): void
}

export function remoteSearchNames(patterns: readonly string[]): string[] | null {
  const names: string[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    const last = pattern.slice(pattern.lastIndexOf('/') + 1)
    if (!/^[A-Za-z0-9._*?-]+$/.test(last) || /^\*+$/.test(last)) return null
    names.push(last)
  }
  return names.length === 0 ? null : names
}

function localSegment(name: string): string {
  if (process.platform !== 'win32') return name
  const held = name.replace(/[<>:"|?*\\\u0000-\u001f]/g, char => String.fromCharCode(0xf000 + char.charCodeAt(0))).replace(/[. ]$/, char => String.fromCharCode(0xf000 + char.charCodeAt(0)))
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(held) ? `\uf8ff${held}` : held
}

function respelled<Value>(value: Value, spell: (text: string) => string): Value {
  if (typeof value === 'string') return spell(value) as Value
  if (Array.isArray(value)) return value.map(item => respelled(item, spell)) as Value
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, respelled(item, spell)])) as Value
  return value
}

export async function remoteMirror(
  toolName: string,
  written: string,
  context: ToolUseContext,
  ask: RemoteAsk,
  depth: number,
  names: readonly string[] | null,
  within = '',
): Promise<RemoteMirror> {
  const signal = context.abortController.signal
  const rules = context.getAppState().toolPermissionContext
  const given = parseRemotePath(written)
  if (given === null) throw new Error(HOSTS_ONLY_IN_READ)
  const outer = await gate(toolName, given, 'read', context, ask, signal)
  const host = authorityText(given.authority)
  const stat = await remoteStat(given, signal)
  if (stat === null || stat.kind === 'dangling') throw new Error(toolName === 'Glob' ? `There is no folder at that path on ${host}.` : `There is no file or folder at that path on ${host}.`)
  if (stat.kind === 'file' && toolName === 'Glob') throw new Error(`Path is not a directory: ${written.trim()}`)
  if (stat.kind !== 'folder' && stat.kind !== 'file') throw new Error(notAFileRefusal(formatRemotePath(given), stat.kind === 'other' ? 'a device' : stat.kind))
  const inner = within === '' || stat.kind !== 'folder' ? null : remoteChild(given, within)
  const deeper = inner !== null && (await remoteStat(inner, signal))?.kind === 'folder'
  const target = deeper ? { ...inner!, folder: true } : given
  const gated = deeper ? await gate(toolName, target, 'read', context, ask, signal) : outer
  const root = await remoteRealPath(target, signal)
  const named = names === null ? null : await remoteWalk(target.authority, root, depth, [...names, ...IGNORE_FILES, '.git'], signal)
  const walked =
    named !== null && named.markers.every(path => VCS_FOLDERS.has(path.slice(path.lastIndexOf('/') + 1))) ? named : await remoteWalk(target.authority, root, 0, null, signal)
  const filtering = gated.here || remoteRulePatterns(rules).length > 0 || narrowedTo(rules) !== null
  const refused = remoteReadFilter(rules, gated.here)
  const spellings = gated.spellings.flat().map(form => parseRemotePath(form)).filter((form): form is RemoteTarget => form !== null)
  const home = await homeOf(target.authority, signal)
  const allowed = (path: string): boolean => {
    if (!filtering) return true
    if (path === root) return !refused(gated.spellings.flat())
    if (path.startsWith(root === '/' ? '/' : `${root}/`)) {
      const name = path.slice(root === '/' ? 1 : root.length + 1)
      return !refused(spellings.map(form => formatRemotePath(remoteChild(form, name))))
    }
    return !refused(spelled(target.authority, [path], home).flat())
  }
  const base = realpathSync(privateFolder())
  const plainOf = (path: string): string => join(base, ...path.split('/').filter(Boolean))
  const localOf = (path: string): string => join(base, ...path.split('/').filter(Boolean).map(localSegment))
  const held = new Map<string, { leaf: RemoteLeaf; local: string }>()
  const remoteOf = new Map<string, string>()
  const escaped = new Map<string, string>()
  const fetched = new Set<string>()
  const made = new Set<string>()
  const folderOf = (local: string): void => {
    const folder = dirname(local)
    if (made.has(folder)) return
    mkdirSync(folder, { recursive: true })
    made.add(folder)
  }
  const stamp = (path: string): void => {
    const entry = held.get(path)
    if (entry !== undefined && entry.leaf.mtimeMs > 0) utimesSync(entry.local, entry.leaf.mtimeMs / 1000, entry.leaf.mtimeMs / 1000)
  }
  try {
    if (stat.kind === 'folder') mkdirSync(localOf(root), { recursive: true })
    for (const leaf of walked.files) {
      if (!allowed(leaf.path)) continue
      const first = localOf(leaf.path)
      const cut = first.lastIndexOf('.') > first.lastIndexOf(sep) + 1 ? first.lastIndexOf('.') : first.length
      let local = first
      folderOf(local)
      for (let attempt = 1; ; attempt++) {
        try {
          closeSync(openSync(local, 'wx', 0o600))
          break
        } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST' || attempt > 64) throw error
          local = `${first.slice(0, cut)}\uf8ff${attempt}${first.slice(cut)}`
        }
      }
      if (local !== plainOf(leaf.path)) escaped.set(local.normalize('NFC'), leaf.path)
      held.set(leaf.path, { leaf, local })
      remoteOf.set(local.normalize('NFC'), leaf.path)
      stamp(leaf.path)
    }
    const ignores = [...held.keys()].filter(path => IGNORE_FILES.includes(path.slice(path.lastIndexOf('/') + 1)))
    const ancestors: string[] = []
    for (let folder = root; folder !== '/'; ) {
      folder = folder.slice(0, folder.lastIndexOf('/')) || '/'
      ancestors.push(folder)
    }
    const under = (folder: string, name: string): string => `${folder === '/' ? '' : folder}/${name}`
    const repositories = await remoteHas(target.authority, ancestors.map(folder => under(folder, '.git')), signal)
    const markers = [...walked.markers.filter(path => path.endsWith('/.git')), ...ancestors.filter((_, index) => repositories[index]).map(folder => under(folder, '.git'))]
    for (const marker of markers) mkdirSync(localOf(marker), { recursive: true })
    const rulesFiles = [...ignores, ...ancestors.flatMap(folder => IGNORE_FILES.map(name => under(folder, name))), ...markers.map(marker => `${marker}/info/exclude`)].filter(allowed)
    await remoteCat(
      target.authority,
      rulesFiles.map(path => ({ path, sniff: false })),
      index => {
        const local = held.get(rulesFiles[index]!)?.local ?? localOf(rulesFiles[index]!)
        folderOf(local)
        fetched.add(rulesFiles[index]!)
        return local
      },
      signal,
    )
    for (const path of ignores) stamp(path)
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    throw error
  }
  const rootLocal = localOf(root)
  const shown = formatRemotePath(target).replace(/\/$/, '')
  const grants = generateSuggestions(join(base, 'x'), 'read', getEmptyToolPermissionContext()).flatMap(update => (update.type === 'addRules' ? update.rules : []))
  const remotes = (paths: Iterable<string>): string[] => [...new Set([...paths].map(path => remoteOf.get(path.normalize('NFC'))))].filter((path): path is string => path !== undefined)
  return {
    dir: rootLocal,
    host,
    deeper,
    ripgrep: await remoteHasRipgrep(target.authority, signal),
    rules: { ...getEmptyToolPermissionContext(), mode: rules.mode, alwaysAllowRules: { session: grants.map(rule => `${rule.toolName}(${rule.ruleContent})`) } },
    matching: async (how, pattern, local) => {
      const found = await remoteMatching(target.authority, how, pattern, remotes(local), signal)
      return found === null ? null : found.flatMap(path => (held.has(path) ? [held.get(path)!.local] : []))
    },
    pull: async (local, whole) => {
      const wholes = new Set(remotes(whole))
      const wanted = remotes(local).filter(path => !fetched.has(path))
      const got = await remoteCat(
        target.authority,
        wanted.map(path => ({ path, sniff: held.get(path)!.leaf.size > SNIFFED_ABOVE && !wholes.has(path) })),
        index => {
          fetched.add(wanted[index]!)
          return held.get(wanted[index]!)!.local
        },
        signal,
      )
      for (const path of wanted) stamp(path)
      return { files: got.read, bytes: got.bytes }
    },
    rename: value =>
      respelled(value, text => {
        let spelt = text
        for (const [local, remote] of escaped) spelt = spelt.replaceAll(local, plainOf(remote))
        if (!spelt.includes(rootLocal)) return spelt
        return spelt.split(rootLocal).map((part, index) => (index === 0 || sep === '/' ? part : part.replace(/^[^\n\0:]*/, tail => tail.replaceAll(sep, '/')))).join(shown)
      }),
    close: () => rmSync(base, { recursive: true, force: true }),
  }
}

type RemoteFound = { sum: string; mode: string | null }

export function remoteEntryRefusal(rawPath: string): string | null {
  try {
    parseRemotePath(rawPath)
  } catch (error) {
    if (error instanceof RemotePathError) return error.message
    throw error
  }
  const slash = rawPath.indexOf('/', rawPath.indexOf('://') + 3)
  const rich = slash === -1 ? null : parseRichFormatTarget(rawPath.slice(slash))
  return rich?.subtarget === undefined ? null : `${rawPath} names an entry inside an archive or a database on another machine, which Write and Edit do not change.`
}

export async function remoteWriteTarget(
  toolName: string,
  written: string,
  context: ToolUseContext,
  ask: RemoteAsk,
): Promise<{ path: string; kind: RemoteKind | 'missing'; size: number; missing: () => Promise<string> }> {
  const signal = context.abortController.signal
  const target = parseRemotePath(written)
  if (target === null) throw new Error(HOSTS_NOT_A_FILE)
  const gated = await gate(toolName, target, 'edit', context, ask, signal)
  const stat = await remoteStat(target, signal)
  return {
    path: formatRemotePath(target),
    kind: stat === null ? 'missing' : stat.kind,
    size: stat?.size ?? 0,
    missing: () => missingWords(target, gated.here, context, signal),
  }
}

export async function readWholeTextViaRemote(
  path: string,
  signal?: AbortSignal,
): Promise<{ content: string; rawContent: string; encoding: BufferEncoding; lineEndings: LineEndingType; losslessDecode: boolean; mtimeMs: number; found: RemoteFound }> {
  const target = parseRemotePath(path)
  if (target === null) throw new RemotePathError(`${path} names no host.`)
  const read = await remoteReadBytes(target, signal)
  const encoding: BufferEncoding = read.bytes.length >= 2 && read.bytes[0] === 0xff && read.bytes[1] === 0xfe ? 'utf16le' : 'utf8'
  const rawContent = read.bytes.toString(encoding)
  return {
    content: rawContent.replaceAll('\r\n', '\n'),
    rawContent,
    encoding,
    lineEndings: detectLineEndingsForString(rawContent.slice(0, 4096)),
    losslessDecode: Buffer.from(rawContent, encoding).equals(read.bytes),
    mtimeMs: read.mtimeMs,
    found: { sum: read.sum, mode: read.mode },
  }
}

export async function writeTextViaRemote(
  path: string,
  content: string,
  encoding: BufferEncoding,
  keepBom: boolean,
  found: RemoteFound | null,
  signal?: AbortSignal,
): Promise<{ finalContent: string; diverged: boolean; mtimeMs: number; generation: string }> {
  const target = parseRemotePath(path)
  if (target === null) throw new RemotePathError(`${path} names no host.`)
  const text = keepBom && content.charCodeAt(0) !== 0xfeff ? `\uFEFF${content}` : content
  const done = await remoteCommit(target, Buffer.from(text, encoding), found?.sum ?? null, found?.mode ?? null, signal)
  return { finalContent: content.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n'), diverged: false, mtimeMs: done.mtimeMs, generation: done.generation }
}

export async function readRangeViaRemote(
  path: string,
  offset?: number,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult & { lead: string }> {
  const target = parseRemotePath(path)
  if (target === null) throw new RemotePathError(`${path} names no host.`)
  return remoteReadRange(target, offset, maxLines, maxBytes, signal)
}

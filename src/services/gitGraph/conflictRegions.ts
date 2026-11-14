import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, lstatSync, openSync, readFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { recordCanonicalEvidence } from '../primitives/evidencePlane.js'
import type { CommitTarget } from '../changeTransaction/changeSetCommit.js'
import { git, gitStatus } from './observe.js'
import { gitArgs, gitFilterSkipMessages } from '../../utils/git/spawnArgs.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

type ConflictSide = 'ours' | 'theirs' | 'base' | 'both'
type RegionChoice = { region: string; take?: ConflictSide; content?: string }
export type ConflictRegion = {
  id: string
  path: string
  start: number
  end: number
  startLine: number
  endLine: number
  raw: string
  ours: { text: string; line: number }
  theirs: { text: string; line: number }
  base?: { text: string; line: number }
}

type RegionState = { roots: Map<string, Map<string, ConflictRegion[]>>; plans: Map<string, ResolutionPlan> }
const store = new OwnerScopedStore<RegionState>({ name: 'git-conflict-regions', create: () => ({ roots: new Map(), plans: new Map() }), cap: 32 })
registerOwnerScopedStore(store)
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

function parseRegions(file: string, text: string): ConflictRegion[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  offsets.push(offset)
  const out: ConflictRegion[] = []
  let start = -1
  let base = -1
  let middle = -1
  let width = 0
  let malformed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r?\n$/, '')
    const marker = /^(<{7,}|\|{7,}|={7,}|>{7,})(?: .*)?$/.exec(line)
    if (!marker) continue
    const chars = marker[1]!
    if (start !== -1 && chars.length !== width) continue
    if (chars[0] === '<') {
      if (start !== -1) { malformed = true; continue }
      start = i; base = -1; middle = -1; width = chars.length; malformed = false
      continue
    }
    if (start === -1) continue
    if (chars[0] === '|') {
      if (base !== -1 || middle !== -1) malformed = true
      else base = i
    } else if (chars[0] === '=') {
      if (middle !== -1) malformed = true
      else middle = i
    } else if (chars[0] === '>') {
      if (!malformed && middle !== -1) {
        const part = (from: number, to: number) => ({ text: text.slice(offsets[from], offsets[to]), line: from + 1 })
        out.push({ id: '', path: file, start: offsets[start]!, end: offsets[i + 1]!, startLine: start + 1, endLine: i + 1,
          raw: text.slice(offsets[start], offsets[i + 1]), ours: part(start + 1, base === -1 ? middle : base),
          theirs: part(middle + 1, i), ...(base === -1 ? {} : { base: part(base + 1, middle) }) })
      }
      start = -1
    }
  }
  return out
}

function filesFor(owner: OwnerKey, root: string): Map<string, ConflictRegion[]> {
  const roots = store.get(owner).roots
  let files = roots.get(root)
  if (!files) { files = new Map(); roots.set(root, files) }
  return files
}

export function readConflictRegions(owner: OwnerKey, root: string, file: string): ConflictRegion[] {
  const files = filesFor(owner, root)
  const absolute = path.join(root, file)
  let text: string
  try {
    if (!lstatSync(absolute).isFile()) { files.delete(file); return [] }
    const bytes = readFileSync(absolute)
    text = bytes.toString('utf8')
    if (!Buffer.from(text).equals(bytes)) { files.delete(file); return [] }
  } catch { files.delete(file); return [] }
  const parsed = parseRegions(file, text)
  const remaining = [...(files.get(file) ?? [])].filter(old => {
    const previousCount = files.get(file)!.filter(r => r.raw === old.raw).length
    const currentCount = parsed.filter(r => r.raw === old.raw).length
    return previousCount === currentCount || previousCount === 1
  })
  const regions = parsed.map(region => {
    const index = remaining.findIndex(old => old.raw === region.raw)
    const prior = index === -1 ? undefined : remaining.splice(index, 1)[0]
    return { ...region, id: prior?.id ?? `gr-${randomUUID().replaceAll('-', '')}` }
  })
  files.set(file, regions)
  return regions
}

function conflictRegion(owner: OwnerKey, root: string, id: string): ConflictRegion | undefined {
  for (const regions of store.peek(owner)?.roots.get(root)?.values() ?? []) {
    const found = regions.find(r => r.id === id)
    if (found) return found
  }
  return undefined
}

type ResolutionFile = {
  path: string
  before: Buffer
  after: Buffer
  mode: number
  selected: Array<{ region: string; startLine: number; endLine: number; content: string }>
  remaining: string[]
}
export type ResolutionPlan = {
  id: string
  owner: OwnerKey
  root: string
  choices: string
  indexPath: string
  index: Buffer
  files: ResolutionFile[]
}
type ResolutionRefusal = { state: 'refused'; reason: string }

export function prepareResolution(owner: OwnerKey, root: string, choices: RegionChoice[]): ResolutionPlan | ResolutionRefusal {
  const status = gitStatus(root)
  if ('state' in status) return { state: 'refused', reason: status.note }
  if (!choices.length) return { state: 'refused', reason: 'resolve needs at least one region' }
  const selected = new Set<string>()
  const grouped = new Map<string, Array<{ choice: RegionChoice; region: ConflictRegion }>>()
  for (const choice of choices) {
    if (selected.has(choice.region)) return { state: 'refused', reason: `region ${choice.region} is selected twice` }
    selected.add(choice.region)
    if ((choice.take === undefined) === (choice.content === undefined)) return { state: 'refused', reason: `region ${choice.region} needs take or content, not both` }
    const region = conflictRegion(owner, root, choice.region)
    if (!region || !status.files.some(f => f.path === region.path && f.kind === 'unmerged')) return { state: 'refused', reason: `region ${choice.region} is absent or stale — nothing written` }
    const group = grouped.get(region.path) ?? []
    group.push({ choice, region })
    grouped.set(region.path, group)
  }
  const files: ResolutionFile[] = []
  for (const [file, entries] of grouped) {
    const absolute = path.join(root, file)
    const mode = lstatSync(absolute).mode
    const before = readFileSync(absolute)
    const text = before.toString('utf8')
    const current = readConflictRegions(owner, root, file)
    const edits: ResolutionFile['selected'] = []
    let after = text
    const resolved: ConflictRegion[] = []
    for (const { choice, region } of entries) {
      const live = current.find(r => r.id === region.id)
      if (!live || live.raw !== region.raw) return { state: 'refused', reason: `region ${region.id} is stale — nothing written` }
      let replacement = choice.content
      if (choice.take) {
        if (choice.take === 'both') replacement = live.ours.text + live.theirs.text
        else if (choice.take === 'base' && !live.base) return { state: 'refused', reason: `region ${region.id} has no base section` }
        else replacement = live[choice.take]!.text
        if (live.end === text.length && !text.endsWith('\n')) replacement = replacement.replace(/\r?\n$/, '')
      }
      edits.push({ region: live.id, startLine: live.startLine, endLine: live.endLine, content: replacement! })
      resolved.push(live)
    }
    for (const region of [...resolved].sort((a, b) => b.start - a.start)) {
      after = after.slice(0, region.start) + edits.find(e => e.region === region.id)!.content + after.slice(region.end)
    }
    files.push({ path: file, before, after: Buffer.from(after), mode, selected: edits, remaining: current.filter(r => !selected.has(r.id)).map(r => r.id) })
  }
  const indexPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim())
  const index = readFileSync(indexPath)
  const id = `grp-${digest(JSON.stringify([root, choices, files.map(f => [f.path, digest(f.before), digest(f.after)]), digest(index)])).slice(0, 16)}`
  const plan: ResolutionPlan = { id, owner, root, choices: JSON.stringify(choices), indexPath, index, files }
  store.get(owner).plans.set(id, plan)
  return plan
}

export function observableResolution(root: string, choices: RegionChoice[]): ResolutionPlan | ResolutionRefusal {
  for (const owner of store.owners()) {
    if (choices.length && choices.every(c => conflictRegion(owner, root, c.region))) return prepareResolution(owner, root, choices)
  }
  return { state: 'refused', reason: 'selected regions are absent or stale — nothing written' }
}

export function storedResolution(owner: OwnerKey, id: string): ResolutionPlan | undefined {
  return store.peek(owner)?.plans.get(id)
}

export function resolutionPreview(plan: ResolutionPlan): string {
  return plan.files.flatMap(f => f.selected.map(r => `${f.path}:${r.startLine}-${r.endLine} ${r.region} → ${JSON.stringify(r.content)}`)).join('\n')
}

export async function applyResolution(plan: ResolutionPlan, signal?: AbortSignal): Promise<{ state: 'ok'; detail: string; changedPaths: string[] } | ResolutionRefusal> {
  const { root } = plan
  let lock: number | undefined
  const lockPath = `${plan.indexPath}.lock`
  const temporary = `${plan.indexPath}.mercury-${randomUUID()}`
  const stale = () => ({ state: 'refused' as const, reason: `${plan.id} is stale — nothing written` })
  try {
    if (signal?.aborted) return { state: 'refused', reason: 'resolution cancelled — nothing written' }
    lock = openSync(lockPath, 'wx', 0o600)
    if (!readFileSync(plan.indexPath).equals(plan.index) || plan.files.some(f => !readFileSync(path.join(root, f.path)).equals(f.before))) return stale()
    const targets: CommitTarget[] = plan.files.map(f => ({ canonicalPath: path.join(root, f.path), originalBytes: f.before, plannedBytes: f.after, originalDigest: digest(f.before), plannedDigest: digest(f.after), mode: f.mode & 0o7777 }))
    const final = plan.files.filter(f => f.remaining.length === 0 && parseRegions(f.path, f.after.toString('utf8')).length === 0)
    if (final.length) {
      copyFileSync(plan.indexPath, temporary)
      const env = { ...subprocessEnv(), GIT_INDEX_FILE: temporary }
      const indexed = (args: string[], input?: Buffer) => execFileSync('git', gitArgs(args, root), { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30_000, input, stdio: ['pipe', 'pipe', 'pipe'] })
      for (const f of final) {
        const oid = indexed(['hash-object', '-w', '--stdin', `--path=${f.path}`], f.after).trim()
        indexed(['update-index', '--add', '--cacheinfo', f.mode & 0o111 ? '100755' : '100644', oid, f.path])
      }
      const planned = readFileSync(temporary)
      targets.push({ canonicalPath: plan.indexPath, originalBytes: plan.index, plannedBytes: planned, originalDigest: digest(plan.index), plannedDigest: digest(planned), mode: lstatSync(plan.indexPath).mode & 0o7777 })
    }
    const { runTextChangeSetCommit } = await import('../changeTransaction/changeSetCommit.js')
    const outcome = await runTextChangeSetCommit({ ownerKey: plan.owner, source: 'git.resolve', planDigest: plan.id, targets, signal })
    if (outcome.kind === 'stale') return stale()
    if (outcome.kind !== 'committed' && outcome.kind !== 'replayed') return { state: 'refused', reason: `${outcome.kind}${'reason' in outcome ? `: ${outcome.reason}` : ' — nothing written'}` }
    const remaining: string[] = []
    const files = filesFor(plan.owner, root)
    for (const f of plan.files) {
      files.set(f.path, (files.get(f.path) ?? []).filter(r => !f.selected.some(s => s.region === r.id)))
      remaining.push(...readConflictRegions(plan.owner, root, f.path).map(r => r.id))
    }
    const ev = recordCanonicalEvidence({ owner: plan.owner, kind: 'change', origin: 'observed', claim: `resolved ${plan.files.reduce((n, f) => n + f.selected.length, 0)} conflict region(s); ${final.length} file(s) staged; ${remaining.length} region(s) remain`, refs: ['mercury://git/status'], details: { files: plan.files.map(f => f.path), staged: final.map(f => f.path), remaining } })
    return { state: 'ok', changedPaths: plan.files.map(f => path.join(root, f.path)), detail: [`resolved regions — bytes written: ${plan.files.map(f => f.path).join(', ')}; staged: ${final.map(f => f.path).join(', ') || '(none)'}; unresolved regions: ${remaining.join(', ') || '(none)'}; evidence mercury://evidence/${ev.id}`, ...gitFilterSkipMessages(root)].join('\n') }
  } catch (err) {
    return { state: 'refused', reason: `resolve failed: ${(err as Error).message}` }
  } finally {
    rmSync(temporary, { force: true })
    if (lock !== undefined) { closeSync(lock); rmSync(lockPath, { force: true }) }
  }
}

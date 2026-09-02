
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { detectLineEndingsForString } from '../../utils/fileRead.js'
import { expandPath } from '../../utils/path.js'
import {
  CHANGESET_BOUNDS,
  CHANGESET_CONTRACT_VERSION,
  type ChangeSetMemberFailure,
  type ChangeSetMemberInput,
  type ChangeSetPlan,
  type ChangeSetPlanResult,
  type ChangeSetRefusal,
  type ChangeSetTargetBytes,
  type ChangeSetTargetPlan,
} from './changeSetContracts.js'
import { buildDiffHunks } from './diffBudget.js'
import { applyHunks, planHunks } from './hunks.js'
import { checkAnchor, mintFileAnchor } from './snapshotAnchor.js'

export interface ChangeSetPlanContext {
  ownerKey: string
  readEvidence?: (
    canonicalPath: string,
    requestedPath: string,
  ) => { ok: true } | { ok: false; message: string }
  scopeCheck?: (canonicalPath: string) => string | null
  validateTarget?: (target: ChangeSetTargetPlan, plannedContent: string) => string | null
  seenLinesCheck?: (
    target: { canonicalPath: string; requestedPath: string },
    spans: readonly import('./hunks.js').HunkSpan[],
  ) => { ok: true } | { ok: false; message: string }
  now?: number
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

export function canonicalPathKey(canonical: string): string {
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical
}

function canonicalize(requested: string): { canonical: string } | { error: string } {
  const expanded = expandPath(requested)
  try {
    return { canonical: realpathSync(expanded) }
  } catch {
    return { error: expanded }
  }
}

export function plannedDiskBytes(
  plannedContent: string,
  encoding: BufferEncoding,
  lineEndings: 'CRLF' | 'LF',
): Buffer {
  let out = plannedContent
  if (lineEndings === 'CRLF') {
    out = plannedContent.replaceAll('\r\n', '\n').split('\n').join('\r\n')
  }
  return Buffer.from(out, encoding)
}

function refusal(
  code: ChangeSetRefusal['code'],
  message: string,
  recovery: string,
  failures?: ChangeSetMemberFailure[],
): ChangeSetRefusal {
  return { ok: false, code, message, recovery, ...(failures && failures.length > 0 ? { failures } : {}) }
}

export function formatChangeSetRefusal(r: ChangeSetRefusal): string {
  const lines = [`ChangeSet refused (${r.code}): ${r.message}`]
  for (const f of r.failures ?? []) {
    lines.push(`  ${f.path}: [${f.code}] ${f.message}`)
  }
  lines.push(`Nothing was written. ${r.recovery}`)
  return lines.join('\n')
}

export function changeSetRefusalCodeOfResult(result: string): ChangeSetRefusal['code'] | null {
  const m = /^ChangeSet refused \(([a-z-]+)\):/.exec(result)
  return m ? (m[1] as ChangeSetRefusal['code']) : null
}

export function anchorPatchCodeOfResult(result: string): string | null {
  const m = /^patch (?:parse failed|rejected) \[([a-z-]+)\]/.exec(result)
  return m ? m[1]! : null
}

export function planChangeSet(
  members: ChangeSetMemberInput[],
  ctx: ChangeSetPlanContext,
): ChangeSetPlanResult {
  const now = ctx.now ?? Date.now()

  if (members.length === 0) {
    return refusal('schema', 'changes is empty — provide at least one file member', 'Add one or more { file_path, expected_anchor, hunks } members.')
  }
  if (members.length > CHANGESET_BOUNDS.maxFiles) {
    return refusal(
      'bounds',
      `the set names ${members.length} files — the limit is ${CHANGESET_BOUNDS.maxFiles} files per change set`,
      `Split the change into ${Math.ceil(members.length / CHANGESET_BOUNDS.maxFiles)} sets of at most ${CHANGESET_BOUNDS.maxFiles} files.`,
    )
  }
  let totalHunks = 0
  for (const m of members) {
    const op = m.op ?? 'edit'
    if (op === 'delete' && m.hunks.length > 0) {
      return refusal('schema', `${m.file_path}: a delete member carries hunks — deleting a file discards its edits`, 'Drop the hunks or split the edit into its own member.')
    }
    if (op === 'delete' && m.new_path !== undefined) {
      return refusal('schema', `${m.file_path}: a delete member carries new_path — delete and move are different ops`, 'Use op "move" to rename, or drop new_path.')
    }
    if (op === 'move' && (m.new_path === undefined || m.new_path === '')) {
      return refusal('schema', `${m.file_path}: a move member needs new_path`, 'Name the destination path.')
    }
    if (op === 'edit' && m.new_path !== undefined) {
      return refusal('schema', `${m.file_path}: new_path is only meaningful on a move member`, 'Set op: "move" or drop new_path.')
    }
    if (op === 'edit' && m.hunks.length === 0) {
      return refusal('schema', `${m.file_path}: hunks is empty — every member needs at least one hunk`, 'Drop the empty member or give it a hunk.')
    }
    if (m.hunks.length > CHANGESET_BOUNDS.maxHunksPerFile) {
      return refusal(
        'bounds',
        `${m.file_path}: ${m.hunks.length} hunks — the limit is ${CHANGESET_BOUNDS.maxHunksPerFile} hunks per file`,
        'Merge adjacent hunks into range hunks, or split the file across two change sets.',
      )
    }
    totalHunks += m.hunks.length
  }
  if (totalHunks > CHANGESET_BOUNDS.maxHunksTotal) {
    return refusal(
      'bounds',
      `the set carries ${totalHunks} hunks — the limit is ${CHANGESET_BOUNDS.maxHunksTotal} hunks per change set`,
      'Split the change into smaller sets.',
    )
  }

  interface Resolved {
    member: ChangeSetMemberInput
    canonical: string
    destination?: string
  }
  const resolved: Resolved[] = []
  const classFailures: ChangeSetMemberFailure[] = []
  for (const m of members) {
    const canon = canonicalize(m.file_path)
    if ('error' in canon) {
      classFailures.push({
        path: m.file_path,
        code: 'missing',
        message: 'file does not exist — ChangeSet edits EXISTING text files only; file creation stays with the Write tool',
      })
      continue
    }
    let st
    try {
      st = lstatSync(canon.canonical)
    } catch {
      classFailures.push({ path: m.file_path, code: 'missing', message: 'file vanished during planning — re-check the path' })
      continue
    }
    if (st.isDirectory()) {
      classFailures.push({ path: m.file_path, code: 'directory', message: 'path is a directory — ChangeSet edits text files' })
      continue
    }
    if (canon.canonical.endsWith('.ipynb')) {
      classFailures.push({
        path: m.file_path,
        code: 'notebook',
        message: 'Jupyter notebooks stay with the NotebookEdit tool',
      })
      continue
    }
    resolved.push({ member: m, canonical: canon.canonical })
  }
  if (classFailures.length > 0) {
    return refusal(
      classFailures[0]!.code,
      `${classFailures.length} member(s) name targets this tool does not own`,
      'Route each named member to its owner (Write · NotebookEdit), then re-plan the remaining set.',
      classFailures,
    )
  }
  const seen = new Map<string, string>()
  for (const r of resolved) {
    const key = canonicalPathKey(r.canonical)
    const prior = seen.get(key)
    if (prior !== undefined) {
      return refusal(
        'duplicate-path',
        `'${r.member.file_path}' and '${prior}' resolve to the same file — one member per file`,
        'Merge the two members into one member with disjoint hunks.',
      )
    }
    seen.set(key, r.member.file_path)
  }

  const destinations = new Map<string, string>()
  for (const r of resolved) {
    if ((r.member.op ?? 'edit') !== 'move') continue
    const rawDest = expandPath(r.member.new_path!)
    const destDir = dirname(rawDest)
    let canonicalDest = rawDest
    try {
      canonicalDest = join(realpathSync(destDir), basename(rawDest))
    } catch {
    }
    let destExists = false
    try {
      lstatSync(canonicalDest)
      destExists = true
    } catch {
    }
    if (destExists) {
      return refusal(
        'destination',
        `${r.member.file_path}: move destination '${r.member.new_path}' already exists — nothing is overwritten by a move`,
        'Pick a free destination path, or delete the existing file first (explicitly).',
      )
    }
    if (canonicalDest.endsWith('.ipynb')) {
      return refusal(
        'destination',
        `${r.member.file_path}: move destination '${r.member.new_path}' is a notebook path — notebooks stay with NotebookEdit`,
        'Pick a non-notebook destination.',
      )
    }
    const destKey = canonicalPathKey(canonicalDest)
    if (seen.has(destKey)) {
      return refusal(
        'destination',
        `${r.member.file_path}: move destination collides with member '${seen.get(destKey)}'`,
        'A destination cannot also be an edited/deleted source in the same set.',
      )
    }
    const priorDest = destinations.get(destKey)
    if (priorDest !== undefined) {
      return refusal(
        'destination',
        `'${r.member.file_path}' and '${priorDest}' move to the same destination`,
        'Give each move its own destination.',
      )
    }
    destinations.set(destKey, r.member.file_path)
    r.destination = canonicalDest
  }

  const failures: ChangeSetMemberFailure[] = []
  const targets: ChangeSetTargetPlan[] = []
  const bytes = new Map<string, ChangeSetTargetBytes>()
  const originalContentByPath = new Map<string, string>()
  let stagedBytes = 0

  for (const { member, canonical, destination } of resolved) {
    const memberOp = member.op ?? 'edit'
    if (ctx.scopeCheck) {
      const scopeErr = ctx.scopeCheck(canonical)
      if (scopeErr) {
        failures.push({ path: member.file_path, code: 'scope', message: scopeErr })
        continue
      }
      if (destination !== undefined) {
        const destErr = ctx.scopeCheck(destination)
        if (destErr) {
          failures.push({ path: member.file_path, code: 'scope', message: `destination ${member.new_path}: ${destErr}` })
          continue
        }
      }
    }
    if (ctx.readEvidence) {
      const ev = ctx.readEvidence(canonical, member.file_path)
      if (!ev.ok) {
        failures.push({ path: member.file_path, code: 'not-read', message: ev.message })
        continue
      }
    }

    let raw: Buffer
    let mode: number
    try {
      raw = readFileSync(canonical)
      mode = lstatSync(canonical).mode & 0o7777
    } catch (e) {
      failures.push({ path: member.file_path, code: 'io', message: `unreadable — ${(e as Error).message}` })
      continue
    }
    const encoding: BufferEncoding =
      raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8'
    if (encoding === 'utf8' && raw.subarray(0, 4096).includes(0)) {
      failures.push({
        path: member.file_path,
        code: 'binary',
        message: 'content is binary (NUL bytes) — ChangeSet edits text files only; binary edits have no text owner',
      })
      continue
    }
    const rawText = raw.toString(encoding)
    const lineEndings = detectLineEndingsForString(rawText.slice(0, 4096))
    const content = rawText.replaceAll('\r\n', '\n')

    const anchorCheck = checkAnchor(member.expected_anchor, content, member.file_path)
    if (!anchorCheck.ok) {
      failures.push({
        path: member.file_path,
        code: anchorCheck.reason === 'malformed' ? 'malformed-anchor' : 'stale-anchor',
        message:
          anchorCheck.reason === 'malformed'
            ? `expected_anchor '${member.expected_anchor}' is not a valid anchor`
            : `stale anchor (current: ${anchorCheck.currentAnchor ?? 'unknown'}) — ${anchorCheck.rereadHint}`,
      })
      continue
    }

    let hunkSpans: ChangeSetTargetPlan['hunkSpans'] = []
    let plannedContent: string
    if (memberOp === 'delete') {
      plannedContent = ''
    } else if (member.hunks.length === 0) {
      plannedContent = content
    } else {
      const hunkPlan = planHunks(content, member.hunks, member.expected_anchor)
      if (!hunkPlan.ok) {
        failures.push({ path: member.file_path, code: 'hunks', message: hunkPlan.message })
        continue
      }
      hunkSpans = hunkPlan.spans
      plannedContent = applyHunks(content, hunkPlan)
    }
    if (ctx.seenLinesCheck && hunkSpans.length > 0) {
      const seen = ctx.seenLinesCheck(
        { canonicalPath: canonical, requestedPath: member.file_path },
        hunkSpans,
      )
      if (!seen.ok) {
        failures.push({ path: member.file_path, code: 'not-read', message: seen.message })
        continue
      }
    }
    const plannedBytes =
      memberOp === 'delete' ? Buffer.alloc(0) : plannedDiskBytes(plannedContent, encoding, lineEndings)
    stagedBytes += raw.length + plannedBytes.length
    if (stagedBytes > CHANGESET_BOUNDS.maxStagedBytes) {
      return refusal(
        'bounds',
        `the set stages more than ${Math.round(CHANGESET_BOUNDS.maxStagedBytes / 1_000_000)}MB of content (at ${member.file_path})`,
        'Split the change into smaller sets, or edit the largest file with the Edit tool directly.',
      )
    }

    const target: ChangeSetTargetPlan = {
      requestedPath: member.file_path,
      canonicalPath: canonical,
      expectedAnchor: member.expected_anchor,
      observedAnchor: mintFileAnchor(content),
      originalDigest: sha256Hex(raw),
      plannedDigest: sha256Hex(plannedBytes),
      originalByteLength: raw.length,
      plannedByteLength: plannedBytes.length,
      encoding,
      lineEndings,
      finalNewline: content.endsWith('\n'),
      mode,
      hunkSpans,
      plannedContent,
      diff: { hunks: [], omittedHunks: 0 },
      changed: memberOp !== 'edit' || plannedContent !== content,
      ...(memberOp !== 'edit' ? { fileOp: memberOp } : {}),
      ...(destination !== undefined ? { newPath: destination } : {}),
    }
    if (ctx.validateTarget) {
      const domainErr = ctx.validateTarget(target, plannedContent)
      if (domainErr) {
        failures.push({ path: member.file_path, code: 'hunks', message: domainErr })
        continue
      }
    }
    targets.push(target)
    bytes.set(canonical, { canonicalPath: canonical, originalBytes: raw, plannedBytes })
    originalContentByPath.set(canonical, content)
  }

  if (failures.length > 0) {
    return refusal(
      failures[0]!.code,
      `${failures.length} of ${members.length} member(s) failed preflight — the whole set is refused`,
      'Fix every named member (re-read for fresh anchors where stale), then re-plan. The valid subset was NOT written.',
      failures,
    )
  }

  targets.sort((a, b) => (a.canonicalPath < b.canonicalPath ? -1 : a.canonicalPath > b.canonicalPath ? 1 : 0))

  let diffBudgetLeft = CHANGESET_BOUNDS.maxDiffLines
  for (const t of targets) {
    if (!t.changed) continue
    const oldContent = originalContentByPath.get(t.canonicalPath) ?? ''
    const fileBudget = Math.min(80, diffBudgetLeft)
    if (fileBudget <= 0) {
      t.diff = { hunks: [], omittedHunks: t.hunkSpans.length }
      continue
    }
    t.diff = buildDiffHunks(t.requestedPath, oldContent, t.plannedContent, fileBudget)
    diffBudgetLeft -= t.diff.hunks.reduce((n, h) => n + h.lines.length, 0)
  }

  const changedPaths = targets.filter(t => t.changed).flatMap(t => {
    const paths = [t.canonicalPath]
    if (t.fileOp === 'move' && t.newPath !== undefined) paths.push(t.newPath)
    return paths
  })
  const noChangePaths = targets.filter(t => !t.changed).map(t => t.canonicalPath)

  const material = JSON.stringify({
    v: CHANGESET_CONTRACT_VERSION,
    targets: targets.map(t => [
      t.canonicalPath,
      t.expectedAnchor,
      t.originalDigest,
      t.plannedDigest,
      t.hunkSpans.map(s => [s.start, s.end, s.insert ?? '', s.replace]),
      t.fileOp ?? '',
      t.newPath ?? '',
    ]),
  })
  const digest = sha256Hex(material)

  const plan: ChangeSetPlan = {
    version: CHANGESET_CONTRACT_VERSION,
    id: `cs-${digest.slice(0, 12)}`,
    digest,
    ownerKey: ctx.ownerKey,
    createdAt: now,
    expiresAt: now + CHANGESET_BOUNDS.planTtlMs,
    state: 'prepared',
    targets,
    changedPaths,
    noChangePaths,
    totalHunks,
  }
  return { ok: true, plan, bytes }
}

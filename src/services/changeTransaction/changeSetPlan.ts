
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { preserveUntouchedLineEndings } from '../../utils/file.js'
import { detectLineEndingsForString, LOSSY_DECODE_MESSAGE } from '../../utils/fileRead.js'
import { expandPath } from '../../utils/path.js'
import type { OwnerKey } from '../run/ownerKey.js'
import {
  CHANGESET_BOUNDS,
  CHANGESET_CONTRACT_VERSION,
  type ChangeSetMemberEdit,
  type ChangeSetMemberFailure,
  type ChangeSetMemberInput,
  type ChangeSetPlan,
  type ChangeSetPlanResult,
  type ChangeSetRefusal,
  type ChangeSetTargetBytes,
  type ChangeSetTargetPlan,
  type ExactEditOutcome,
} from './changeSetContracts.js'
import { buildDiffHunks } from './diffBudget.js'
import { applyHunks, countLines, planHunks, type EditHunkInput, type HunkSpan } from './hunks.js'
import { checkAnchor, mintFileAnchor, normalizeForAnchor } from './snapshotAnchor.js'
import { relocateStaleHunksFromRing } from './stalePatchRecovery.js'

type LineRange = { start: number; end: number }

interface ChangeSetPlanContext {
  ownerKey: string
  exactEdit: (
    target: { canonicalPath: string; requestedPath: string; expectedAnchor: string; content: string },
    edit: ChangeSetMemberEdit,
  ) => ExactEditOutcome
  readEvidence?: (target: {
    canonicalPath: string
    requestedPath: string
    expectedAnchor: string
    content: string
    hunks: readonly EditHunkInput[]
    touched?: LineRange[] | null
  }) => { ok: true } | { ok: false; message: string }
  scopeCheck?: (canonicalPath: string) => string | null
  lastRead?: (canonicalPath: string, requestedPath: string) => string | null
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
  rawText?: string,
): Buffer {
  if (rawText !== undefined) {
    return Buffer.from(preserveUntouchedLineEndings(rawText, plannedContent, lineEndings), encoding)
  }
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

interface EditPlacement {
  edit: number
  at: number
  end: number
  replacement: string
}

function lineStartsOf(body: string): number[] {
  const starts = [0]
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) starts.push(at + 1)
  return starts
}

function lineAtOffset(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

function placeEdits(
  body: string,
  edits: readonly ChangeSetMemberEdit[],
  match: (edit: ChangeSetMemberEdit) => ExactEditOutcome,
): { placements: EditPlacement[]; failures: string[] } {
  const placements: EditPlacement[] = []
  const failures: string[] = []
  edits.forEach((edit, i) => {
    const outcome = match(edit)
    if (!outcome.ok) {
      failures.push(`edit ${i + 1}: ${outcome.message}`)
      return
    }
    for (let at = body.indexOf(outcome.search); at !== -1; at = body.indexOf(outcome.search, at + outcome.search.length)) {
      placements.push({ edit: i + 1, at, end: at + outcome.search.length, replacement: outcome.replacement })
      if (edit.replace_all !== true) break
    }
  })
  placements.sort((a, b) => a.at - b.at || a.edit - b.edit)
  const starts = lineStartsOf(body)
  const lines = (p: EditPlacement): string => {
    const start = lineAtOffset(starts, p.at)
    const end = lineAtOffset(starts, p.end - 1)
    return start === end ? `${start}` : `${start}-${end}`
  }
  for (let k = 1, reach = placements[0]!; k < placements.length; k++) {
    const cur = placements[k]!
    if (cur.at < reach.end) {
      failures.push(`edit ${reach.edit} and edit ${cur.edit} overlap (lines ${lines(reach)} vs ${lines(cur)}) — edits must address disjoint text`)
    }
    if (cur.end > reach.end) reach = cur
  }
  return { placements, failures }
}

function splicePlacements(body: string, placements: readonly EditPlacement[]): string {
  let out = body
  for (let k = placements.length - 1; k >= 0; k--) {
    const p = placements[k]!
    out = out.slice(0, p.at) + p.replacement + out.slice(p.end)
  }
  return out
}

function spansOfPlacements(body: string, placements: readonly EditPlacement[]): HunkSpan[] {
  const starts = lineStartsOf(body)
  const lineCount = countLines(body)
  const endOffsetOf = (line: number): number => (line < starts.length ? starts[line]! : body.length)
  const spans: HunkSpan[] = []
  let i = 0
  while (i < placements.length) {
    const startLine = lineAtOffset(starts, placements[i]!.at)
    let endLine = lineAtOffset(starts, placements[i]!.end - 1)
    let j = i + 1
    for (;;) {
      while (j < placements.length && lineAtOffset(starts, placements[j]!.at) <= endLine) {
        endLine = Math.max(endLine, lineAtOffset(starts, placements[j]!.end - 1))
        j++
      }
      const regionStart = starts[startLine - 1]!
      const regionEnd = endOffsetOf(endLine)
      let text = ''
      let cursor = regionStart
      for (let k = i; k < j; k++) {
        text += body.slice(cursor, placements[k]!.at) + placements[k]!.replacement
        cursor = placements[k]!.end
      }
      text += body.slice(cursor, regionEnd)
      if (text !== '' && !text.endsWith('\n') && body[regionEnd - 1] === '\n' && endLine < lineCount) {
        endLine += 1
        continue
      }
      spans.push({ index: spans.length + 1, start: startLine, end: endLine, replace: text.endsWith('\n') ? text.slice(0, -1) : text })
      break
    }
    i = j
  }
  return spans
}

export function planChangeSet(
  members: ChangeSetMemberInput[],
  ctx: ChangeSetPlanContext,
): ChangeSetPlanResult {
  const now = ctx.now ?? Date.now()

  if (members.length === 0) {
    return refusal('schema', 'changes is empty — provide at least one file member', 'Add one or more { file_path, expected_anchor, hunks or edits } members.')
  }
  if (members.length > CHANGESET_BOUNDS.maxFiles) {
    return refusal(
      'bounds',
      `the set names ${members.length} files — the limit is ${CHANGESET_BOUNDS.maxFiles} files per change set`,
      `Split the change into ${Math.ceil(members.length / CHANGESET_BOUNDS.maxFiles)} sets of at most ${CHANGESET_BOUNDS.maxFiles} files.`,
    )
  }
  let suppliedHunks = 0
  for (const m of members) {
    const op = m.op ?? 'edit'
    const hunks = m.hunks ?? []
    const edits = m.edits ?? []
    const carried = hunks.length > 0 ? 'hunks' : 'edits'
    if (hunks.length > 0 && edits.length > 0) {
      return refusal('schema', `${m.file_path}: hunks and edits are mutually exclusive — use one edit mode per member`, 'Keep the hunks or the edits, not both.')
    }
    if (op === 'delete' && (hunks.length > 0 || edits.length > 0)) {
      return refusal('schema', `${m.file_path}: a delete member carries ${carried} — deleting a file discards its edits`, `Drop the ${carried} or split the edit into its own member.`)
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
    if (op === 'edit' && hunks.length === 0 && edits.length === 0) {
      return refusal('schema', `${m.file_path}: hunks and edits are empty — every edit member needs at least one hunk or edit`, 'Drop the empty member or give it a hunk or an edit.')
    }
    const blank = edits.findIndex(e => e.old_string === '')
    if (blank !== -1) {
      return refusal('schema', `${m.file_path}: edit ${blank + 1} has an empty old_string — ChangeSet edits EXISTING text; file creation stays with the Write tool`, 'Give the edit the text to replace, as the file spells it.')
    }
    if (hunks.length + edits.length > CHANGESET_BOUNDS.maxHunksPerFile) {
      return refusal(
        'bounds',
        `${m.file_path}: ${hunks.length + edits.length} ${carried} — the limit is ${CHANGESET_BOUNDS.maxHunksPerFile} ${carried} per file`,
        `Merge adjacent ${carried}${carried === 'hunks' ? ' into range hunks' : ''}, or split the file across two change sets.`,
      )
    }
    suppliedHunks += hunks.length + edits.length
  }
  if (suppliedHunks > CHANGESET_BOUNDS.maxHunksTotal) {
    return refusal(
      'bounds',
      `the set carries ${suppliedHunks} hunks — the limit is ${CHANGESET_BOUNDS.maxHunksTotal} hunks per change set`,
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
    if (!Buffer.from(rawText, encoding).equals(raw)) {
      failures.push({ path: member.file_path, code: 'encoding', message: LOSSY_DECODE_MESSAGE })
      continue
    }
    const lineEndings = detectLineEndingsForString(rawText.slice(0, 4096))
    const content = rawText.replaceAll('\r\n', '\n')
    const bom = content.charCodeAt(0) === 0xfeff ? content.charAt(0) : ''
    const body = content.slice(bom.length)
    let memberHunks = member.hunks ?? []
    const memberEdits = member.edits ?? []
    let memberAnchor = member.expected_anchor
    let staleRecovery: string | undefined
    const placed =
      memberEdits.length > 0
        ? placeEdits(body, memberEdits, edit =>
            ctx.exactEdit({ canonicalPath: canonical, requestedPath: member.file_path, expectedAnchor: member.expected_anchor, content: body }, edit),
          )
        : null
    let touched: LineRange[] | null | undefined
    if (placed !== null) {
      const starts = lineStartsOf(body)
      touched = placed.placements.length === 0 ? null : placed.placements.map(p => ({ start: lineAtOffset(starts, p.at), end: lineAtOffset(starts, p.end - 1) }))
    }

    if (ctx.readEvidence) {
      const ev = ctx.readEvidence({
        canonicalPath: canonical,
        requestedPath: member.file_path,
        expectedAnchor: member.expected_anchor,
        content,
        hunks: memberHunks,
        ...(touched !== undefined ? { touched } : {}),
      })
      if (!ev.ok) {
        failures.push({ path: member.file_path, code: 'not-read', message: ev.message })
        continue
      }
    }

    const anchorCheck = checkAnchor(member.expected_anchor, content, member.file_path)
    if (!anchorCheck.ok) {
      const recovery =
        anchorCheck.reason !== 'malformed' && memberHunks.length > 0
          ? relocateStaleHunksFromRing(ctx.ownerKey as OwnerKey, member.expected_anchor, body, memberHunks, member.file_path)
          : null
      if (recovery === null) {
        const lastRead = ctx.lastRead?.(canonical, member.file_path) ?? null
        const unchangedSinceRead = lastRead !== null && normalizeForAnchor(lastRead) === normalizeForAnchor(content)
        failures.push({
          path: member.file_path,
          code: anchorCheck.reason === 'malformed' ? 'malformed-anchor' : 'stale-anchor',
          message: unchangedSinceRead
            ? `expected_anchor '${member.expected_anchor}' is not the anchor of ${member.file_path} as read this session; the file is unchanged since that read and its anchor is ${mintFileAnchor(content)} — pass that value`
            : anchorCheck.reason === 'malformed'
              ? anchorCheck.rereadHint
              : `stale anchor — ${anchorCheck.rereadHint}`,
        })
        continue
      }
      memberHunks = recovery.hunks
      memberAnchor = recovery.freshAnchor
      staleRecovery = recovery.note
    }

    let hunkSpans: ChangeSetTargetPlan['hunkSpans'] = []
    let plannedContent: string
    if (memberOp === 'delete') {
      plannedContent = ''
    } else if (placed !== null) {
      if (placed.failures.length > 0) {
        for (const message of placed.failures) failures.push({ path: member.file_path, code: 'edits', message })
        continue
      }
      hunkSpans = spansOfPlacements(body, placed.placements)
      plannedContent = bom + splicePlacements(body, placed.placements)
    } else if (memberHunks.length === 0) {
      plannedContent = content
    } else {
      const hunkPlan = planHunks(body, memberHunks, memberAnchor)
      if (!hunkPlan.ok) {
        failures.push({ path: member.file_path, code: 'hunks', message: hunkPlan.message })
        continue
      }
      hunkSpans = hunkPlan.spans
      plannedContent = bom + applyHunks(body, hunkPlan)
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
      memberOp === 'delete' ? Buffer.alloc(0) : plannedDiskBytes(plannedContent, encoding, lineEndings, rawText)
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
      expectedAnchor: memberAnchor,
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
      diff: { hunks: [], omittedHunks: 0, added: 0, removed: 0 },
      changed: memberOp !== 'edit' || plannedContent !== content,
      ...(memberOp !== 'edit' ? { fileOp: memberOp } : {}),
      ...(destination !== undefined ? { newPath: destination } : {}),
      ...(staleRecovery !== undefined ? { staleRecovery } : {}),
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
      const counted = buildDiffHunks(t.requestedPath, oldContent, t.plannedContent, 0)
      t.diff = { hunks: [], omittedHunks: t.hunkSpans.length, added: counted.added, removed: counted.removed }
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
    totalHunks: targets.reduce((n, t) => n + t.hunkSpans.length, 0),
  }
  return { ok: true, plan, bytes }
}

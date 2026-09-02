// ============================================================================
//  changeTransaction/anchorPatchLower — lower a parsed anchor patch onto the
//  change-set member vocabulary.
//
//  Two passes over the sections:
//    1. per file: read current bytes, verify the anchor (stale anchors go
//       through bounded unique-relocation recovery when the snapshot ring
//       still holds the anchored text — otherwise the typed refusal), and
//       extract every cut's register content from the ANCHORED snapshot;
//    2. per file: resolve block ops through the TS facility, spell every op
//       as hunks of the LIVE Edit vocabulary, resolve paste bodies from this
//       patch's cuts or the session register store, and emit members
//       (edit / delete / move) for the EXISTING nine-step planner.
//
//  This module reads files but never writes; everything it produces is
//  re-validated by planChangeSet against current bytes and re-verified by
//  the commit walk under locks. Registers PUBLISH only after the commit
//  lands — the caller flushes `registerPublications` post-commit.
// ============================================================================

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { OwnerKey } from '../run/ownerKey.js'
import { getCwd } from '../../utils/cwd.js'
import {
  ANCHOR_PATCH_BOUNDS,
  type AnchorPatchOp,
  type AnchorPatchParse,
  type AnchorPatchSection,
} from './anchorPatch.js'
import { resolveBlockAt } from './blockAnchors.js'
import type { ChangeSetMemberInput } from './changeSetContracts.js'
import { countLines, type EditHunkInput } from './hunks.js'
import { PATCH_REGISTER_BOUNDS, patchRegisterEvicted, readPatchRegister } from './patchRegisters.js'
import { checkAnchor, formatAnchorFailure, mintFileAnchor } from './snapshotAnchor.js'
import { recallAnchoredSnapshot } from './snapshotRing.js'
import { recoverStaleHunks } from './stalePatchRecovery.js'

export interface LoweredMemberMeta {
  /** Stale anchor relocated through the snapshot ring — seen-lines evidence
   *  is the relocation proof itself for these members. */
  recovered: boolean
  /** Block-resolution notes ('replace-block 12 → lines 12-40 (FunctionDeclaration)'). */
  blockNotes: string[]
}

export interface LoweredPatch {
  ok: true
  members: ChangeSetMemberInput[]
  /** requestedPath → lowering metadata (seen-lines policy + notes). */
  memberMeta: Map<string, LoweredMemberMeta>
  /** Named registers to publish AFTER the commit lands. */
  registerPublications: Map<string, { content: string; fromPath: string }>
  warnings: string[]
}

export interface LowerFailure {
  ok: false
  /** Parser-vocabulary-adjacent lowering codes. */
  code:
    | 'stale-anchor'
    | 'register-unknown'
    | 'register-too-large'
    | 'block'
    | 'bad-target'
    | 'file-op-conflict'
  message: string
}

export type LowerOutcome = LoweredPatch | LowerFailure

function absoluteSectionPath(p: string): string {
  return isAbsolute(p) ? p : resolvePath(getCwd(), p)
}

/** Read + LF-normalize a section's file (encoding law matches the planner). */
function readNormalized(absPath: string): { content: string } | { error: string } {
  let raw: Buffer
  try {
    raw = readFileSync(absPath)
  } catch (e) {
    return { error: (e as Error).message }
  }
  const encoding: BufferEncoding =
    raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8'
  return { content: raw.toString(encoding).replaceAll('\r\n', '\n') }
}

function sliceLines(content: string, start: number, end: number): string {
  const lines = content.split('\n')
  return lines.slice(start - 1, end).join('\n')
}

/** Canonical hunk range spelling: "N" for a single line, "N-M" otherwise. */
function spellRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`
}

interface FileGroup {
  path: string
  absPath: string
  anchor: string
  ops: AnchorPatchOp[]
}

/** Merge same-path sections (the parser already pinned one anchor per path). */
function groupSections(sections: AnchorPatchSection[]): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  const order: string[] = []
  for (const s of sections) {
    const absPath = absoluteSectionPath(s.path)
    const existing = groups.get(absPath)
    if (existing) {
      existing.ops.push(...s.ops)
    } else {
      groups.set(absPath, { path: s.path, absPath, anchor: s.anchor, ops: [...s.ops] })
      order.push(absPath)
    }
  }
  return order.map(p => groups.get(p)!)
}

/**
 * Lower one parsed patch. `owner` scopes register reads and the snapshot
 * ring; nothing here writes to disk or to the register store.
 */
export function lowerAnchorPatch(parse: AnchorPatchParse, owner: OwnerKey): LowerOutcome {
  const warnings = parse.warnings.map(w => `patch line ${w.line}: ${w.message}`)
  const groups = groupSections(parse.sections)

  // ── pass 1: content + anchors (with bounded recovery) + cut extraction ───
  interface Prepared {
    group: FileGroup
    /** The text the ops' line numbers address (the anchored snapshot). */
    snapshot: string
    /** Current on-disk text (recovery target; equals snapshot when fresh). */
    current: string
    /** The anchor the MEMBER will carry (current anchor after recovery). */
    memberAnchor: string
    recovered: boolean
  }
  const prepared: Prepared[] = []
  const cutContents = new Map<string, { content: string; fromPath: string }>()

  for (const group of groups) {
    const read = readNormalized(group.absPath)
    if ('error' in read) {
      return { ok: false, code: 'bad-target', message: `${group.path}: unreadable — ${read.error}` }
    }
    const current = read.content
    const check = checkAnchor(group.anchor, current, group.path)
    let snapshot = current
    let memberAnchor = group.anchor
    let recovered = false
    if (!check.ok) {
      if (check.reason === 'malformed') {
        return { ok: false, code: 'stale-anchor', message: formatAnchorFailure(check, group.anchor) }
      }
      const recalled = recallAnchoredSnapshot(owner, group.anchor)
      if (!recalled) {
        return { ok: false, code: 'stale-anchor', message: formatAnchorFailure(check, group.anchor) }
      }
      snapshot = recalled.content
      memberAnchor = mintFileAnchor(current)
      recovered = true
      // The actual span relocation happens in pass 2, once ops are hunks.
    }
    prepared.push({ group, snapshot, current, memberAnchor, recovered })

    for (const op of group.ops) {
      if (op.kind !== 'cut') continue
      const total = countLines(snapshot)
      if (op.range.end > total) {
        return {
          ok: false,
          code: 'bad-target',
          message: `${group.path}: cut ${op.range.start}-${op.range.end} is out of bounds (${total} line(s))`,
        }
      }
      const content = sliceLines(snapshot, op.range.start, op.range.end)
      if (content.length > PATCH_REGISTER_BOUNDS.perRegisterBytes) {
        return {
          ok: false,
          code: 'register-too-large',
          message: `${group.path}: the cut range holds ${content.length} bytes — registers cap at ${PATCH_REGISTER_BOUNDS.perRegisterBytes}`,
        }
      }
      cutContents.set(op.register ?? '', { content, fromPath: group.absPath })
    }
  }

  // ── pass 2: ops → hunks → members ────────────────────────────────────────
  const members: ChangeSetMemberInput[] = []
  const memberMeta = new Map<string, LoweredMemberMeta>()
  const registerPublications = new Map<string, { content: string; fromPath: string }>()

  const registerBody = (name: string | null, atLine: number): { content: string } | LowerFailure => {
    const key = name ?? ''
    const own = cutContents.get(key)
    if (own) return { content: own.content }
    if (name === null) {
      return { ok: false, code: 'register-unknown', message: `patch line ${atLine}: anonymous paste with no anonymous cut` }
    }
    const stored = readPatchRegister(owner, name)
    if (stored) return { content: stored.content }
    const evicted = patchRegisterEvicted(owner, name)
    return {
      ok: false,
      code: 'register-unknown',
      message: evicted
        ? `patch line ${atLine}: register '${name}' was evicted from the bounded register store (${PATCH_REGISTER_BOUNDS.nameCap} retained) — cut it again`
        : `patch line ${atLine}: unknown register '${name}' — cut into it first (this session), or check the name`,
    }
  }

  for (const prep of prepared) {
    const { group, snapshot } = prep
    const totalLines = countLines(snapshot)
    const hunks: EditHunkInput[] = []
    const blockNotes: string[] = []
    let fileOp: 'delete' | 'move' | undefined
    let newPath: string | undefined

    for (const op of group.ops) {
      switch (op.kind) {
        case 'replace':
          hunks.push({ lines: spellRange(op.range.start, op.range.end), replace: op.body.join('\n') })
          break
        case 'delete':
        case 'cut':
          hunks.push({ lines: spellRange(op.range.start, op.range.end), replace: '' })
          break
        case 'insert': {
          if (op.after === 'end') {
            if (totalLines === 0) {
              return { ok: false, code: 'bad-target', message: `${group.path} is empty — the patch dialect edits existing lines; use Write` }
            }
            hunks.push({ lines: `${totalLines}`, insert: 'after', replace: op.body.join('\n') })
          } else {
            hunks.push({ lines: `${op.after}`, insert: 'after', replace: op.body.join('\n') })
          }
          break
        }
        case 'prepend': {
          const line = op.before === 'start' ? 1 : op.before
          if (totalLines === 0) {
            return { ok: false, code: 'bad-target', message: `${group.path} is empty — the patch dialect edits existing lines; use Write` }
          }
          hunks.push({ lines: `${line}`, insert: 'before', replace: op.body.join('\n') })
          break
        }
        case 'replace-block':
        case 'insert-after-block': {
          const resolved = resolveBlockAt(group.absPath, snapshot, op.at)
          if (!resolved.ok) {
            return {
              ok: false,
              code: 'block',
              message: `${group.path} line ${op.at} (${op.kind}): ${resolved.reason}`,
            }
          }
          blockNotes.push(
            `${op.kind} ${op.at} → lines ${resolved.startLine}-${resolved.endLine} (${resolved.kindLabel})`,
          )
          if (op.kind === 'replace-block') {
            hunks.push({ lines: spellRange(resolved.startLine, resolved.endLine), replace: op.body.join('\n') })
          } else {
            hunks.push({ lines: `${resolved.endLine}`, insert: 'after', replace: op.body.join('\n') })
          }
          break
        }
        case 'paste': {
          const body = registerBody(op.register, op.line)
          if ('ok' in body) return body
          if (op.placement.at === 'after') {
            hunks.push({ lines: `${op.placement.line}`, insert: 'after', replace: body.content })
          } else {
            hunks.push({ lines: spellRange(op.placement.range.start, op.placement.range.end), replace: body.content })
          }
          break
        }
        case 'move-to': {
          fileOp = 'move'
          newPath = absoluteSectionPath(op.newPath)
          break
        }
        case 'delete-file': {
          fileOp = 'delete'
          break
        }
      }
    }

    if (fileOp === 'delete' && hunks.length > 0) {
      return {
        ok: false,
        code: 'file-op-conflict',
        message: `${group.path}: delete-file cannot combine with edits on the same file (another section edits it)`,
      }
    }
    if (fileOp !== undefined && !group.anchor.startsWith('fa:')) {
      return {
        ok: false,
        code: 'bad-target',
        message: `${group.path}: ${fileOp === 'delete' ? 'delete-file' : 'move-to'} needs a WHOLE-file anchor (fa:…) — re-read the full file first`,
      }
    }

    // Stale-anchor recovery: relocate the lowered hunks from the snapshot
    // onto the current content — provably unique or refused.
    let memberHunks = hunks
    if (prep.recovered && hunks.length > 0) {
      const outcome = recoverStaleHunks({
        staleAnchor: group.anchor,
        snapshotContent: snapshot,
        currentContent: prep.current,
        hunks,
        displayPath: group.path,
      })
      if (!outcome.ok) {
        const check = checkAnchor(group.anchor, prep.current, group.path)
        const anchorText = check.ok ? '' : `\n${formatAnchorFailure(check, group.anchor)}`
        return {
          ok: false,
          code: 'stale-anchor',
          message: `stale anchor on ${group.path} and recovery is not provably safe: ${outcome.reason}${anchorText}`,
        }
      }
      memberHunks = outcome.hunks
      warnings.push(...outcome.warnings)
    } else if (prep.recovered && fileOp !== undefined) {
      // A recovered whole-file op (delete/move with no hunks): the content
      // changed since the read — never delete/move bytes the model has not
      // seen. Typed refusal, no recovery.
      const check = checkAnchor(group.anchor, prep.current, group.path)
      return {
        ok: false,
        code: 'stale-anchor',
        message: check.ok ? `stale anchor on ${group.path}` : formatAnchorFailure(check, group.anchor),
      }
    }

    members.push({
      file_path: group.absPath,
      expected_anchor: prep.memberAnchor,
      hunks: memberHunks,
      ...(fileOp !== undefined ? { op: fileOp } : {}),
      ...(newPath !== undefined ? { new_path: newPath } : {}),
    })
    memberMeta.set(group.absPath, { recovered: prep.recovered, blockNotes })
  }

  // Register publications: every named cut this patch performs.
  for (const [name, content] of cutContents) {
    if (name === '') continue
    registerPublications.set(name, content)
  }

  if (members.length > ANCHOR_PATCH_BOUNDS.maxOpsTotal) {
    return { ok: false, code: 'bad-target', message: 'the patch lowers to more members than the op cap allows' }
  }

  return { ok: true, members, memberMeta, registerPublications, warnings }
}

// ============================================================================
//  changeTransaction/anchorPatch — the compact anchored patch dialect.
//
//  ONE model-authored patch string spells an anchored change across one or
//  more EXISTING text files: line edits, block edits, cut/paste registers
//  (cross-file moves of code), whole-file delete, and file move — all over
//  Mercury's OWN anchor grammar (snapshotAnchor.ts) and all preflighted and
//  committed through the EXISTING change-set planner and journaled commit
//  walk. This module is a PARSER: it turns the dialect into the change-set
//  member vocabulary and never applies anything itself.
//
//  Grammar (canonical; the parser tolerates a bounded set of slips and
//  surfaces repair warnings — callers are taught to emit ONLY this form):
//
//    file <path> <anchor>          one section per file; <anchor> is the
//                                  exact "(anchor: …)" value from Read
//    replace <N | N-M>             replace the 1-based line/range; body follows
//    replace-block <N>             replace the syntactic block OPENING at N
//    insert <N | end>              insert AFTER line N (end = after last line)
//    insert-after-block <N>        insert after the block opening at N
//    prepend <N | start>           insert BEFORE line N (start = before line 1)
//    delete <N | N-M>              delete the line/range (no body)
//    cut <N | N-M> [into <reg>]    delete the range INTO a register
//    paste [<reg>] after <N>       paste a register after line N (no body)
//    paste [<reg>] over <N | N-M>  paste a register over the line/range
//    move-to <path>                move/rename the file (after line edits)
//    delete-file                   delete the whole file (sole op in section)
//    | <content>                   body row: final content, marker + ONE space
//    |                             body row: a blank line
//
//  Line numbers ALWAYS address the anchored snapshot — never the output of
//  earlier ops in the same patch. Same-path sections merge onto one anchor.
//  A register is cut at most once per patch; a paste reads the patch's own
//  cut when present, else the session register store. The anonymous register
//  (no name) never outlives the patch.
//
//  The typed failure vocabulary is closed (AnchorPatchErrorCode); every
//  refusal names the offending line and the smallest useful fix, and a
//  unified-diff-shaped input gets the teaching error, never a guess.
//
//  Gate: MERCURY_ANCHOR_PATCH (opt-in until the battery and a real-model
//  shakedown are green) composed with the ChangeSet gate — the dialect is an
//  input mode of the ChangeSet surface.
//  Proof: scripts/edit-tools/prove-anchor-patch-parse.ts.
// ============================================================================

import { isEnvTruthy } from '../../utils/envUtils.js'
import { changeSetEnabled } from './changeSetContracts.js'
import { parseAnchor } from './snapshotAnchor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The dialect gate: opt-in, and only meaningful where ChangeSet lives. */
export function anchorPatchEnabled(): boolean {
  return changeSetEnabled() && isEnvTruthy(flagEnv('MERCURY_ANCHOR_PATCH'))
}

// ── bounds (parser-owned; the planner's CHANGESET_BOUNDS still apply) ───────

export const ANCHOR_PATCH_BOUNDS = {
  /** Total patch lines (envelope included). */
  maxPatchLines: 20_000,
  /** Body rows for one op. */
  maxBodyLinesPerOp: 5_000,
  /** Body rows across the whole patch (the amplification cap). */
  maxBodyLinesTotal: 10_000,
  /** Ops across the whole patch. */
  maxOpsTotal: 256,
  /** Register name length. */
  maxRegisterName: 24,
} as const

// ── the op vocabulary (parsed, not yet lowered) ─────────────────────────────

export type AnchorPatchRange = { start: number; end: number }

export type AnchorPatchOp =
  | { kind: 'replace'; range: AnchorPatchRange; body: string[]; line: number }
  | { kind: 'replace-block'; at: number; body: string[]; line: number }
  | { kind: 'insert'; after: number | 'end'; body: string[]; line: number }
  | { kind: 'insert-after-block'; at: number; body: string[]; line: number }
  | { kind: 'prepend'; before: number | 'start'; body: string[]; line: number }
  | { kind: 'delete'; range: AnchorPatchRange; line: number }
  | { kind: 'cut'; range: AnchorPatchRange; register: string | null; line: number }
  | {
      kind: 'paste'
      register: string | null
      placement: { at: 'after'; line: number } | { at: 'over'; range: AnchorPatchRange }
      line: number
    }
  | { kind: 'move-to'; newPath: string; line: number }
  | { kind: 'delete-file'; line: number }

export interface AnchorPatchSection {
  path: string
  anchor: string
  ops: AnchorPatchOp[]
  /** 1-based patch line of the `file` header (error addressing). */
  line: number
}

/** One bounded repair the parser performed instead of refusing. */
export interface AnchorPatchWarning {
  code:
    | 'fence-stripped'
    | 'header-extra-ignored'
    | 'range-spelling'
    | 'trailing-space'
  line: number
  message: string
}

export type AnchorPatchErrorCode =
  | 'empty'
  | 'too-large'
  | 'no-section'
  | 'bad-header'
  | 'unknown-op'
  | 'bad-range'
  | 'body-missing'
  | 'body-not-allowed'
  | 'unified-diff'
  | 'bad-register'
  | 'register-collision'
  | 'register-empty'
  | 'ops-after-file-op'
  | 'file-op-conflict'
  | 'anchor-conflict'
  | 'amplification'

export interface AnchorPatchError {
  ok: false
  code: AnchorPatchErrorCode
  /** 1-based line in the patch text (0 = the patch as a whole). */
  line: number
  message: string
}

export interface AnchorPatchParse {
  ok: true
  sections: AnchorPatchSection[]
  warnings: AnchorPatchWarning[]
  /** Registers this patch CUTS (name → defining section index). The
   *  anonymous register appears as ''. */
  cutRegisters: Map<string, number>
  /** Named registers this patch reads WITHOUT cutting (session store). */
  storeReads: Set<string>
}

export type AnchorPatchParseResult = AnchorPatchParse | AnchorPatchError

const REGISTER_RE = /^[a-z][a-z0-9_-]{0,23}$/
const RESERVED_REGISTERS = new Set(['after', 'over', 'into', 'start', 'end'])

const UNIFIED_DIFF_TEACHING =
  'this looks like a unified diff — the patch dialect never carries before/after diff rows. ' +
  'Spell edits as ops (replace/insert/delete/cut/paste) with body rows of FINAL content, each prefixed "| ".'

function err(code: AnchorPatchErrorCode, line: number, message: string): AnchorPatchError {
  return { ok: false, code, line, message }
}

/** Parse "N" | "N-M" (canonical) with bounded tolerated spellings. */
function parseRange(
  token: string,
  patchLine: number,
  warnings: AnchorPatchWarning[],
): AnchorPatchRange | AnchorPatchError {
  let t = token
  for (const [alt, spelling] of [
    ['–', 'en dash'],
    ['..', 'double dot'],
  ] as const) {
    if (t.includes(alt)) {
      t = t.split(alt).join('-')
      warnings.push({
        code: 'range-spelling',
        line: patchLine,
        message: `range '${token}' used a ${spelling} — canonical is 'N-M'`,
      })
    }
  }
  const m = /^(\d+)(?:-(\d+))?$/.exec(t)
  if (!m) {
    return err('bad-range', patchLine, `'${token}' is not a line or range — use "N" or "N-M" (1-based, inclusive)`)
  }
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1) {
    return err('bad-range', patchLine, `'${token}': lines are 1-based positive integers`)
  }
  if (end < start) {
    return err('bad-range', patchLine, `range '${token}' ends before it starts`)
  }
  return { start, end }
}

function looksLikeUnifiedDiff(line: string): boolean {
  return (
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('@@ ') ||
    /^[+-](?![0-9])/.test(line)
  )
}

function parseRegisterName(token: string, patchLine: number): string | AnchorPatchError {
  if (!REGISTER_RE.test(token) || RESERVED_REGISTERS.has(token)) {
    return err(
      'bad-register',
      patchLine,
      `'${token}' is not a register name — lowercase [a-z][a-z0-9_-]{0,${ANCHOR_PATCH_BOUNDS.maxRegisterName - 1}}, not a keyword`,
    )
  }
  return token
}

/**
 * Parse one patch string into sections + ops. Pure and total: every failure
 * is a typed AnchorPatchError naming the line; nothing is read from disk.
 */
export function parseAnchorPatch(patchText: string): AnchorPatchParseResult {
  const warnings: AnchorPatchWarning[] = []
  const rawLines = patchText.split('\n')
  if (rawLines.length > ANCHOR_PATCH_BOUNDS.maxPatchLines) {
    return err(
      'too-large',
      0,
      `the patch has ${rawLines.length} lines — the cap is ${ANCHOR_PATCH_BOUNDS.maxPatchLines}; split it`,
    )
  }

  // Bounded envelope tolerance: whole-patch code fences are stripped with a
  // warning (models wrap patches in fences under pressure); blank edge lines
  // are ignored silently.
  let startIdx = 0
  let endIdx = rawLines.length - 1
  while (startIdx <= endIdx && rawLines[startIdx]!.trim() === '') startIdx++
  while (endIdx >= startIdx && rawLines[endIdx]!.trim() === '') endIdx--
  if (startIdx <= endIdx && /^```[a-zA-Z-]*\s*$/.test(rawLines[startIdx]!.trim())) {
    let closing = -1
    for (let i = endIdx; i > startIdx; i--) {
      if (rawLines[i]!.trim() === '```') {
        closing = i
        break
      }
    }
    if (closing > startIdx) {
      warnings.push({
        code: 'fence-stripped',
        line: startIdx + 1,
        message: 'code fence stripped — emit the bare patch, no ``` wrapper',
      })
      startIdx++
      endIdx = closing - 1
    }
  }
  if (startIdx > endIdx) return err('empty', 0, 'the patch is empty — nothing to parse')

  const sections: AnchorPatchSection[] = []
  const cutRegisters = new Map<string, number>()
  const storeReads = new Set<string>()
  let current: AnchorPatchSection | null = null
  /** The op currently accepting body rows (null = none). */
  let bodyTarget: { body: string[]; opLine: number; kind: string } | null = null
  let totalOps = 0
  let totalBodyLines = 0

  const flushBody = (): AnchorPatchError | null => {
    if (bodyTarget && bodyTarget.body.length === 0) {
      return err(
        'body-missing',
        bodyTarget.opLine,
        `${bodyTarget.kind} needs at least one "| " body row — to remove lines use delete/cut instead`,
      )
    }
    bodyTarget = null
    return null
  }

  for (let i = startIdx; i <= endIdx; i++) {
    const lineNo = i + 1
    const raw = rawLines[i]!

    // Body rows bind tighter than anything else.
    if (raw === '|') {
      if (!bodyTarget) return err('unknown-op', lineNo, 'body row with no preceding body-taking op')
      bodyTarget.body.push('')
      totalBodyLines++
      if (bodyTarget.body.length > ANCHOR_PATCH_BOUNDS.maxBodyLinesPerOp) {
        return err('amplification', lineNo, `one op's body exceeds ${ANCHOR_PATCH_BOUNDS.maxBodyLinesPerOp} rows`)
      }
      if (totalBodyLines > ANCHOR_PATCH_BOUNDS.maxBodyLinesTotal) {
        return err('amplification', lineNo, `the patch carries more than ${ANCHOR_PATCH_BOUNDS.maxBodyLinesTotal} body rows — split it`)
      }
      continue
    }
    if (raw.startsWith('| ') || raw === '| ') {
      if (!bodyTarget) return err('unknown-op', lineNo, 'body row with no preceding body-taking op')
      bodyTarget.body.push(raw.slice(2))
      totalBodyLines++
      if (bodyTarget.body.length > ANCHOR_PATCH_BOUNDS.maxBodyLinesPerOp) {
        return err('amplification', lineNo, `one op's body exceeds ${ANCHOR_PATCH_BOUNDS.maxBodyLinesPerOp} rows`)
      }
      if (totalBodyLines > ANCHOR_PATCH_BOUNDS.maxBodyLinesTotal) {
        return err('amplification', lineNo, `the patch carries more than ${ANCHOR_PATCH_BOUNDS.maxBodyLinesTotal} body rows — split it`)
      }
      continue
    }
    if (raw.startsWith('|')) {
      // '|x' without the space — a near-miss the model should learn about.
      return err(
        'unknown-op',
        lineNo,
        `body rows are '| <content>' (marker + ONE space) — '${raw.slice(0, 20)}' is missing the space`,
      )
    }

    const trimmedEnd = raw.replace(/\s+$/, '')
    if (trimmedEnd !== raw) {
      warnings.push({ code: 'trailing-space', line: lineNo, message: 'trailing whitespace on an op line ignored' })
    }
    const line = trimmedEnd.trim()
    if (line === '') {
      // Blank lines between ops/sections are benign separators.
      continue
    }

    if (looksLikeUnifiedDiff(line)) {
      return err('unified-diff', lineNo, UNIFIED_DIFF_TEACHING)
    }

    const tokens = line.split(/\s+/)
    const op = tokens[0]!

    if (op === 'file') {
      const flushErr = flushBody()
      if (flushErr) return flushErr
      if (tokens.length < 3) {
        return err(
          'bad-header',
          lineNo,
          `a section header is 'file <path> <anchor>' — got '${line.slice(0, 60)}'`,
        )
      }
      // The anchor is the LAST token (paths may not contain spaces in the
      // canonical form; extra middle tokens are refused, not guessed at).
      const anchor = tokens[tokens.length - 1]!
      if (!parseAnchor(anchor)) {
        return err(
          'bad-header',
          lineNo,
          `'${anchor}' is not an anchor — use the exact "(anchor: …)" value from your Read of the file`,
        )
      }
      if (tokens.length > 3) {
        return err(
          'bad-header',
          lineNo,
          `a section header is 'file <path> <anchor>' with a space-free path — paths with spaces are not supported by the dialect; use the JSON changes form`,
        )
      }
      const path = tokens[1]!
      current = { path, anchor, ops: [], line: lineNo }
      sections.push(current)
      continue
    }

    if (!current) {
      return err(
        'no-section',
        lineNo,
        `content before the first 'file' header: '${line.slice(0, 40)}' — every patch starts with 'file <path> <anchor>'`,
      )
    }

    // A section that already carries a terminal file op accepts nothing more.
    const lastOp = current.ops[current.ops.length - 1]
    if (lastOp && (lastOp.kind === 'delete-file' || lastOp.kind === 'move-to')) {
      return err(
        'ops-after-file-op',
        lineNo,
        `'${op}' after ${lastOp.kind} — a file op ends its section; start the next 'file' section`,
      )
    }

    const flushErr = flushBody()
    if (flushErr) return flushErr

    totalOps++
    if (totalOps > ANCHOR_PATCH_BOUNDS.maxOpsTotal) {
      return err('amplification', lineNo, `the patch carries more than ${ANCHOR_PATCH_BOUNDS.maxOpsTotal} ops — split it`)
    }

    switch (op) {
      case 'replace': {
        if (tokens.length !== 2) return err('bad-range', lineNo, `replace takes one line/range — 'replace <N|N-M>'`)
        const range = parseRange(tokens[1]!, lineNo, warnings)
        if ('ok' in range) return range
        const parsed: AnchorPatchOp = { kind: 'replace', range, body: [], line: lineNo }
        current.ops.push(parsed)
        bodyTarget = { body: parsed.body, opLine: lineNo, kind: 'replace' }
        break
      }
      case 'replace-block': {
        if (tokens.length !== 2 || !/^\d+$/.test(tokens[1]!)) {
          return err('bad-range', lineNo, `replace-block takes one line — 'replace-block <N>' (the block's OPENING line)`)
        }
        const parsed: AnchorPatchOp = { kind: 'replace-block', at: Number(tokens[1]), body: [], line: lineNo }
        current.ops.push(parsed)
        bodyTarget = { body: parsed.body, opLine: lineNo, kind: 'replace-block' }
        break
      }
      case 'insert': {
        if (tokens.length !== 2) return err('bad-range', lineNo, `insert takes one anchor — 'insert <N|end>'`)
        let after: number | 'end'
        if (tokens[1] === 'end') after = 'end'
        else {
          const range = parseRange(tokens[1]!, lineNo, warnings)
          if ('ok' in range) return range
          if (range.end !== range.start) {
            return err('bad-range', lineNo, `insert takes a single anchor line, not a range`)
          }
          after = range.start
        }
        const parsed: AnchorPatchOp = { kind: 'insert', after, body: [], line: lineNo }
        current.ops.push(parsed)
        bodyTarget = { body: parsed.body, opLine: lineNo, kind: 'insert' }
        break
      }
      case 'insert-after-block': {
        if (tokens.length !== 2 || !/^\d+$/.test(tokens[1]!)) {
          return err('bad-range', lineNo, `insert-after-block takes one line — 'insert-after-block <N>'`)
        }
        const parsed: AnchorPatchOp = { kind: 'insert-after-block', at: Number(tokens[1]), body: [], line: lineNo }
        current.ops.push(parsed)
        bodyTarget = { body: parsed.body, opLine: lineNo, kind: 'insert-after-block' }
        break
      }
      case 'prepend': {
        if (tokens.length !== 2) return err('bad-range', lineNo, `prepend takes one anchor — 'prepend <N|start>'`)
        let before: number | 'start'
        if (tokens[1] === 'start') before = 'start'
        else {
          const range = parseRange(tokens[1]!, lineNo, warnings)
          if ('ok' in range) return range
          if (range.end !== range.start) {
            return err('bad-range', lineNo, `prepend takes a single anchor line, not a range`)
          }
          before = range.start
        }
        const parsed: AnchorPatchOp = { kind: 'prepend', before, body: [], line: lineNo }
        current.ops.push(parsed)
        bodyTarget = { body: parsed.body, opLine: lineNo, kind: 'prepend' }
        break
      }
      case 'delete': {
        if (tokens.length !== 2) return err('bad-range', lineNo, `delete takes one line/range — 'delete <N|N-M>'`)
        const range = parseRange(tokens[1]!, lineNo, warnings)
        if ('ok' in range) return range
        current.ops.push({ kind: 'delete', range, line: lineNo })
        break
      }
      case 'cut': {
        // cut <range> [into <reg>]
        if (tokens.length !== 2 && !(tokens.length === 4 && tokens[2] === 'into')) {
          return err('bad-range', lineNo, `cut is 'cut <N|N-M>' or 'cut <N|N-M> into <register>'`)
        }
        const range = parseRange(tokens[1]!, lineNo, warnings)
        if ('ok' in range) return range
        let register: string | null = null
        if (tokens.length === 4) {
          const name = parseRegisterName(tokens[3]!, lineNo)
          if (typeof name !== 'string') return name
          register = name
        }
        const regKey = register ?? ''
        if (cutRegisters.has(regKey)) {
          return err(
            'register-collision',
            lineNo,
            register
              ? `register '${register}' is cut twice in one patch — one cut per register`
              : `two anonymous cuts in one patch — name the registers ('cut … into <name>')`,
          )
        }
        cutRegisters.set(regKey, sections.length - 1)
        current.ops.push({ kind: 'cut', range, register, line: lineNo })
        break
      }
      case 'paste': {
        // paste [<reg>] after <N>   |   paste [<reg>] over <N|N-M>
        let register: string | null = null
        let rest = tokens.slice(1)
        if (rest.length === 3) {
          const name = parseRegisterName(rest[0]!, lineNo)
          if (typeof name !== 'string') return name
          register = name
          rest = rest.slice(1)
        }
        if (rest.length !== 2 || (rest[0] !== 'after' && rest[0] !== 'over')) {
          return err(
            'bad-range',
            lineNo,
            `paste is 'paste [<register>] after <N>' or 'paste [<register>] over <N|N-M>'`,
          )
        }
        const range = parseRange(rest[1]!, lineNo, warnings)
        if ('ok' in range) return range
        if (rest[0] === 'after' && range.end !== range.start) {
          return err('bad-range', lineNo, `paste … after takes a single line, not a range`)
        }
        current.ops.push({
          kind: 'paste',
          register,
          placement:
            rest[0] === 'after' ? { at: 'after', line: range.start } : { at: 'over', range },
          line: lineNo,
        })
        if (register !== null && !cutRegisters.has(register)) storeReads.add(register)
        break
      }
      case 'move-to': {
        if (tokens.length !== 2) {
          return err('file-op-conflict', lineNo, `move-to takes one space-free destination path — 'move-to <path>'`)
        }
        if (current.ops.some(o => o.kind === 'move-to' || o.kind === 'delete-file')) {
          return err('file-op-conflict', lineNo, `this section already carries a file op — one move-to/delete-file per file`)
        }
        current.ops.push({ kind: 'move-to', newPath: tokens[1]!, line: lineNo })
        break
      }
      case 'delete-file': {
        if (tokens.length !== 1) return err('file-op-conflict', lineNo, `delete-file takes no arguments`)
        if (current.ops.length > 0) {
          return err(
            'file-op-conflict',
            lineNo,
            `delete-file must be the ONLY op in its section — deleting a file discards its edits`,
          )
        }
        current.ops.push({ kind: 'delete-file', line: lineNo })
        break
      }
      default:
        return err(
          'unknown-op',
          lineNo,
          `unknown op '${op}' — ops: replace, replace-block, insert, insert-after-block, prepend, delete, cut, paste, move-to, delete-file`,
        )
    }
  }
  const flushErr = flushBody()
  if (flushErr) return flushErr

  if (sections.length === 0) return err('empty', 0, 'the patch names no file sections')
  for (const section of sections) {
    if (section.ops.length === 0) {
      return err('bad-header', section.line, `section '${section.path}' carries no ops`)
    }
  }

  // Anonymous paste requires the patch's own anonymous cut.
  for (const section of sections) {
    for (const op of section.ops) {
      if (op.kind === 'paste' && op.register === null && !cutRegisters.has('')) {
        return err(
          'register-empty',
          op.line,
          `anonymous paste with no anonymous cut in this patch — cut first, or name a session register`,
        )
      }
    }
  }

  // Same-path sections must agree on the anchor (one snapshot per file).
  const anchorsByPath = new Map<string, { anchor: string; line: number }>()
  for (const section of sections) {
    const prior = anchorsByPath.get(section.path)
    if (prior && prior.anchor !== section.anchor) {
      return err(
        'anchor-conflict',
        section.line,
        `'${section.path}' appears with two different anchors — all sections for one file address ONE snapshot`,
      )
    }
    if (!prior) anchorsByPath.set(section.path, { anchor: section.anchor, line: section.line })
  }

  return { ok: true, sections, warnings, cutRegisters, storeReads }
}

/** The model-facing teaching text for the dialect (the ChangeSet prompt
 *  embeds it under the gate; provers grep the dist for it). */
export const ANCHOR_PATCH_TEACHING = `Patch dialect (the compact alternative to changes[]): pass patch: "…" instead of changes. One patch edits several files atomically.
  file <path> <anchor>       start a file section; <anchor> is the exact "(anchor: …)" value from your Read
  replace <N|N-M>            replace lines (1-based, inclusive) — body rows follow
  insert <N|end>             insert after line N; prepend <N|start> inserts before
  replace-block <N>          replace the whole syntactic block that OPENS at line N (TS-family files)
  insert-after-block <N>     insert after that block
  delete <N|N-M>             delete lines (no body)
  cut <N|N-M> into <reg>     delete lines into a named register
  paste <reg> after <N>      paste a register (also: paste <reg> over <N|N-M>) — cut in one file, paste in another to MOVE code across files
  move-to <path>             rename this file (after its line edits)
  delete-file                delete this file (sole op in its section)
Body rows: "| " + the final content, one row per line ("|" alone = a blank line). Never emit unified-diff (+/-/@@) rows.
All line numbers address the anchored snapshot you read — never the output of earlier ops in the same patch. On success the result returns a fresh anchor per touched file so the next patch can chain WITHOUT re-reading.`

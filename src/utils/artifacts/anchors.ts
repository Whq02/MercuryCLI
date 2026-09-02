
import { createHash } from 'node:crypto'
import type {
  DiffBodyFile,
  ReviewAnchor,
  ReviewArtifactBody,
} from './reviewContracts.js'

export function contentDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}


export interface MdBlock {
  headingPath: string[]
  text: string
  digest: string
}

export function listMdBlocks(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = []
  const headingPath: string[] = []
  let current: string[] = []
  const flush = (): void => {
    const text = current.join('\n').trim()
    current = []
    if (text.length === 0) return
    blocks.push({
      headingPath: [...headingPath].map(s => s ?? ''),
      text,
      digest: contentDigest(text),
    })
  }
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flush()
      const level = heading[1]!.length
      headingPath.length = Math.max(0, level - 1)
      headingPath[level - 1] = heading[2]!.trim()
      headingPath.length = level
      blocks.push({
        headingPath: [...headingPath].map(s => s ?? ''),
        text: line.trim(),
        digest: contentDigest(line.trim()),
      })
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}


export interface DiffLineSite {
  path: string
  side: 'old' | 'new'
  hunkIndex: number
  line: number
  content: string
  digest: string
}

export function listDiffLineSites(files: DiffBodyFile[]): DiffLineSite[] {
  const sites: DiffLineSite[] = []
  for (const file of files) {
    file.hunks.forEach((hunk, hunkIndex) => {
      let oldLine = hunk.oldStart
      let newLine = hunk.newStart
      for (const raw of hunk.lines) {
        const marker = raw[0] ?? ' '
        const sliced = raw.slice(1)
        const content = sliced.endsWith('\r') ? sliced.slice(0, -1) : sliced
        const digest = contentDigest(content)
        if (marker === '-' || marker === ' ') {
          sites.push({ path: file.path, side: 'old', hunkIndex, line: oldLine, content, digest })
          oldLine++
        }
        if (marker === '+' || marker === ' ') {
          sites.push({ path: file.path, side: 'new', hunkIndex, line: newLine, content, digest })
          newLine++
        }
      }
    })
  }
  return sites
}


export type AnchorCheck = { ok: true } | { ok: false; reason: string }

export function validateAnchor(body: ReviewArtifactBody, anchor: ReviewAnchor): AnchorCheck {
  switch (anchor.t) {
    case 'whole':
      return { ok: true }
    case 'md-block': {
      if (!('markdown' in body)) {
        return { ok: false, reason: `md-block anchors need a markdown body (kind '${body.kind}')` }
      }
      if (!Number.isInteger(anchor.ordinal) || anchor.ordinal < 0) {
        return { ok: false, reason: `ordinal must be a non-negative integer (got ${anchor.ordinal})` }
      }
      const matches = listMdBlocks(body.markdown).filter(b => b.digest === anchor.blockDigest)
      if (matches.length === 0) {
        return { ok: false, reason: 'no block with this content digest exists in the version' }
      }
      if (anchor.ordinal >= matches.length) {
        return { ok: false, reason: `ordinal ${anchor.ordinal} out of range (${matches.length} matching blocks)` }
      }
      return { ok: true }
    }
    case 'diff-line': {
      if (body.kind !== 'diff') {
        return { ok: false, reason: `diff-line anchors need a diff body (kind '${body.kind}')` }
      }
      const site = listDiffLineSites(body.files).find(
        s =>
          s.path === anchor.path &&
          s.side === anchor.side &&
          s.line === anchor.line &&
          s.digest === anchor.lineDigest,
      )
      return site
        ? { ok: true }
        : { ok: false, reason: 'no line at this path/side/line with this content digest' }
    }
    case 'vis-elem': {
      if (body.kind !== 'visual') {
        return { ok: false, reason: `vis-elem anchors need a visual body (kind '${body.kind}')` }
      }
      const capture = body.captures.find(c => c.ref === anchor.captureRef)
      if (!capture) return { ok: false, reason: `no capture '${anchor.captureRef}' in the version` }
      const el = capture.elements?.find(e => e.id === anchor.elementId)
      return el
        ? { ok: true }
        : { ok: false, reason: `capture has no element '${anchor.elementId}'` }
    }
    case 'vis-region': {
      if (body.kind !== 'visual') {
        return { ok: false, reason: `vis-region anchors need a visual body (kind '${body.kind}')` }
      }
      const capture = body.captures.find(c => c.ref === anchor.captureRef)
      return capture
        ? { ok: true }
        : { ok: false, reason: `no capture '${anchor.captureRef}' in the version` }
    }
    case 'journey-step': {
      if (body.kind !== 'journey') {
        return { ok: false, reason: `journey-step anchors need a journey body (kind '${body.kind}')` }
      }
      return body.steps.some(s => s.id === anchor.stepId)
        ? { ok: true }
        : { ok: false, reason: `no step '${anchor.stepId}' in the version` }
    }
  }
}


export type Relocation =
  | { outcome: 'relocated'; anchor: ReviewAnchor }
  | { outcome: 'outdated'; reason: string }

export function relocateAnchor(newBody: ReviewArtifactBody, anchor: ReviewAnchor): Relocation {
  switch (anchor.t) {
    case 'whole':
      return { outcome: 'relocated', anchor }
    case 'md-block': {
      if (!('markdown' in newBody)) {
        return { outcome: 'outdated', reason: 'the new version has no markdown body' }
      }
      const matches = listMdBlocks(newBody.markdown).filter(b => b.digest === anchor.blockDigest)
      if (matches.length === 1) {
        const m = matches[0]!
        return {
          outcome: 'relocated',
          anchor: { t: 'md-block', headingPath: m.headingPath, blockDigest: m.digest, ordinal: 0 },
        }
      }
      if (
        matches.length > 1 &&
        Number.isInteger(anchor.ordinal) &&
        anchor.ordinal >= 0 &&
        anchor.ordinal < matches.length &&
        matches[anchor.ordinal] !== undefined
      ) {
        const m = matches[anchor.ordinal]!
        return {
          outcome: 'relocated',
          anchor: {
            t: 'md-block',
            headingPath: m.headingPath,
            blockDigest: m.digest,
            ordinal: anchor.ordinal,
          },
        }
      }
      return {
        outcome: 'outdated',
        reason:
          matches.length === 0
            ? 'the commented block no longer exists'
            : 'the commented block is ambiguous in the new version',
      }
    }
    case 'diff-line': {
      if (newBody.kind !== 'diff') {
        return { outcome: 'outdated', reason: 'the new version has no diff body' }
      }
      const candidates = listDiffLineSites(newBody.files).filter(
        s => s.path === anchor.path && s.side === anchor.side && s.digest === anchor.lineDigest,
      )
      if (candidates.length === 1) {
        const c = candidates[0]!
        return {
          outcome: 'relocated',
          anchor: {
            t: 'diff-line',
            path: c.path,
            side: c.side,
            lineDigest: c.digest,
            hunkIndex: c.hunkIndex,
            line: c.line,
          },
        }
      }
      return {
        outcome: 'outdated',
        reason:
          candidates.length === 0
            ? 'the commented line is no longer in the diff'
            : 'the commented line is ambiguous in the new diff',
      }
    }
    case 'vis-elem': {
      if (newBody.kind !== 'visual') {
        return { outcome: 'outdated', reason: 'the new version has no captures' }
      }
      const holders = newBody.captures.filter(c =>
        c.elements?.some(e => e.id === anchor.elementId),
      )
      if (holders.length === 1) {
        return {
          outcome: 'relocated',
          anchor: { t: 'vis-elem', captureRef: holders[0]!.ref, elementId: anchor.elementId },
        }
      }
      return {
        outcome: 'outdated',
        reason:
          holders.length === 0
            ? 'no capture in the new version carries this element'
            : 'the element appears in multiple captures',
      }
    }
    case 'vis-region': {
      if (newBody.kind !== 'visual') {
        return { outcome: 'outdated', reason: 'the new version has no captures' }
      }
      const identical = newBody.captures.filter(
        c =>
          (anchor.captureDigest !== undefined && c.digest === anchor.captureDigest) ||
          (anchor.captureDigest === undefined && c.ref === anchor.captureRef),
      )
      if (identical.length === 1) {
        const c = identical[0]!
        const next: ReviewAnchor = {
          t: 'vis-region',
          captureRef: c.ref,
          rect: anchor.rect,
          ...(c.digest !== undefined && { captureDigest: c.digest }),
        }
        return { outcome: 'relocated', anchor: next }
      }
      return { outcome: 'outdated', reason: 'the capture changed — a pixel region cannot relocate' }
    }
    case 'journey-step': {
      if (newBody.kind !== 'journey') {
        return { outcome: 'outdated', reason: 'the new version has no journey steps' }
      }
      return newBody.steps.some(s => s.id === anchor.stepId)
        ? { outcome: 'relocated', anchor }
        : { outcome: 'outdated', reason: `step '${anchor.stepId}' is gone from the journey` }
    }
  }
}

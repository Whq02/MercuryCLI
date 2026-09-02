import indentString from 'indent-string'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { applyTextStyles } from './colorize.js'
import { expandTabsWithColumn } from './tabstops.js'
import type { DOMElement } from './dom.js'
import getMaxWidth from './get-max-width.js'
import type { Rectangle } from './layout/geometry.js'
import { LayoutDisplay, LayoutEdge, type LayoutNode } from './layout/node.js'
import { nodeCache, pendingClears } from './node-cache.js'
import type ComposeBuffer from './compose-buffer.js'
import renderBorder from './render-border.js'
import type { Screen } from './cell-grid.js'
import squashTextNodes, {
  type StyledSegment,
  squashTextNodesToSegments,
} from './squash-text-nodes.js'
import type { Color } from './styles.js'
import { isXtermJs } from './session/capabilities.js'
import { widestLine } from './widest-line.js'
import wrapText, { truncateParts } from './wrap-text.js'

// ============================================================================
//  compose-walk — the Mercury render walk (NATIVE CORE T3).
//
//  RESPONSIBILITY: DOM tree + computed layout → composition operations on a
//  ComposeBuffer, incrementally: unchanged subtrees BLIT from the previous
//  frame's screen (nodeCache identity), dirty subtrees re-render narrowly,
//  scroll viewports move by model shifts (+ a DECSTBM hint when the terminal
//  can mirror it), and every per-frame signal the caller consumes rides ONE
//  explicit ComposeSignals record — no module-global frame scratch.
//
//  CONTRACT: scripts/core-runtime/prove-compose-contract.ts (INCREMENTAL ≡
//  FRESH · steady-state zero-write · dirty-narrow bounds · scroll-hint truth
//  · the rail-drag no-hint law · sticky follow), the frame goldens, the
//  layout corpus, streaming laws, and the live visual baseline.
//
//  THE REUSE SAFETY RULES (each guards a proven ghost class):
//    · a clean node blits ONLY when its cached rect is unchanged and no
//      earlier sibling was dirty (overflow contamination) and no child was
//      removed under the parent (unknown vacated cells);
//    · dirty CLIPPED (both axes) children don't contaminate later siblings —
//      their paint cannot escape their bounds; but a later ABSOLUTE sibling
//      OVERLAPPING them must not self-blit (transparent gaps re-import stale
//      cells) — it descends and lets opaque descendants blit;
//    · a blitting node re-blits its escaping ABSOLUTE descendants (they
//      paint outside its rect and a dirty sibling may have overwritten them);
//    · background/opaque fills disable child blit for the frame (the fill
//      just overwrote the interior), as does REMOVING a fill (one default-bg
//      repaint frame — the stranded-hover-fill class);
//    · display:none and yoga-squeezed (h=0 sharing a row) subtrees clear
//      their old rect and DROP their subtree cache (stale rects re-imported
//      on restore — the cockpit-rail row-residue class).
// ============================================================================

export type ScrollHint = { top: number; bottom: number; delta: number }
export type FollowScroll = {
  delta: number
  viewportTop: number
  viewportBottom: number
}

const SHIFT_LOG_CAP = 48
// Forensics config (read once — env is boot-stable).
const shiftForensicsOn = !!process.env.INK_COMPOSED_TEE

/** The per-frame composition signals — created by the composition root for
 *  each frame, consumed by the renderer/ink after the walk returns. Replaces
 *  the historical module-global scratch (one owner, explicit lifetime). */
export class ComposeSignals {
  /** Any node's geometry diverged from its cached rect this frame. */
  layoutShifted = false
  /** First divergent row across all shifts, when every site could name one. */
  private shiftMinRow: number | null = null
  private shiftRowUnknown = false
  /** Headline reason + capped log (INK_COMPOSED_TEE forensics only). */
  shiftReason: string | null = null
  shiftLog: string[] = []
  /** DECSTBM hint for the writer (full-width stable scrolls only). */
  scrollHint: ScrollHint | null = null
  /** ScrollBox with drain remaining — the renderer re-dirties it so the
   *  next frame descends and continues draining. */
  scrollDrainNode: DOMElement | null = null
  /** At-bottom follow this frame — ink translates the text selection. */
  followScroll: FollowScroll | null = null
  /** Absolute-overlay rects seen THIS frame (cur) — the caller carries them
   *  to the next frame as prevAbsoluteRects. */
  readonly absoluteRectsCur: Rectangle[] = []

  markLayoutShift(reason: () => string, divergentRow?: number): void {
    if (shiftForensicsOn && this.shiftLog.length < SHIFT_LOG_CAP) {
      const r = reason()
      if (!this.layoutShifted) this.shiftReason = r
      this.shiftLog.push(r)
    }
    if (divergentRow === undefined || !Number.isFinite(divergentRow)) {
      this.shiftRowUnknown = true
    } else {
      this.shiftMinRow =
        this.shiftMinRow === null ? divergentRow : Math.min(this.shiftMinRow, divergentRow)
    }
    this.layoutShifted = true
  }

  /** The shift band's top row, or null when unknown (⇒ full damage). */
  shiftBandTop(): number | null {
    if (!this.layoutShifted || this.shiftRowUnknown || this.shiftMinRow === null) return null
    return Math.max(0, Math.floor(this.shiftMinRow))
  }

  consumeFollowScroll(): FollowScroll | null {
    const f = this.followScroll
    this.followScroll = null
    return f
  }
}

/** STALE-PAINT hardening (the "ABSOLUTE-RECT" class): rows any
 *  absolute overlay covered last frame or covers this frame join the diff's
 *  damage union, so a vacated/desynced overlay band can never survive as a
 *  ghost. No overlays ⇒ exact no-op. */
export function expandDamageForAbsoluteRects(
  screen: { width: number; height: number; damage: Rectangle | undefined },
  prevRects: readonly Rectangle[],
  curRects: readonly Rectangle[],
): void {
  if (prevRects.length === 0 && curRects.length === 0) return
  for (const r of [...prevRects, ...curRects]) {
    const x0 = Math.max(0, Math.floor(r.x))
    const y0 = Math.max(0, Math.floor(r.y))
    const x1 = Math.min(screen.width, Math.ceil(r.x + r.width))
    const y1 = Math.min(screen.height, Math.ceil(r.y + r.height))
    if (x1 <= x0 || y1 <= y0) continue
    const d = screen.damage
    if (!d) {
      screen.damage = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      continue
    }
    const right = Math.max(d.x + d.width, x1)
    const bottom = Math.max(d.y + d.height, y1)
    if (x0 < d.x) d.x = x0
    if (y0 < d.y) d.y = y0
    d.width = right - d.x
    d.height = bottom - d.y
  }
}

// ── scroll drain curves ─────────────────────────────────────────────────────

// Matches detectXtermJsWheel() in ScrollKeybindingHandler.tsx — the curve
// and drain must agree on terminal detection.
function isXtermJsHost(): boolean {
  return process.env.TERM_PROGRAM === 'vscode' || isXtermJs()
}

const SCROLL_MIN_PER_FRAME = 4
const SCROLL_INSTANT_THRESHOLD = 5
const SCROLL_HIGH_PENDING = 12
const SCROLL_STEP_MED = 2
const SCROLL_STEP_HIGH = 3
const SCROLL_MAX_PENDING = 30

/** xterm.js (VS Code — sparse wheel events): small-pending drains instantly,
 *  larger pendings step smoothly, excess beyond the animation window snaps. */
function drainAdaptive(node: DOMElement, pending: number, innerHeight: number): number {
  const sign = pending > 0 ? 1 : -1
  let abs = Math.abs(pending)
  let applied = 0
  if (abs > SCROLL_MAX_PENDING) {
    applied += sign * (abs - SCROLL_MAX_PENDING)
    abs = SCROLL_MAX_PENDING
  }
  const step =
    abs <= SCROLL_INSTANT_THRESHOLD
      ? abs
      : abs < SCROLL_HIGH_PENDING
        ? SCROLL_STEP_MED
        : SCROLL_STEP_HIGH
  applied += sign * step
  const rem = abs - step
  const cap = Math.max(1, innerHeight - 1) // < viewport so the DECSTBM hint can fire
  const totalAbs = Math.abs(applied)
  if (totalAbs > cap) {
    const excess = totalAbs - cap
    ;(node.scroll ??= {}).pendingScrollDelta = sign * (rem + excess)
    return sign * cap
  }
  ;(node.scroll ??= {}).pendingScrollDelta = rem > 0 ? sign * rem : undefined
  return applied
}

/** Native terminals (proportional burst events): ~3/4 of the remainder per
 *  frame — big bursts converge in log₄ frames, the tail decelerates. */
function drainProportional(node: DOMElement, pending: number, innerHeight: number): number {
  const abs = Math.abs(pending)
  const cap = Math.max(1, innerHeight - 1)
  const step = Math.min(cap, Math.max(SCROLL_MIN_PER_FRAME, (abs * 3) >> 2))
  if (abs <= step) {
    ;(node.scroll ??= {}).pendingScrollDelta = undefined
    return pending
  }
  const applied = pending > 0 ? step : -step
  ;(node.scroll ??= {}).pendingScrollDelta = pending - applied
  return applied
}

// ── the text lane (segments → wrapped, styled, link-wrapped text) ───────────

const OSC = '\u001B]'
const BEL = '\u0007'

function wrapWithOsc8Link(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
}

/** char position in the joined plain text → owning segment index. */
export function buildCharToSegmentMap(segments: StyledSegment[]): number[] {
  const map: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i]!.text.length
    for (let j = 0; j < len; j++) map.push(i)
  }
  return map
}

/** The wrapper's own input transform — NFC, CRLF folded — which the bundled
 *  wrapper (the product's own under node) applies before it wraps, so the
 *  wrapped output indexes THIS form of the text, never the source. */
const wrapperInputForm = (text: string): string => text.normalize('NFC').replace(/\r\n/g, '\n')

/** The joined text in the wrapper's input form, with a segment map over
 *  THAT string (FN-016 R11's normalize face): a decomposed source produced
 *  wrapped output one code unit shorter per cluster than the string the map
 *  indexed, drifting every style boundary after it. Already-normal text —
 *  the common path — keeps the plain map, byte for byte. Each segment owns
 *  the units the normal form of the text THROUGH it adds, so a character
 *  composed across a segment boundary follows its base character's segment
 *  (the cell it paints on). */
function wrapperNormalForm(
  segments: StyledSegment[],
  plainText: string,
): { plain: string; charToSegment: number[] } {
  const plain = wrapperInputForm(plainText)
  if (plain === plainText) return { plain, charToSegment: buildCharToSegmentMap(segments) }
  const charToSegment: number[] = []
  let through = ''
  for (let i = 0; i < segments.length; i++) {
    through += segments[i]!.text
    const upto = wrapperInputForm(through).length
    while (charToSegment.length < upto) charToSegment.push(i)
  }
  return { plain, charToSegment }
}

/** Re-apply per-segment styles to wrapped plain text by mapping every output
 *  character back to its source segment. Two compensations keep the map
 *  aligned with what the wrapper dropped: trimEnabled (wrap-trim) skips the
 *  whitespace runs trim collapses; softWrap (plain wrap) marks the
 *  soft-break continuation lines whose leading plain spaces
 *  stripSoftWrapLeadingSpaces removed — un-compensated, every word ending
 *  exactly at the wrap column shifted the continuation's styles one
 *  character early, accumulating line by line (FN-016 R11's wrap face).
 *  Wrap modes only: truncate output is not position-preserving and is
 *  styled through its own cut boundaries (styleTruncatedLines). */
export function applyStylesToWrappedText(
  wrappedPlain: string,
  segments: StyledSegment[],
  charToSegment: number[],
  originalPlain: string,
  trimEnabled: boolean = false,
  softWrap?: readonly boolean[],
): string {
  const lines = wrappedPlain.split('\n')
  const resultLines: string[] = []

  let charIndex = 0
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!

    // Wrap-trim dropped this line's leading whitespace — advance past it in
    // the original (only when the original HAS whitespace and the line
    // doesn't start with it; preserved whitespace must not be skipped).
    if (trimEnabled && line.length > 0) {
      const lineStartsWithWhitespace = /\s/.test(line[0]!)
      const originalHasWhitespace =
        charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)
      if (originalHasWhitespace && !lineStartsWithWhitespace) {
        while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
          charIndex++
        }
      }
    } else if (softWrap?.[lineIdx] === true && !line.startsWith(' ')) {
      // Plain wrap strips the leading plain spaces of a soft-break
      // continuation line and loses nothing else (trim: false), so the
      // stripped spaces sit in the original exactly here — step past them.
      // Keyed on the soft-break record, never on whitespace alone: a blank
      // source line followed by an indented one keeps every space.
      while (charIndex < originalPlain.length && originalPlain[charIndex] === ' ') {
        charIndex++
      }
    }

    let styledLine = ''
    let runStart = 0
    let runSegmentIndex = charToSegment[charIndex] ?? 0

    const flushRun = (endExclusive: number): void => {
      const runText = line.slice(runStart, endExclusive)
      const segment = segments[runSegmentIndex]
      if (segment) {
        let styled = applyTextStyles(runText, segment.styles)
        if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
        styledLine += styled
      } else {
        styledLine += runText
      }
    }

    for (let i = 0; i < line.length; i++) {
      const currentSegmentIndex = charToSegment[charIndex] ?? runSegmentIndex
      if (currentSegmentIndex !== runSegmentIndex) {
        flushRun(i)
        runStart = i
        runSegmentIndex = currentSegmentIndex
      }
      charIndex++
    }
    flushRun(line.length)
    resultLines.push(styledLine)

    // A REAL newline in the original sits between the split lines — step it.
    if (charIndex < originalPlain.length && originalPlain[charIndex] === '\n') {
      charIndex++
    }

    // Wrap-trim replaced a whitespace run with the line break — skip it,
    // stopping at the character that starts the next line.
    if (trimEnabled && lineIdx < lines.length - 1) {
      const nextLine = lines[lineIdx + 1]!
      const nextFirst = nextLine.length > 0 ? nextLine[0] : null
      while (charIndex < originalPlain.length && /\s/.test(originalPlain[charIndex]!)) {
        if (nextFirst !== null && originalPlain[charIndex] === nextFirst) break
        charIndex++
      }
    }
  }

  return resultLines.join('\n')
}

/** Style the source-index range [from, to) of the joined plain text through
 *  the segment map — runs grouped by owning segment, each styled and
 *  link-wrapped exactly like the linear walk's flushRun. */
function styleSourceRange(
  plainText: string,
  segments: StyledSegment[],
  charToSegment: number[],
  from: number,
  to: number,
): string {
  let out = ''
  let runStart = from
  let runSegment = charToSegment[from] ?? 0
  const flush = (end: number): void => {
    if (end <= runStart) return
    const runText = plainText.slice(runStart, end)
    const segment = segments[runSegment]
    if (segment) {
      let styled = applyTextStyles(runText, segment.styles)
      if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
      out += styled
    } else {
      out += runText
    }
  }
  for (let i = from; i < to; i++) {
    const seg = charToSegment[i] ?? runSegment
    if (seg !== runSegment) {
      flush(i)
      runStart = i
      runSegment = seg
    }
  }
  flush(to)
  return out
}

/** Truncate modes, styled through the cut's OWN boundaries (FN-016 R11's
 *  truncate face): per source line (R14's split), the lead keeps its
 *  prefix styles, the trail keeps its SUFFIX styles, and the ellipsis wears
 *  the style of the first character it stands for. The linear map assumed
 *  output position == source position — true only inside the lead — so a
 *  tool-use header's "+12" and "-3" came out in the dim path colour past
 *  the ellipsis, and under truncate-start the whole visible line wore the
 *  colours of the characters the cut discarded. truncateParts is the one
 *  owner of the cut arithmetic (wrapText's own arms call it). */
function styleTruncatedLines(
  plainText: string,
  segments: StyledSegment[],
  charToSegment: number[],
  maxWidth: number,
  textWrap: string,
): string {
  const out: string[] = []
  let base = 0
  for (const line of plainText.split('\n')) {
    const end = base + line.length
    const parts = truncateParts(line, maxWidth, textWrap)
    if (parts === null) {
      out.push(styleSourceRange(plainText, segments, charToSegment, base, end))
    } else {
      const leadEnd = base + parts.lead.length
      const trailStart = end - parts.trail.length
      let styled = styleSourceRange(plainText, segments, charToSegment, base, leadEnd)
      if (parts.ellipsis) {
        const cutAt = Math.max(base, Math.min(leadEnd, end - 1))
        const segment = segments[charToSegment[cutAt] ?? 0]
        styled += segment ? applyTextStyles('…', segment.styles) : '…'
      }
      styled += styleSourceRange(plainText, segments, charToSegment, trailStart, end)
      out.push(styled)
    }
    base = end + 1
  }
  return out.join('\n')
}

/** Wrap and record which output lines are soft-wrap continuations. Truncate
 *  modes never add newlines — softWrap stays undefined for them. */
function wrapWithSoftWrap(
  plainText: string,
  maxWidth: number,
  textWrap: Parameters<typeof wrapText>[2],
): { wrapped: string; softWrap: boolean[] | undefined } {
  if (textWrap !== 'wrap' && textWrap !== 'wrap-trim') {
    // Truncate modes cut EACH SOURCE LINE on its own (FN-016 R14) — the
    // exact split layout measures with (dom.ts truncates per line, its
    // comment naming compositor parity as the requirement). Cutting the
    // JOINED string spent the whole width budget on the first line —
    // stringWidth bills the newline zero — so a multi-line draft collapsed
    // to one row (head + ellipsis, every later line gone, the reserved
    // rows blank) the moment its widest line overflowed by one column.
    // Newline-free text keeps the single-slice path unchanged.
    if (!plainText.includes('\n')) {
      return { wrapped: wrapText(plainText, maxWidth, textWrap), softWrap: undefined }
    }
    return {
      wrapped: plainText
        .split('\n')
        .map(line => wrapText(line, maxWidth, textWrap))
        .join('\n'),
      softWrap: undefined,
    }
  }
  const outLines: string[] = []
  const softWrap: boolean[] = []
  for (const orig of plainText.split('\n')) {
    const pieces = wrapText(orig, maxWidth, textWrap).split('\n')
    for (let i = 0; i < pieces.length; i++) {
      outLines.push(pieces[i]!)
      softWrap.push(i > 0)
    }
  }
  return { wrapped: outLines.join('\n'), softWrap }
}

/** Inside a <Box>, the first text child's layout offset positions the whole
 *  squashed text (later text nodes can't have margin/padding). */
function applyPaddingToText(node: DOMElement, text: string, softWrap?: boolean[]): string {
  const layoutNode = node.childNodes[0]?.layoutNode
  if (layoutNode) {
    const offsetX = layoutNode.getComputedLeft()
    const offsetY = layoutNode.getComputedTop()
    text = '\n'.repeat(offsetY) + indentString(text, offsetX)
    if (softWrap && offsetY > 0) {
      softWrap.unshift(...Array<boolean>(offsetY).fill(false))
    }
  }
  return text
}

// ── the walk ────────────────────────────────────────────────────────────────

type WalkCtx = {
  buffer: ComposeBuffer
  signals: ComposeSignals
  prevAbsoluteRects: readonly Rectangle[]
  /** The writer WILL emit a DECSTBM region scroll for a full-width hint this
   *  frame. The full-width shift excludes the shifted rows from damage on
   *  exactly that promise; when the writer's capability gate declines the
   *  hardware scroll (Apple Terminal: no sync output; conhost lineage: the
   *  phantom-region-scroll class), an excluded row is never re-emitted and
   *  the GLASS keeps the pre-scroll cells — the same reply painted at two
   *  offsets, accumulating until a full repaint. False ⇒ full-width scroll
   *  surfaces take the rect-shift road (damage-unioned; the diff re-emits). */
  regionScrollUsable: boolean
}

type NodeOpts = {
  offsetX?: number
  offsetY?: number
  prevScreen: Screen | undefined
  /** Descend instead of self-blitting (non-opaque absolute overlay over a
   *  dirty clipped region) while still letting opaque descendants blit. */
  skipSelfBlit?: boolean
  inheritedBackgroundColor?: Color
  /** The nearest ancestor's `fillRowBg` sampler (ONE-BACKDROP fill side).
   *  Mutually exclusive with inheritedBackgroundColor by construction —
   *  the nearest painter wins (see composeBox's resolution). */
  inheritedRowBg?: (row: number) => Color | undefined
}

export type ComposeOptions = {
  offsetX?: number
  offsetY?: number
  prevScreen: Screen | undefined
  /** Per-frame signals record; omitted (side renders) → throwaway. */
  signals?: ComposeSignals
  /** Last frame's absolute-overlay rects (the third-pass repair reads them). */
  prevAbsoluteRects?: readonly Rectangle[]
  /** See WalkCtx.regionScrollUsable. Omitted ⇒ false (fail-safe: without the
   *  writer's promise no damage-excluded full-width shift may compose). */
  regionScrollUsable?: boolean
}

/** Compose a laid-out DOM tree into the buffer. Returns the signals record
 *  the frame produced. */
export default function composeTree(
  root: DOMElement,
  buffer: ComposeBuffer,
  opts: ComposeOptions,
): ComposeSignals {
  const ctx: WalkCtx = {
    buffer,
    signals: opts.signals ?? new ComposeSignals(),
    prevAbsoluteRects: opts.prevAbsoluteRects ?? [],
    regionScrollUsable: opts.regionScrollUsable === true,
  }
  composeNode(root, ctx, {
    offsetX: opts.offsetX,
    offsetY: opts.offsetY,
    prevScreen: opts.prevScreen,
  })
  return ctx.signals
}

function composeNode(node: DOMElement, ctx: WalkCtx, opts: NodeOpts): void {
  const { layoutNode } = node
  if (!layoutNode) return
  const { buffer, signals } = ctx
  const offsetX = opts.offsetX ?? 0
  const offsetY = opts.offsetY ?? 0

  if (layoutNode.getDisplay() === LayoutDisplay.None) {
    // Newly hidden: clear the old rect and drop the subtree cache —
    // hideInstance's markDirty walks UP only, so descendants keep pre-hide
    // rects; on unhide a rect-match blit would import the CLEARED cells.
    if (node.dirty) {
      const cached = nodeCache.get(node)
      if (cached) {
        buffer.clear({
          x: Math.floor(cached.x),
          y: Math.floor(cached.y),
          width: Math.floor(cached.width),
          height: Math.floor(cached.height),
        })
        dropSubtreeCache(node)
        signals.markLayoutShift(() => `display-none-clear:${node.nodeName}`, Math.floor(cached.y))
      }
    }
    return
  }

  const x = offsetX + layoutNode.getComputedLeft()
  const yogaTop = layoutNode.getComputedTop()
  let y = offsetY + yogaTop
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()

  // An absolute overlay extending above the viewport clamps to row 0 — the
  // top rows (an autocomplete's best matches) stay visible; the bottom
  // overflows under the opaque paint instead.
  if (y < 0 && node.style.position === 'absolute') {
    y = 0
  }

  // ── clean-subtree reuse: blit the previous frame's cells ──────────────────
  const cached = nodeCache.get(node)
  if (
    !node.dirty &&
    !opts.skipSelfBlit &&
    node.scroll?.pendingScrollDelta === undefined &&
    cached &&
    cached.x === x &&
    cached.y === y &&
    cached.width === width &&
    cached.height === height &&
    opts.prevScreen
  ) {
    const fx = Math.floor(x)
    const fy = Math.floor(y)
    const fw = Math.floor(width)
    const fh = Math.floor(height)
    buffer.blit(opts.prevScreen, fx, fy, fw, fh)
    if (node.style.position === 'absolute') {
      signals.absoluteRectsCur.push(cached)
    }
    // Absolute descendants can paint OUTSIDE this rect (a menu floating
    // above); a dirty clipped sibling may have overwritten those cells —
    // restore them, they're not covered by the self-blit.
    blitEscapingAbsoluteDescendants(node, ctx, opts.prevScreen, fx, fy, fw, fh)
    return
  }

  // ── stale-rect clearing + shift forensics ─────────────────────────────────
  const positionChanged =
    cached !== undefined &&
    (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height)
  if (positionChanged) {
    signals.markLayoutShift(
      () => {
        const s = node.style as Record<string, unknown>
        const fp =
          ` w=${JSON.stringify(s['width'])},mw=${JSON.stringify(s['minWidth'])}` +
          `,fg=${JSON.stringify(s['flexGrow'])},fs=${JSON.stringify(s['flexShrink'])}` +
          `,fb=${JSON.stringify(s['flexBasis'])},as=${JSON.stringify(s['alignSelf'])}`
        let text = ''
        if (node.nodeName === 'ink-text') {
          try {
            text = ` "${squashTextNodes(node).replace(/\n/g, '\\n').slice(0, 28)}"`
          } catch {
            /* forensics only */
          }
        }
        return (
          `moved:${node.nodeName}@${Math.floor(x)},${Math.floor(y)} ` +
          `${cached!.x},${cached!.y},${cached!.width}x${cached!.height}→${x},${y},${width}x${height}` +
          fp +
          text +
          (node.debugOwnerChain ? ` [${node.debugOwnerChain.slice(0, 5).join('<')}]` : '')
        )
      },
      // First divergent row: a moved top diverges at the earlier top; a
      // same-top grow/shrink where the shorter extent ends; a same-rect
      // width change on its own first row.
      cached!.y !== y
        ? Math.floor(Math.min(cached!.y, y))
        : cached!.height !== height
          ? Math.floor(y + Math.min(cached!.height, height))
          : Math.floor(y),
    )
  }
  if (cached && (node.dirty || positionChanged)) {
    // NO ground fill here (refuted + reverted):
    // buffer.clear is DAMAGE-ONLY (the compose buffer starts zeroed each
    // frame), so the vacated rect needs no repair write — a bg ancestor's
    // interior fill runs every composed frame BEFORE its children, so
    // vacated cells already resolve to the effective ground. A real write
    // here applies in op order and WIPES an earlier sibling's same-frame
    // content when children shift down (pinned: prove-fill-law F6).
    buffer.clear(
      {
        x: Math.floor(cached.x),
        y: Math.floor(cached.y),
        width: Math.floor(cached.width),
        height: Math.floor(cached.height),
      },
      node.style.position === 'absolute',
    )
  }

  // Removed children left vacated rects (recorded at removal time — their
  // positions are unknowable now). Their clears also disable sibling blits.
  // (Same no-fill law as the stale-rect clear above.)
  const clears = pendingClears.get(node)
  const hasRemovedChild = clears !== undefined
  if (hasRemovedChild) {
    signals.markLayoutShift(
      () => `removed-child:${node.nodeName}`,
      clears!.length > 0 ? Math.min(...clears!.map(r => Math.floor(r.y))) : undefined,
    )
    for (const rect of clears!) {
      buffer.clear({
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      })
    }
    pendingClears.delete(node)
  }

  // Yoga squeezed this node to h=0 AND a sibling owns the same row — both
  // would write there and the longer tail ghosts. (h=0 alone is NOT enough:
  // pixel-grid rounding can leave the row to this node — HelpV2's column.)
  if (height === 0 && siblingSharesY(node, layoutNode)) {
    nodeCache.set(node, { x, y, width, height, top: yogaTop })
    dropSubtreeCache(node)
    node.dirty = false
    return
  }

  if (node.nodeName === 'ink-raw-ansi') {
    // Producer-rendered ANSI: already wrapped + styled; parse straight to cells.
    const text = node.attributes['rawText'] as string
    if (text) buffer.write(x, y, text)
  } else if (node.nodeName === 'ink-text') {
    composeText(node, ctx, x, y, layoutNode, opts.inheritedBackgroundColor, opts.inheritedRowBg)
  } else if (node.nodeName === 'ink-box') {
    composeBox(node, ctx, opts, x, y, yogaTop, width, height, layoutNode, hasRemovedChild)
  } else if (node.nodeName === 'ink-root') {
    composeChildren(node, ctx, x, y, hasRemovedChild, opts.prevScreen, opts.inheritedBackgroundColor, opts.inheritedRowBg)
  }

  const rect = { x, y, width, height, top: yogaTop }
  nodeCache.set(node, rect)
  if (node.style.position === 'absolute') {
    signals.absoluteRectsCur.push(rect)
  }
  node.dirty = false
}

// ── text nodes ──────────────────────────────────────────────────────────────

function composeText(
  node: DOMElement,
  ctx: WalkCtx,
  x: number,
  y: number,
  layoutNode: LayoutNode,
  inheritedBackgroundColor: Color | undefined,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let segments = squashTextNodesToSegments(
    node,
    inheritedBackgroundColor ? { backgroundColor: inheritedBackgroundColor } : undefined,
  )
  // ONE WIDTH OWNER for literal tabs (FN-016 R4): expand HERE, before any
  // width is measured, at the column origin layout measures with (the
  // text's own column 0, resetting at newlines — dom.ts expands the same
  // string the same way). Un-expanded, a tab measured ZERO at the wrap
  // decision (stringWidth's ASCII fast path), the clip slice kept the
  // whole line, and writeLine expanded it to up to eight cells from the
  // ABSOLUTE screen column — one line, three disagreeing widths: no wrap,
  // an overrun into the neighbor pane, a blank reserved row underneath,
  // and tab columns that shifted with the pane's indent. The running
  // column carries ACROSS segments so a styled line expands exactly as its
  // plain join would.
  if (segments.some(s => s.text.includes('\t'))) {
    let column = 0
    segments = segments.map(s => {
      const expanded = expandTabsWithColumn(s.text, column)
      column = expanded.column
      return expanded.text === s.text ? s : { ...s, text: expanded.text }
    })
  }
  const plainText = segments.map(s => s.text).join('')
  if (plainText.length === 0) return

  // Yoga's AtMost width can exceed the actual screen space; its height
  // already reflects the constrained pass — clamp the wrap width so the
  // composed line count matches layout (cells past the edge would be
  // dropped by the grid's bounds check).
  const maxWidth = Math.min(getMaxWidth(layoutNode), ctx.buffer.width - x)
  const textWrap = node.style.textWrap ?? 'wrap'
  const needsWrapping = widestLine(plainText) > maxWidth

  let text: string
  let softWrap: boolean[] | undefined
  if (needsWrapping && segments.length === 1) {
    const segment = segments[0]!
    const w = wrapWithSoftWrap(plainText, maxWidth, textWrap)
    softWrap = w.softWrap
    text = w.wrapped
      .split('\n')
      .map(line => {
        let styled = applyTextStyles(line, segment.styles)
        // Per-line OSC 8 so every wrapped line is independently clickable
        // (the buffer tokenizes line by line).
        if (segment.hyperlink) styled = wrapWithOsc8Link(styled, segment.hyperlink)
        return styled
      })
      .join('\n')
  } else if (needsWrapping && textWrap.startsWith('truncate')) {
    // Truncate output is not position-preserving — styled through the
    // cut's own boundaries, never the linear map (R11). The truncate modes
    // only: the inert union members (`end`, `middle`) leave their text
    // untouched, exactly as layout measured it, and take the map below.
    softWrap = undefined
    text = styleTruncatedLines(plainText, segments, buildCharToSegmentMap(segments), maxWidth, textWrap)
  } else if (needsWrapping) {
    // The wrap modes run the wrapper, so the map must index the string the
    // wrapper actually wrapped — its own input form (R11's normalize face);
    // plain wrap hands the soft-break record down so the stripped
    // continuation indent is compensated (R11's wrap face).
    const wraps = textWrap === 'wrap' || textWrap === 'wrap-trim'
    const { plain, charToSegment } = wraps
      ? wrapperNormalForm(segments, plainText)
      : { plain: plainText, charToSegment: buildCharToSegmentMap(segments) }
    const w = wrapWithSoftWrap(plain, maxWidth, textWrap)
    softWrap = w.softWrap
    text = applyStylesToWrappedText(
      w.wrapped,
      segments,
      charToSegment,
      plain,
      textWrap === 'wrap-trim',
      textWrap === 'wrap' ? softWrap : undefined,
    )
  } else {
    text = segments
      .map(segment => {
        let styledText = applyTextStyles(segment.text, segment.styles)
        if (segment.hyperlink) styledText = wrapWithOsc8Link(styledText, segment.hyperlink)
        return styledText
      })
      .join('')
  }

  text = applyPaddingToText(node, text, softWrap)
  // ONE-BACKDROP fill side: under an ancestor's fillRowBg sampler (and no
  // uniform inherited ground — mutually exclusive by construction), every
  // rendered LINE resolves its own row's bg and wraps it around the styled
  // run — the render-border layering precedent: fg opens/closes never emit
  // SGR 49, so the line-level bg survives every inner fg/bold/dim run.
  if (inheritedRowBg !== undefined && inheritedBackgroundColor === undefined) {
    text = text
      .split('\n')
      .map((line, k) => {
        const bg = inheritedRowBg(y + k)
        return bg !== undefined && line.length > 0 ? applyTextStyles(line, { backgroundColor: bg }) : line
      })
      .join('\n')
  }
  ctx.buffer.write(x, y, text, softWrap)
}

// ── boxes (clip · scroll · fill · border) ───────────────────────────────────

/** The fill law's ONE writer: a repaired/filled rectangle
 *  resolves to the EFFECTIVE ground (the nearest deliberately-filled
 *  ancestor's background), never silently to the terminal ground. With no
 *  effective ground the fill stays plain spaces (zero cells — the erase-at-
 *  claim epoch guarantee owns the physical blank). */
function groundFillLines(width: number, height: number, bg: Color | undefined): string {
  const spaces = ' '.repeat(width)
  const line = bg ? applyTextStyles(spaces, { backgroundColor: bg }) : spaces
  return Array(height).fill(line).join('\n')
}

function composeBox(
  node: DOMElement,
  ctx: WalkCtx,
  opts: NodeOpts,
  x: number,
  y: number,
  yogaTop: number,
  width: number,
  height: number,
  layoutNode: LayoutNode,
  hasRemovedChild: boolean,
): void {
  const { buffer, signals } = ctx
  // ONE-BACKDROP resolution (nearest painter wins, exactly like the uniform
  // chain): an own backgroundColor overrides any sampler for this subtree
  // (hover fills, selection bands); an own fillRowBg overrides the uniform
  // inherited ground; otherwise both inherited channels pass through — at
  // most one is set (the invariant this resolution maintains).
  const ownRowBg = node.style.fillRowBg
  const rowSampler =
    node.style.backgroundColor !== undefined
      ? undefined
      : ((ownRowBg as ((row: number) => Color | undefined) | undefined) ?? opts.inheritedRowBg)
  const boxBackgroundColor =
    node.style.backgroundColor ?? (rowSampler !== undefined ? undefined : opts.inheritedBackgroundColor)

  // Selection fencing — applied last in the buffer, wins over blits.
  if (node.style.noSelect) {
    const boxX = Math.floor(x)
    const fromEdge = node.style.noSelect === 'from-left-edge'
    buffer.noSelect({
      x: fromEdge ? 0 : boxX,
      y: Math.floor(y),
      width: fromEdge ? boxX + Math.floor(width) : Math.floor(width),
      height: Math.floor(height),
    })
  }

  const overflowX = node.style.overflowX ?? node.style.overflow
  const overflowY = node.style.overflowY ?? node.style.overflow
  const clipHorizontally = overflowX === 'hidden' || overflowX === 'scroll'
  const clipVertically = overflowY === 'hidden' || overflowY === 'scroll'
  const isScrollY = overflowY === 'scroll'
  const needsClip = clipHorizontally || clipVertically

  let y1: number | undefined
  let y2: number | undefined
  if (needsClip) {
    const x1 = clipHorizontally ? x + layoutNode.getComputedBorder(LayoutEdge.Left) : undefined
    const x2 = clipHorizontally
      ? x + layoutNode.getComputedWidth() - layoutNode.getComputedBorder(LayoutEdge.Right)
      : undefined
    y1 = clipVertically ? y + layoutNode.getComputedBorder(LayoutEdge.Top) : undefined
    y2 = clipVertically
      ? y + layoutNode.getComputedHeight() - layoutNode.getComputedBorder(LayoutEdge.Bottom)
      : undefined
    buffer.clip({ x1, x2, y1, y2 })
  }

  if (isScrollY) {
    composeScrollBox(node, ctx, opts, x, y, width, height, layoutNode, y1, y2, hasRemovedChild, boxBackgroundColor, rowSampler)
  } else {
    // Interior fill: background color (or opaque space-fill) repaints the
    // whole interior — and a REMOVED fill repaints once with default bg so
    // the un-highlight can't be blitted away (the stranded-hover-fill).
    const ownBackgroundColor = node.style.backgroundColor
    const fillMemo = node as unknown as { __prevOwnBg?: unknown; __prevOpaque?: boolean; __prevOwnRowBg?: boolean }
    const fillRemoved =
      (fillMemo.__prevOwnBg !== undefined && ownBackgroundColor === undefined) ||
      (fillMemo.__prevOpaque === true && node.style.opaque !== true) ||
      (fillMemo.__prevOwnRowBg === true && ownRowBg === undefined)
    fillMemo.__prevOwnBg = ownBackgroundColor
    fillMemo.__prevOpaque = node.style.opaque === true
    fillMemo.__prevOwnRowBg = ownRowBg !== undefined
    if (ownBackgroundColor || node.style.opaque || ownRowBg !== undefined || fillRemoved) {
      const borderLeft = layoutNode.getComputedBorder(LayoutEdge.Left)
      const borderRight = layoutNode.getComputedBorder(LayoutEdge.Right)
      const borderTop = layoutNode.getComputedBorder(LayoutEdge.Top)
      const borderBottom = layoutNode.getComputedBorder(LayoutEdge.Bottom)
      const innerWidth = Math.floor(width) - borderLeft - borderRight
      const innerHeight = Math.floor(height) - borderTop - borderBottom
      if (innerWidth > 0 && innerHeight > 0) {
        // The EFFECTIVE ground (fill law): an opaque claim or a removed
        // fill under a bg ancestor resolves to the ancestor's ground — a
        // plain-space fill there punched terminal-ground holes into the
        // ancestor's fill. Own bg keeps its exact legacy bytes.
        // ONE-BACKDROP fill side: an active sampler paints the interior
        // ROW BY ROW at its absolute buffer rows — the whole subtree rides
        // the graded field without hand-sliced row boxes.
        const uniformFillBg = ownBackgroundColor ?? (rowSampler !== undefined ? undefined : opts.inheritedBackgroundColor)
        if (uniformFillBg === undefined && rowSampler !== undefined) {
          const rowTop = y + borderTop
          for (let r = 0; r < innerHeight; r++) {
            buffer.write(x + borderLeft, rowTop + r, groundFillLines(innerWidth, 1, rowSampler(rowTop + r)))
          }
        } else {
          buffer.write(x + borderLeft, y + borderTop, groundFillLines(innerWidth, innerHeight, uniformFillBg))
        }
      }
    }

    composeChildren(
      node,
      ctx,
      x,
      y,
      hasRemovedChild,
      // Fills disable child blit for the frame: children CAN reposition and
      // a stale blit would land on the fresh fill (the /permissions blank).
      // A declared sampler disables it too — its per-row fill repaints the
      // interior every frame, and a stale child blit would land on it.
      ownBackgroundColor || node.style.opaque || ownRowBg !== undefined || fillRemoved ? undefined : opts.prevScreen,
      boxBackgroundColor,
      rowSampler,
    )
  }

  if (needsClip) buffer.unclip()

  // Border AFTER children: a shrinking child's old-rect clear can overlap
  // where the border now sits. The effective ground rides along (ONE-
  // BACKDROP): border writes carry the box's own??inherited fill so they
  // can never reset cells to the terminal ground inside a filled surface.
  renderBorder(x, y, node, buffer as never, boxBackgroundColor)
  void signals
}

// ── scroll boxes ────────────────────────────────────────────────────────────

function composeScrollBox(
  node: DOMElement,
  ctx: WalkCtx,
  opts: NodeOpts,
  x: number,
  y: number,
  width: number,
  height: number,
  layoutNode: LayoutNode,
  y1: number | undefined,
  y2: number | undefined,
  hasRemovedChild: boolean,
  boxBackgroundColor: Color | undefined,
  rowSampler?: (row: number) => Color | undefined,
): void {
  const { buffer, signals } = ctx
  const prevScreen = opts.prevScreen
  const cached = nodeCache.get(node)

  // ScrollBox structure: ONE content wrapper (flexShrink 0) whose intrinsic
  // height is the scrollHeight; children render translated by -scrollTop.
  const padTop = layoutNode.getComputedPadding(LayoutEdge.Top)
  const innerHeight = Math.max(
    0,
    (y2 ?? y + height) - (y1 ?? y) - padTop - layoutNode.getComputedPadding(LayoutEdge.Bottom),
  )

  const content = node.childNodes.find(c => (c as DOMElement).layoutNode) as DOMElement | undefined
  const contentYoga = content?.layoutNode
  const sc = (node.scroll ??= {})
  const scrollHeight = contentYoga?.getComputedHeight() ?? 0
  const prevScrollHeight = sc.scrollHeight ?? scrollHeight
  const prevInnerHeight = sc.scrollViewportHeight ?? innerHeight
  sc.scrollHeight = scrollHeight
  sc.scrollViewportHeight = innerHeight
  sc.scrollViewportTop = (y1 ?? y) + padTop

  const maxScroll = Math.max(0, scrollHeight - innerHeight)
  fluxMark('scroll:compose', scrollHeight * 100000 + (sc.scrollTop ?? 0))

  // Anchor seeks: scroll so an anchored element's top lands at the viewport
  // top (+offset). Ancestor tops accumulate up to the content root (deeply
  // nested anchors under-scroll by their nesting offsets otherwise); a
  // detached element (unmounted / not laid out this frame) resolves to
  // undefined.
  const contentRoot = node.childNodes[0]
  const anchorElTop = (start: DOMElement): number | undefined => {
    let el: DOMElement | undefined = start
    let acc = 0
    let hops = 0
    while (el && el !== node && el !== contentRoot && hops < 100) {
      const t = el.layoutNode?.getComputedTop()
      if (t == null) return undefined
      acc += t
      el = el.parentNode ?? undefined
      hops++
    }
    return el === contentRoot && Number.isFinite(acc) ? acc : undefined
  }

  if (sc.scrollAnchor) {
    // One-shot seek: Yoga is fresh — the read happens NOW, not when the
    // (stale-by-throttle) scrollTo number was computed.
    const anchorTop = anchorElTop(sc.scrollAnchor.el)
    // Detached anchor: drop the one-shot rather than seek somewhere wrong.
    if (anchorTop != null) {
      sc.scrollTop = anchorTop + sc.scrollAnchor.offset
      sc.pendingScrollDelta = undefined
    }
    sc.scrollAnchor = undefined
  }


  // At-bottom follow (positional + sticky flag), with the FLUX S6 guards:
  // only a GROWN frame with a stable at-bottom history may follow — a
  // transient shrink (settle swap, virtualization) collapses maxScroll and
  // every position reads "at bottom" by artifact.
  const scrollTopBeforeFollow = sc.scrollTop ?? 0
  const sticky = sc.stickyScroll ?? Boolean(node.attributes['stickyScroll'])
  const prevMaxScroll = Math.max(0, prevScrollHeight - prevInnerHeight)
  const grew = scrollHeight >= prevScrollHeight
  const atBottom =
    sticky ||
    (grew && scrollTopBeforeFollow >= prevMaxScroll && sc.lastStableAtBottom !== false)
  if (atBottom && (sc.pendingScrollDelta ?? 0) >= 0) {
    sc.scrollTop = maxScroll
    sc.pendingScrollDelta = undefined
    // Re-sync the sticky flag when POSITIONALLY at bottom and the flag was
    // explicitly broken — leaving it undefined alone (an undefined flag must
    // not become sticky-by-default and lock out direct scrollTop writes).
    if (
      sc.stickyScroll === false &&
      scrollTopBeforeFollow >= prevMaxScroll &&
      sc.lastStableAtBottom !== false
    ) {
      sc.stickyScroll = true
      fluxMark('scroll:restick', innerHeight)
    }
  }
  const followDelta = (sc.scrollTop ?? 0) - scrollTopBeforeFollow
  if (followDelta > 0) {
    fluxMark('scroll:follow', innerHeight)
    const vpTop = sc.scrollViewportTop ?? 0
    signals.followScroll = {
      delta: followDelta,
      viewportTop: vpTop,
      viewportBottom: vpTop + innerHeight - 1,
    }
  }

  // Drain pending wheel input. Past the virtual-scroll clamp the drain
  // throttles (~4 rows/frame ≈ React's slide rate) so scrollTop can't race
  // hundreds of rows ahead of the mounted range; the render-clamp below
  // holds the visual at the mounted edge either way (hard-stopping here
  // caused stop-start jutter at the edge).
  let cur = sc.scrollTop ?? 0
  const pending = sc.pendingScrollDelta
  const cMin = sc.scrollClampMin
  const cMax = sc.scrollClampMax
  const haveClamp = cMin !== undefined && cMax !== undefined
  if (pending !== undefined && pending !== 0) {
    const pastClamp = haveClamp && ((pending < 0 && cur < cMin) || (pending > 0 && cur > cMax))
    const eff = pastClamp ? Math.min(4, innerHeight >> 3) : innerHeight
    cur += isXtermJsHost() ? drainAdaptive(node, pending, eff) : drainProportional(node, pending, eff)
  } else if (pending === 0) {
    sc.pendingScrollDelta = undefined // cancelled to zero — no no-op frames
  }
  let scrollTop = Math.max(0, Math.min(cur, maxScroll))
  // FLUX S6: a shrink frame's max-clamp is PAINT-ONLY — writing it back is
  // what yanked scrolled-away readers to the bottom after a settle swap.
  const shrankPastPosition = scrollHeight < prevScrollHeight && cur > maxScroll
  // Virtual-scroll clamp: paint at the mounted edge, keep the real intent.
  const clamped = haveClamp ? Math.max(cMin, Math.min(scrollTop, cMax)) : scrollTop
  sc.scrollTop = shrankPastPosition ? Math.max(0, cur) : scrollTop
  // Record the at-bottom truth only on grown, genuinely-overflowing frames.
  if (grew && maxScroll > 0) {
    const nowAtBottom = scrollTop >= maxScroll
    if (nowAtBottom !== sc.lastStableAtBottom) fluxMark('scroll:bit', nowAtBottom ? 1 : 0)
    sc.lastStableAtBottom = nowAtBottom
  }
  if (scrollTop !== cur) sc.pendingScrollDelta = undefined
  // Clamp-hold follow-up: a paint held at the mounted edge while the intent
  // lies beyond needs a frame AFTER the commit that moves the bounds — the
  // bounds land in a layout effect, one paint too late, and a key-driven
  // jump (unlike the wheel) leaves no pending delta to request one (the
  // PageUp burst-stall class: the last commit's fresh coverage was never
  // painted). Progress-guarded: an unchanged gap stops the chain until a
  // commit moves the bounds again, so a permanently short mount can never
  // spin drain frames.
  const clampGap = clamped - scrollTop
  if (
    sc.pendingScrollDelta !== undefined ||
    (clampGap !== 0 && clampGap !== (sc.scrollClampGapPrev ?? 0))
  ) {
    signals.scrollDrainNode = node
  }
  sc.scrollClampGapPrev = clampGap
  scrollTop = clamped

  if (!content || !contentYoga) return

  const contentX = x + contentYoga.getComputedLeft()
  const contentY = y + contentYoga.getComputedTop() - scrollTop

  // ── scroll fast path planning ─────────────────────────────────────────────
  const contentCached = nodeCache.get(content)
  let hint: ScrollHint | null = null
  let rectShift: { top: number; bottom: number; delta: number; x0: number; x1: number } | null =
    null
  // ONE-BACKDROP: under a row sampler the shift fast path is UNSOUND — a
  // DECSTBM/rect shift moves rows WITH their bg, dragging the fixed field
  // along with the content. Sampler viewports always take the full path
  // (clear + per-row refill + recompose), keeping the field screen-fixed
  // while content scrolls through it.
  if (rowSampler === undefined && contentCached && contentCached.y !== contentY) {
    const delta = contentCached.y - contentY
    const regionTop = Math.floor(y + contentYoga.getComputedTop())
    const regionBottom = regionTop + innerHeight - 1
    // FULL-WIDTH GUARD (the rail-drag class): DECSTBM moves ENTIRE rows —
    // a pane that doesn't span the output width would drag its siblings'
    // cells. Column-scoped panes take the model-only rect path.
    const spansFullWidth = Math.floor(x) <= 0 && Math.ceil(x + width) >= buffer.width
    const stableForShift =
      cached?.y === y && cached.height === height && innerHeight > 0 && Math.abs(delta) < innerHeight
    // THE HINT IS A PROMISE, NOT A PREFERENCE: the full-width shift composes
    // with the shifted rows EXCLUDED from damage because the writer will move
    // them with a DECSTBM region scroll. On a terminal where the writer
    // declines that scroll (no sync output — Apple Terminal; untrusted region
    // scroll — the conhost phantom class), the excluded rows are never
    // re-emitted and the glass keeps the pre-scroll cells: the same reply
    // standing at two offsets. Without the promise the surface takes the
    // rect-shift road below — same model blit, damage unioned, diff re-emits.
    if (stableForShift && spansFullWidth && ctx.regionScrollUsable) {
      hint = { top: regionTop, bottom: regionBottom, delta }
      signals.scrollHint = hint
    } else if (stableForShift) {
      rectShift = {
        top: regionTop,
        bottom: regionBottom,
        delta,
        x0: Math.floor(x),
        x1: Math.floor(x) + Math.floor(width),
      }
    } else {
      signals.markLayoutShift(() => `scroll-no-hint:${node.nodeName}`)
    }
  }

  // The fast path handles pure scroll or bottom-append ONLY — child
  // insert/remove moves content out of step with the delta.
  const prevHeight = contentCached?.height ?? scrollHeight
  const heightDelta = scrollHeight - prevHeight
  const shiftPlan = hint ?? rectShift
  const safeForFastPath =
    !shiftPlan || heightDelta === 0 || (shiftPlan.delta > 0 && heightDelta === shiftPlan.delta)
  if (!safeForFastPath) {
    signals.scrollHint = null // a published hint the compose won't match = stale rows
    if (rectShift) {
      rectShift = null
      signals.markLayoutShift(() => `scroll-rect-unsafe:${node.nodeName}`)
    }
  }

  if ((hint || rectShift) && prevScreen && safeForFastPath) {
    // Blit the previous scroll region, shift it in the MODEL (mirroring what
    // DECSTBM will do — or standing alone on the rect path), then render
    // only the rows that scrolled IN. Clip keeps tall children out of the
    // stable rows.
    const { top, bottom, delta } = (hint ?? rectShift)!
    const w = Math.floor(width)
    buffer.blit(prevScreen, Math.floor(x), top, w, bottom - top + 1)
    if (hint) buffer.shift(top, bottom, delta)
    else buffer.shiftRect(top, bottom, rectShift!.x0, rectShift!.x1, delta)
    const edgeTop = delta > 0 ? bottom - delta + 1 : top
    const edgeBottom = delta > 0 ? bottom : top - delta - 1
    buffer.clear({ x: Math.floor(x), y: edgeTop, width: w, height: edgeBottom - edgeTop + 1 })
    // The fill law: a bg'd scroll surface's scrolled-in edge resolves
    // to its OWN ground — cleared zeros between the incoming children would
    // read as terminal-ground bands.
    if (boxBackgroundColor && edgeBottom >= edgeTop) {
      buffer.write(Math.floor(x), edgeTop, groundFillLines(w, edgeBottom - edgeTop + 1, boxBackgroundColor))
    }
    buffer.clip({ x1: undefined, x2: undefined, y1: edgeTop, y2: edgeBottom + 1 })
    // Snapshot dirty children — the edge pass clears their flags and the
    // stable-row repair pass below would miss edge-spanning ones.
    const dirtyChildren = content.dirty
      ? new Set(content.childNodes.filter(c => (c as DOMElement).dirty))
      : null
    composeScrolledChildren(
      content,
      ctx,
      contentX,
      contentY,
      hasRemovedChild,
      undefined,
      edgeTop - contentY,
      edgeBottom + 1 - contentY,
      boxBackgroundColor,
      true,
    )
    buffer.unclip()

    // Stable-row repair: children whose screen cells the shift put in the
    // WRONG place — dirty ones (stale content) and clean ones below a
    // middle-growth point (their screenY held constant while the shift
    // moved their old pixels). cumHeightShift keeps this O(dirty) for the
    // bottom-append shape.
    if (dirtyChildren) {
      const edgeTopLocal = edgeTop - contentY
      const edgeBottomLocal = edgeBottom + 1 - contentY
      let cumHeightShift = 0
      for (const childNode of content.childNodes) {
        const childElem = childNode as DOMElement
        const isDirty = dirtyChildren.has(childNode)
        if (!isDirty && cumHeightShift === 0) {
          if (nodeCache.has(childElem)) continue
          // Uncached = culled last frame, re-entering — render below.
        }
        const cy = childElem.layoutNode
        if (!cy) continue
        const childTop = cy.getComputedTop()
        const childH = cy.getComputedHeight()
        const childBottom = childTop + childH
        if (isDirty) {
          const prev = nodeCache.get(childElem)
          cumHeightShift += childH - (prev ? prev.height : 0)
        }
        if (childBottom <= scrollTop || childTop >= scrollTop + innerHeight) continue
        if (childTop >= edgeTopLocal && childBottom <= edgeBottomLocal) continue
        const screenY = Math.floor(contentY + childTop)
        if (!isDirty) {
          const childCached = nodeCache.get(childElem)
          if (childCached && Math.floor(childCached.y) - delta === screenY) continue
        }
        // The blit already wrote stale cells — clear() is damage-only, so
        // wipe with spaces before re-rendering.
        const screenBottom = Math.min(
          Math.floor(contentY + childBottom),
          Math.floor((y1 ?? y) + padTop + innerHeight),
        )
        if (screenY < screenBottom) {
          // Fill law: repair to the surface's own ground (see the fill law).
          buffer.write(Math.floor(x), screenY, groundFillLines(w, screenBottom - screenY, boxBackgroundColor))
          buffer.clip({ x1: undefined, x2: undefined, y1: screenY, y2: screenBottom })
          composeNode(childElem, ctx, {
            offsetX: contentX,
            offsetY: contentY,
            prevScreen: undefined,
            inheritedBackgroundColor: boxBackgroundColor,
          })
          buffer.unclip()
        }
      }
    }

    // Overlay-shadow repair: the blit imported the PREVIOUS frame's absolute
    // overlays (they painted into the scroll region after this box); the
    // shift moved those pixels where nothing will repaint them. Wipe the
    // shifted bands and re-render the content there.
    for (const r of ctx.prevAbsoluteRects) {
      if (r.y >= bottom + 1 || r.y + r.height <= top) continue
      const shiftedTop = Math.max(top, Math.floor(r.y) - delta)
      const shiftedBottom = Math.min(bottom + 1, Math.floor(r.y + r.height) - delta)
      if (shiftedTop >= edgeTop && shiftedBottom <= edgeBottom + 1) continue
      if (shiftedTop >= shiftedBottom) continue
      // Fill law: repair to the surface's own ground (see the fill law).
      buffer.write(Math.floor(x), shiftedTop, groundFillLines(w, shiftedBottom - shiftedTop, boxBackgroundColor))
      buffer.clip({ x1: undefined, x2: undefined, y1: shiftedTop, y2: shiftedBottom })
      composeScrolledChildren(
        content,
        ctx,
        contentX,
        contentY,
        hasRemovedChild,
        undefined,
        shiftedTop - contentY,
        shiftedBottom - contentY,
        boxBackgroundColor,
        true,
      )
      buffer.unclip()
    }
  } else {
    // Full path. Scrolled without a usable hint: prevScreen child positions
    // are stale — clear the viewport and disable blit. NOT scrolled
    // (spinner tick): positions are valid — keep blit so steady children
    // reuse (a full-content rewrite every tick tears over tmux).
    const scrolled = contentCached && contentCached.y !== contentY
    if (scrolled && y1 !== undefined && y2 !== undefined) {
      buffer.clear({
        x: Math.floor(x),
        y: Math.floor(y1),
        width: Math.floor(width),
        height: Math.floor(y2 - y1),
      })
    }
    // The fill law: a bg'd scroll surface resolves its whole viewport
    // to its own ground on the frames that repaint from scratch (first
    // paint, hint-less scroll, geometry change) — the gaps between children
    // would otherwise stay zero cells and read as terminal-ground bands.
    // ONE-BACKDROP: a sampler viewport refills PER ROW on EVERY frame (the
    // fast path is disabled above, so all frames land here) — the field
    // stays screen-fixed while content scrolls through it, and child blits
    // are off so nothing stale lands on the fresh fill.
    if (rowSampler !== undefined && y1 !== undefined && y2 !== undefined && Math.floor(width) >= 1) {
      const vy0 = Math.floor(y1)
      const vy1 = Math.floor(y2)
      for (let r = vy0; r < vy1; r++) {
        buffer.write(Math.floor(x), r, groundFillLines(Math.floor(width), 1, rowSampler(r)))
      }
    } else if (
      boxBackgroundColor &&
      y1 !== undefined &&
      y2 !== undefined &&
      (scrolled || !contentCached) &&
      Math.floor(width) >= 1 &&
      Math.floor(y2 - y1) >= 1
    ) {
      buffer.write(
        Math.floor(x),
        Math.floor(y1),
        groundFillLines(Math.floor(width), Math.floor(y2 - y1), boxBackgroundColor),
      )
    }
    const positionChanged =
      cached !== undefined &&
      (cached.x !== x || cached.y !== y || cached.width !== width || cached.height !== height)
    composeScrolledChildren(
      content,
      ctx,
      contentX,
      contentY,
      hasRemovedChild,
      rowSampler !== undefined || scrolled || positionChanged ? undefined : prevScreen,
      scrollTop,
      scrollTop + innerHeight,
      boxBackgroundColor,
      false,
      rowSampler,
    )
  }
  nodeCache.set(content, {
    x: contentX,
    y: contentY,
    width: contentYoga.getComputedWidth(),
    height: contentYoga.getComputedHeight(),
  })
  content.dirty = false
}

// ── children walks ──────────────────────────────────────────────────────────

/** Plain children: the overflow-contamination rules decide who may blit. */
function composeChildren(
  node: DOMElement,
  ctx: WalkCtx,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  inheritedBackgroundColor: Color | undefined,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let seenDirtyChild = false
  let seenDirtyClipped = false
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    const wasDirty = childElem.dirty
    const isAbsolute = childElem.style.position === 'absolute'
    composeNode(childElem, ctx, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      // A non-opaque absolute sibling OVERLAPPING a dirty clipped child must
      // descend (its rect has transparent gaps of freshly-rewritten cells);
      // opaque descendants still blit their narrower rects.
      skipSelfBlit:
        seenDirtyClipped &&
        isAbsolute &&
        !childElem.style.opaque &&
        childElem.style.backgroundColor === undefined,
      inheritedBackgroundColor,
      inheritedRowBg,
    })
    if (wasDirty && !seenDirtyChild) {
      if (!clipsBothAxes(childElem) || isAbsolute) {
        seenDirtyChild = true
      } else {
        seenDirtyClipped = true
      }
    }
  }
}

function clipsBothAxes(node: DOMElement): boolean {
  const ox = node.style.overflowX ?? node.style.overflow
  const oy = node.style.overflowY ?? node.style.overflow
  return (ox === 'hidden' || ox === 'scroll') && (oy === 'hidden' || oy === 'scroll')
}

/** A yoga-squeezed h=0 node ghosts only when a sibling owns the same row. */
function siblingSharesY(node: DOMElement, layoutNode: LayoutNode): boolean {
  const parent = node.parentNode
  if (!parent) return false
  const myTop = layoutNode.getComputedTop()
  const siblings = parent.childNodes
  const idx = siblings.indexOf(node)
  for (let i = idx + 1; i < siblings.length; i++) {
    const sib = (siblings[i] as DOMElement).layoutNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  for (let i = idx - 1; i >= 0; i--) {
    const sib = (siblings[i] as DOMElement).layoutNode
    if (!sib) continue
    return sib.getComputedTop() === myTop
  }
  return false
}

/** Re-blit absolute descendants painting OUTSIDE a blitting node's rect —
 *  the self-blit doesn't cover them and a dirty sibling may have overwritten
 *  their cells (the floating slash-menu class). */
function blitEscapingAbsoluteDescendants(
  node: DOMElement,
  ctx: WalkCtx,
  prevScreen: Screen,
  px: number,
  py: number,
  pw: number,
  ph: number,
): void {
  const pr = px + pw
  const pb = py + ph
  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const elem = child as DOMElement
    if (elem.style.position === 'absolute') {
      const cached = nodeCache.get(elem)
      if (cached) {
        ctx.signals.absoluteRectsCur.push(cached)
        const cx = Math.floor(cached.x)
        const cy = Math.floor(cached.y)
        const cw = Math.floor(cached.width)
        const ch = Math.floor(cached.height)
        if (cx < px || cy < py || cx + cw > pr || cy + ch > pb) {
          ctx.buffer.blit(prevScreen, cx, cy, cw, ch)
        }
      }
    }
    blitEscapingAbsoluteDescendants(elem, ctx, prevScreen, px, py, pw, ph)
  }
}

/** Scroll-container children with viewport culling. scrollTopY/scrollBottomY
 *  are the visible window in child-local yoga coords. cumHeightShift keeps
 *  the walk O(dirty) for bottom-append (see the stable-row repair). Culled
 *  children usually DROP their subtree cache (a re-entering child must not
 *  clear a position a sibling now owns); the DECSTBM fast path preserves it
 *  (its blit+shift keeps stable rows true, and the walk would be
 *  O(children × depth) every frame otherwise). */
function composeScrolledChildren(
  node: DOMElement,
  ctx: WalkCtx,
  offsetX: number,
  offsetY: number,
  hasRemovedChild: boolean,
  prevScreen: Screen | undefined,
  scrollTopY: number,
  scrollBottomY: number,
  inheritedBackgroundColor: Color | undefined,
  preserveCulledCache = false,
  inheritedRowBg?: (row: number) => Color | undefined,
): void {
  let seenDirtyChild = false
  let cumHeightShift = 0
  for (const childNode of node.childNodes) {
    const childElem = childNode as DOMElement
    const cy = childElem.layoutNode
    if (cy) {
      const cached = nodeCache.get(childElem)
      let top: number
      let height: number
      if (cached?.top !== undefined && !childElem.dirty && cumHeightShift === 0) {
        top = cached.top
        height = cached.height
      } else {
        top = cy.getComputedTop()
        height = cy.getComputedHeight()
        if (childElem.dirty) {
          cumHeightShift += height - (cached ? cached.height : 0)
        }
        // The one refresh point for cached tops on the preserve path — a
        // middle-growth frame otherwise leaves stale tops that misfire.
        if (cached) cached.top = top
      }
      const bottom = top + height
      if (bottom <= scrollTopY || top >= scrollBottomY) {
        if (!preserveCulledCache) dropSubtreeCache(childElem)
        continue
      }
    }
    const wasDirty = childElem.dirty
    composeNode(childElem, ctx, {
      offsetX,
      offsetY,
      prevScreen: hasRemovedChild || seenDirtyChild ? undefined : prevScreen,
      inheritedBackgroundColor,
      inheritedRowBg,
    })
    if (wasDirty) seenDirtyChild = true
  }
}

function dropSubtreeCache(node: DOMElement): void {
  nodeCache.delete(node)
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      dropSubtreeCache(child as DOMElement)
    }
  }
}

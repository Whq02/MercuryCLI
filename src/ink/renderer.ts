// The composition root: one renderer per root node, invoked once per frame
// with the front/back frames and the terminal geometry, returning the
// composed frame plus the walk's signals record.

import { appendFileSync } from 'node:fs'
import { charInCellAt, type Screen, type StylePool } from './cell-grid.js'
import ComposeBuffer, { lastComposeCounts } from './compose-buffer.js'
import composeTree, {
  ComposeSignals,
  expandDamageForAbsoluteRects,
} from './compose-walk.js'
import { markDirty, type DOMElement } from './dom.js'
import { emptyFrame, type Frame } from './frame.js'
import type { Rectangle } from './layout/geometry.js'
import { consumeAbsoluteRemovedFlag } from './node-cache.js'
import { applyRecessPass } from './recessLayer.js'
import { logForDebugging } from '../utils/debug.js'

export type RenderOptions = {
  /** What the terminal currently displays. */
  frontFrame: Frame
  /** The buffer to reuse for this frame's screen. */
  backFrame: Frame
  isTTY: boolean
  terminalWidth: number
  terminalRows: number
  altScreen: boolean
  /** The previous frame's screen cannot be trusted for blitting. */
  prevFrameContaminated: boolean
  /** The writer will emit DECSTBM region scrolls for full-width scroll hints
   *  this frame (compose-walk's damage-excluded shift composes only under
   *  that promise — see WalkCtx.regionScrollUsable). Omitted ⇒ false. */
  regionScrollUsable?: boolean
}

export type RenderResult = {
  frame: Frame
  signals: ComposeSignals
}

export type Renderer = (options: RenderOptions) => RenderResult

// Composed-frame forensics: one JSON line per alternate-screen frame when
// the tee variable names a file. Failures are swallowed — forensics must
// never break rendering.
const COMPOSED_TEE = process.env.INK_COMPOSED_TEE
let teeFrameNumber = 0

function teeComposedFrame(screen: Screen, signals: ComposeSignals): void {
  if (!COMPOSED_TEE) return
  try {
    const rows: string[] = []
    for (let y = 0; y < screen.height; y++) {
      let text = ''
      for (let x = 0; x < screen.width; x++) {
        text += charInCellAt(screen, x, y) ?? ' '
      }
      rows.push(text.trimEnd())
    }
    const record = {
      f: ++teeFrameNumber,
      ts: Date.now(),
      damage: screen.damage ?? null,
      counts: { ...lastComposeCounts },
      shiftReason: signals.shiftReason,
      rows,
    }
    appendFileSync(COMPOSED_TEE, `${JSON.stringify(record)}\n`)
  } catch {
    // Swallowed by design.
  }
}

export default function createRenderer(
  rootNode: DOMElement,
  stylePool: StylePool,
): Renderer {
  let buffer: ComposeBuffer | null = null
  let prevAbsoluteRects: readonly Rectangle[] = []

  return function render(options: RenderOptions): RenderResult {
    const {
      frontFrame,
      backFrame,
      isTTY,
      terminalWidth,
      terminalRows,
      altScreen,
      prevFrameContaminated,
    } = options

    // 1. Pools come from the BACK buffer's screen every frame — the frame
    //    loop can replace them generationally.
    const charPool = backFrame.screen.charPool
    const hyperlinkPool = backFrame.screen.hyperlinkPool

    // 2. Invalid layout guard — never throws.
    const layout = rootNode.layoutNode
    const invalidFrame = (): RenderResult => ({
      frame: emptyFrame(terminalRows, terminalWidth, stylePool, charPool, hyperlinkPool),
      signals: new ComposeSignals(),
    })
    if (!layout) return invalidFrame()
    const computedWidth = layout.getComputedWidth()
    const computedHeight = layout.getComputedHeight()
    if (
      computedWidth === undefined ||
      computedHeight === undefined ||
      !Number.isFinite(computedWidth) ||
      !Number.isFinite(computedHeight) ||
      computedWidth < 0 ||
      computedHeight < 0
    ) {
      logForDebugging(
        `renderer: invalid root layout width=${computedWidth} height=${computedHeight} children=${rootNode.childNodes.length} terminal=${terminalWidth}x${terminalRows}`,
      )
      return invalidFrame()
    }

    // 3. Geometry: alternate-screen height is EXACTLY the terminal rows.
    const width = Math.floor(computedWidth)
    let height = Math.floor(computedHeight)
    if (altScreen) {
      if (height > terminalRows) {
        logForDebugging(
          `renderer: alternate-screen content is ${height} rows for a ${terminalRows}-row terminal — something is rendering outside the alternate-screen wrapper; clipping`,
          { level: 'warn' },
        )
      }
      height = terminalRows
    }

    // 4. The compose buffer persists across frames.
    if (buffer) {
      buffer.reset(width, height, backFrame.screen)
    } else {
      buffer = new ComposeBuffer({
        width,
        height,
        stylePool,
        screen: backFrame.screen,
      })
    }

    // 5. The absolute-removal flag is CONSUMED on every frame reaching here.
    const absoluteRemoved = consumeAbsoluteRemovedFlag(rootNode)
    const prevScreen =
      prevFrameContaminated || absoluteRemoved ? undefined : frontFrame.screen

    // 6. The walk, then the flush.
    const signals = new ComposeSignals()
    composeTree(rootNode, buffer, {
      prevScreen,
      signals,
      prevAbsoluteRects,
      regionScrollUsable: options.regionScrollUsable === true,
    })
    const renderedScreen = buffer.get()

    // 7. Alternate screen only: overlay ghost bands join the damage and the
    //    recession pass restyles cells outside a committed elevated surface.
    if (options.altScreen) {
      expandDamageForAbsoluteRects(renderedScreen, prevAbsoluteRects, signals.absoluteRectsCur)
      applyRecessPass(renderedScreen, stylePool)
    }
    prevAbsoluteRects = signals.absoluteRectsCur

    // 8. An undrained scroll node is re-dirtied AFTER the walk so the next
    //    frame descends into it and keeps draining.
    if (signals.scrollDrainNode) markDirty(signals.scrollDrainNode)

    if (altScreen) teeComposedFrame(renderedScreen, signals)

    // 9. The frame record.
    const cursorRow = altScreen
      ? Math.max(0, Math.min(renderedScreen.height, terminalRows) - 1)
      : renderedScreen.height
    const frame: Frame = {
      screen: renderedScreen,
      viewport: {
        width: terminalWidth,
        height: altScreen ? terminalRows + 1 : terminalRows,
      },
      cursor: {
        x: 0,
        y: cursorRow,
        visible: !isTTY || renderedScreen.height === 0,
      },
      scrollHint: altScreen ? signals.scrollHint : null,
      scrollDrainPending: signals.scrollDrainNode !== null,
    }
    return { frame, signals }
  }
}

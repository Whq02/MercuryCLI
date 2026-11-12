
import { appendFileSync } from 'node:fs'
import {
  blitRegion,
  CellWidth,
  cellAt,
  charInCellAt,
  clearRegion,
  createScreen,
  migrateScreenPools,
  type Screen,
  type StylePool,
} from './cell-grid.js'
import ComposeBuffer, { lastComposeCounts } from './compose-buffer.js'
import composeTree, {
  ComposeSignals,
  expandDamageForAbsoluteRects,
} from './compose-walk.js'
import { markDirty, type DOMElement } from './dom.js'
import type { Frame } from './frame.js'
import type { Rectangle } from './layout/geometry.js'
import { consumeAbsoluteRemovedFlag } from './node-cache.js'
import { applyRecessPass } from './recessLayer.js'
import { logForDebugging } from '../utils/debug.js'

type RenderOptions = {
  frontFrame: Frame
  backFrame: Frame
  isTTY: boolean
  terminalWidth: number
  terminalRows: number
  altScreen: boolean
  prevFrameContaminated: boolean
  regionScrollUsable?: boolean
}

export type RenderResult = {
  frame: Frame
  signals: ComposeSignals
}

export type Renderer = (options: RenderOptions) => RenderResult

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

    const charPool = backFrame.screen.charPool
    const hyperlinkPool = backFrame.screen.hyperlinkPool

    const layout = rootNode.layoutNode
    const invalidFrame = (): RenderResult => {
      const height = altScreen ? terminalRows : frontFrame.screen.height
      const screen = createScreen(
        terminalWidth,
        height,
        stylePool,
        frontFrame.screen.charPool,
        frontFrame.screen.hyperlinkPool,
      )
      const copyWidth = Math.min(screen.width, frontFrame.screen.width)
      const copyHeight = Math.min(screen.height, frontFrame.screen.height)
      if (copyWidth > 0 && copyHeight > 0) {
        blitRegion(screen, frontFrame.screen, 0, 0, copyWidth, copyHeight)
        if (screen.width < frontFrame.screen.width) {
          for (let y = 0; y < copyHeight; y++) {
            if (cellAt(screen, screen.width - 1, y)?.width === CellWidth.Wide) {
              clearRegion(screen, screen.width - 1, y, 1, 1)
            }
          }
        }
        screen.damage = undefined
      }
      migrateScreenPools(screen, charPool, hyperlinkPool)
      const cursorRow = altScreen
        ? Math.max(0, Math.min(screen.height, terminalRows) - 1)
        : screen.height
      return {
        frame: {
          screen,
          viewport: { width: terminalWidth, height: terminalRows },
          cursor: {
            x: 0,
            y: cursorRow,
            visible: !isTTY || screen.height === 0,
          },
          scrollHint: null,
          scrollDrainPending: false,
        },
        signals: new ComposeSignals(),
      }
    }
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

    const absoluteRemoved = consumeAbsoluteRemovedFlag(rootNode)
    const prevScreen =
      prevFrameContaminated || absoluteRemoved ? undefined : frontFrame.screen

    const signals = new ComposeSignals()
    composeTree(rootNode, buffer, {
      prevScreen,
      signals,
      prevAbsoluteRects,
      regionScrollUsable: options.regionScrollUsable === true,
    })
    const renderedScreen = buffer.get()

    if (options.altScreen) {
      expandDamageForAbsoluteRects(renderedScreen, prevAbsoluteRects, signals.absoluteRectsCur)
      applyRecessPass(renderedScreen, stylePool)
    }
    prevAbsoluteRects = signals.absoluteRectsCur

    if (signals.scrollDrainNode) markDirty(signals.scrollDrainNode)

    if (altScreen) teeComposedFrame(renderedScreen, signals)

    const cursorRow = altScreen
      ? Math.max(0, Math.min(renderedScreen.height, terminalRows) - 1)
      : renderedScreen.height
    const frame: Frame = {
      screen: renderedScreen,
      viewport: {
        width: terminalWidth,
        height: terminalRows,
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

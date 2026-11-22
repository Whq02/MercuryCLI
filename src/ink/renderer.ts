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
  type AbsoluteEntry,
  ComposeSignals,
  expandDamageForAbsoluteRects,
  invalidOverlayRects,
} from './compose-walk.js'
import { markDirty, type DOMElement } from './dom.js'
import type { Frame } from './frame.js'
import type { Rectangle } from './layout/geometry.js'
import { consumeAbsoluteRemovedFlag } from './node-cache.js'
import { applyRecessPass } from './recessLayer.js'
import { logForDebugging } from '../utils/debug.js'
import { passedOver } from '../utils/passedOver.js'
import { hostEnv } from '../utils/hostEnv.js'

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

const COMPOSED_TEE = hostEnv().INK_COMPOSED_TEE
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
  } catch (error) {
    passedOver(error)
  }
}

function isCellCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function frameOf(screen: Screen, options: RenderOptions, scrollHint: ComposeSignals['scrollHint'], scrollDrainPending: boolean): Frame {
  return {
    screen,
    viewport: { width: options.terminalWidth, height: options.terminalRows },
    cursor: {
      x: 0,
      y: options.altScreen ? Math.max(0, Math.min(screen.height, options.terminalRows) - 1) : screen.height,
      visible: !options.isTTY || screen.height === 0,
    },
    scrollHint,
    scrollDrainPending,
  }
}

function heldFrame(options: RenderOptions, stylePool: StylePool): RenderResult {
  const front = options.frontFrame.screen
  const back = options.backFrame.screen
  const screen = createScreen(options.terminalWidth, options.altScreen ? options.terminalRows : front.height, stylePool, front.charPool, front.hyperlinkPool)
  const width = Math.min(screen.width, front.width)
  const height = Math.min(screen.height, front.height)
  blitRegion(screen, front, 0, 0, width, height)
  if (screen.width < front.width) {
    for (let row = 0; row < height; row++) {
      if (cellAt(screen, width - 1, row)?.width === CellWidth.Wide) clearRegion(screen, width - 1, row, 1, 1)
    }
  }
  screen.damage = undefined
  migrateScreenPools(screen, back.charPool, back.hyperlinkPool)
  return { frame: frameOf(screen, options, null, false), signals: new ComposeSignals() }
}

export default function createRenderer(
  rootNode: DOMElement,
  stylePool: StylePool,
): Renderer {
  let buffer: ComposeBuffer | undefined
  let lastAbsoluteRects: readonly Rectangle[] = []
  let lastAbsoluteEntries: readonly AbsoluteEntry[] = []
  let lastOverpaintRects: readonly Rectangle[] = []

  return options => {
    const layoutNode = rootNode.layoutNode
    const computedWidth = layoutNode?.getComputedWidth()
    const computedHeight = layoutNode?.getComputedHeight()
    if (!layoutNode || !isCellCount(computedWidth) || !isCellCount(computedHeight)) {
      if (layoutNode) {
        logForDebugging(
          `renderer: invalid root layout width=${computedWidth} height=${computedHeight} children=${rootNode.childNodes.length} terminal=${options.terminalWidth}x${options.terminalRows}`,
        )
      }
      return heldFrame(options, stylePool)
    }

    const width = Math.floor(computedWidth)
    const contentHeight = Math.floor(computedHeight)
    if (options.altScreen && contentHeight > options.terminalRows) {
      logForDebugging(
        `renderer: alternate-screen content is ${contentHeight} rows for a ${options.terminalRows}-row terminal — something is rendering outside the alternate-screen wrapper; clipping`,
        { level: 'warn' },
      )
    }
    const height = options.altScreen ? options.terminalRows : contentHeight
    if (buffer) buffer.reset(width, height, options.backFrame.screen)
    else buffer = new ComposeBuffer({ width, height, stylePool, screen: options.backFrame.screen })

    const absoluteRemoved = consumeAbsoluteRemovedFlag(rootNode)
    const invalidRects = options.prevFrameContaminated ? [] : invalidOverlayRects(rootNode, lastAbsoluteEntries)
    const reusable = !options.prevFrameContaminated && !(absoluteRemoved && invalidRects.length === 0)
    const signals = new ComposeSignals()
    composeTree(rootNode, buffer, {
      prevScreen: reusable ? options.frontFrame.screen : undefined,
      signals,
      prevAbsoluteRects: lastOverpaintRects,
      invalidRects,
      regionScrollUsable: options.regionScrollUsable === true,
    })
    const screen = buffer.get()
    if (options.altScreen) {
      expandDamageForAbsoluteRects(screen, lastAbsoluteRects, signals.absoluteRectsCur)
      applyRecessPass(screen, stylePool)
    }
    lastAbsoluteRects = signals.absoluteRectsCur
    lastAbsoluteEntries = signals.absoluteEntriesCur
    lastOverpaintRects = [...signals.absoluteRectsCur, ...signals.reachRectsCur]
    if (signals.scrollDrainNode) markDirty(signals.scrollDrainNode)
    if (options.altScreen) teeComposedFrame(screen, signals)
    return {
      frame: frameOf(screen, options, options.altScreen ? signals.scrollHint : null, signals.scrollDrainNode !== null),
      signals,
    }
  }
}

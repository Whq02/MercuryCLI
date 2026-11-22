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
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type RenderOptions = Unbuilt

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

export default function createRenderer(
  rootNode: DOMElement,
  stylePool: StylePool,
): Renderer {
  return notBuilt('src/ink/renderer.ts:76')
}

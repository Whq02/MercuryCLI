import { appendFileSync } from 'node:fs'
import { type Screen, charInCellAt } from '../cell-grid.js'
import type { DOMElement } from '../dom.js'
import type { Frame, Patch } from '../frame.js'
import type ScreenInstance from '../screenInstance.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export const TREE_DUMP_PATH = hostEnv().INK_TREE_DUMP

export const COMPOSED_TEE_PATH = hostEnv().INK_COMPOSED_TEE

export const COMMIT_TEE_PATH = hostEnv().INK_COMMIT_TEE

export const WRITE_TEE_PATH = hostEnv().INK_WRITE_TEE

const WRITE_TEE_PROBE = hostEnv().INK_TEE_PROBE

export const TREE_DUMP_BUDGET = 24

const TREE_DUMP_MAX_DEPTH = 16

const TREE_DUMP_NODE_BUDGET = 700

export function safeAppend(path: string, line: string): void {
  try {
    appendFileSync(path, line)
  } catch (error) {
    passedOver(error)
  }
}

export function teeCommitGeometry(this: Pick<ScreenInstance, 'rootNode'>, layoutMs: number): void {
  try {
    const rectOf = (node: DOMElement) => {
      const l = node.layoutNode
      return l
        ? {
            x: l.getComputedLeft(),
            y: l.getComputedTop(),
            w: l.getComputedWidth(),
            h: l.getComputedHeight(),
          }
        : null
    }
    const elements = (node: DOMElement): DOMElement[] =>
      node.childNodes.filter((c): c is DOMElement => c.nodeName !== '#text')
    let rowNode: DOMElement | null = null
    const find = (node: DOMElement, depth: number): void => {
      if (rowNode || depth > 12) return
      if (
        node.style.flexDirection === 'row' &&
        elements(node).some(c => typeof c.style.width === 'number')
      ) {
        rowNode = node
        return
      }
      for (const child of elements(node)) find(child, depth + 1)
    }
    find(this.rootNode, 0)
    let record: Record<string, unknown> = { phase: 'commit', at: Date.now(), layoutMs }
    if (rowNode) {
      const row = rowNode as DOMElement
      const children = elements(row)
      const flexible = children.find(c => typeof c.style.width !== 'number')
      let scroll: DOMElement | null = null
      const findScroll = (node: DOMElement, depth: number): void => {
        if (scroll || depth > 12) return
        if (node.scroll?.scrollHeight !== undefined) {
          scroll = node
          return
        }
        for (const child of elements(node)) findScroll(child, depth + 1)
      }
      if (flexible) findScroll(flexible, 0)
      const scrollNode = scroll as DOMElement | null
      record = {
        ...record,
        row: children.map(rectOf),
        slot: flexible ? elements(flexible).map(rectOf) : [],
        scroll: scrollNode
          ? {
              top: scrollNode.scroll?.scrollTop,
              height: scrollNode.scroll?.scrollHeight,
              viewport: scrollNode.scroll?.scrollViewportHeight,
            }
          : null,
      }
    }
    safeAppend(COMMIT_TEE_PATH!, `${JSON.stringify(record)}\n`)
  } catch (error) {
    passedOver(error)
  }
}

function rowText(screen: Screen, y: number): string {
  let text = ''
  for (let x = 0; x < screen.width; x++) text += charInCellAt(screen, x, y) ?? ' '
  return text
}

export function teeBeforeDiff(base: Frame, next: Frame): void {
  if (!WRITE_TEE_PATH) return
  try {
    const probe = WRITE_TEE_PROBE ?? ''
    const rows = new Set<number>()
    let differing = 0
    const height = Math.max(base.screen.height, next.screen.height)
    const width = Math.max(base.screen.width, next.screen.width)
    let probeInBase = false
    let probeInNext = false
    for (let y = 0; y < height; y++) {
      const a = y < base.screen.height ? rowText(base.screen, y) : ''
      const b = y < next.screen.height ? rowText(next.screen, y) : ''
      if (probe && a.includes(probe)) probeInBase = true
      if (probe && b.includes(probe)) probeInNext = true
      for (let x = 0; x < width; x++) {
        if ((a[x] ?? ' ') !== (b[x] ?? ' ')) {
          differing++
          rows.add(y)
        }
      }
    }
    safeAppend(
      WRITE_TEE_PATH,
      `${JSON.stringify({
        phase: 'before-diff',
        sameScreen: base.screen === next.screen,
        sharedCharPool: base.screen.charPool === next.screen.charPool,
        probeInBase,
        probeInNext,
        differingCells: differing,
        differingRows: [...rows].sort((p, q) => p - q),
        baseDamage: base.screen.damage ?? null,
        nextDamage: next.screen.damage ?? null,
      })}\n`,
    )
  } catch (error) {
    passedOver(error)
  }
}

export function teeAfterDiff(patches: Patch[]): void {
  if (!WRITE_TEE_PATH) return
  try {
    const probe = WRITE_TEE_PROBE ?? ''
    let serialized = ''
    const kinds = new Set<string>()
    for (const patch of patches) {
      kinds.add(patch.type)
      if (patch.type === 'stdout') serialized += patch.content
      else if (patch.type === 'styleStr') serialized += patch.str
    }
    safeAppend(
      WRITE_TEE_PATH,
      `${JSON.stringify({
        phase: 'after-diff',
        patches: patches.length,
        bytes: serialized.length,
        probeInOutput: probe ? serialized.includes(probe) : false,
        kinds: [...kinds],
      })}\n`,
    )
  } catch (error) {
    passedOver(error)
  }
}

export function dumpTree(this: Pick<ScreenInstance, 'rootNode' | 'treeDumpBudget'>, reason: string | null): void {
  if (!TREE_DUMP_PATH || this.treeDumpBudget <= 0) return
  this.treeDumpBudget--
  try {
    const lines: string[] = [`--- tree dump (${reason ?? 'layout shift'}) ---`]
    let budget = TREE_DUMP_NODE_BUDGET
    const STYLE_KEYS = [
      'width',
      'minWidth',
      'maxWidth',
      'flexGrow',
      'flexShrink',
      'flexBasis',
      'flexDirection',
      'position',
      'overflow',
      'overflowX',
      'display',
      'alignItems',
      'alignSelf',
    ] as const
    const visit = (node: DOMElement, depth: number): void => {
      if (budget-- <= 0 || depth > TREE_DUMP_MAX_DEPTH) return
      const indent = '  '.repeat(depth)
      const layout = node.layoutNode
      const geometry = layout
        ? `${layout.getComputedLeft()},${layout.getComputedTop()} ${layout.getComputedWidth()}x${layout.getComputedHeight()}`
        : 'no-layout'
      const style = STYLE_KEYS.filter(key => node.style[key] !== undefined)
        .map(key => `${key}=${String(node.style[key])}`)
        .join(' ')
      const owners = (node.debugOwnerChain ?? []).slice(0, 4).join('>')
      lines.push(`${indent}${node.nodeName} [${geometry}] ${style} ${owners}`.trimEnd())
      for (const child of node.childNodes) {
        if (child.nodeName === '#text') {
          lines.push(
            `${indent}  #text ${JSON.stringify(child.nodeValue.slice(0, 28))}`,
          )
        } else {
          visit(child, depth + 1)
        }
      }
    }
    visit(this.rootNode, 0)
    safeAppend(COMPOSED_TEE_PATH ?? TREE_DUMP_PATH, `${lines.join('\n')}\n`)
  } catch (error) {
    passedOver(error)
  }
}

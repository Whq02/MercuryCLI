// ============================================================================
//  scripts/ink-runtime/frameHarness.ts — the shared
//  frame-composition harness.
//
//  Builds real DOM scenes through the production tree API (createNode /
//  createTextNode / setStyle + applyStyles — the reconciler's dual
//  application), lays them out through the production layout engine, and
//  composes them through the production renderer. Box nodes mirror the
//  public Box component's injected web defaults (a raw ink-box is not a
//  production-reachable tree). Used by the frame goldens (B1) and the
//  replay/inline oracles (B4).
// ============================================================================
import {
  appendChildNode,
  createNode,
  createTextNode,
  setStyle,
  type DOMElement,
} from '../../src/ink/dom.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import createRenderer from '../../src/ink/renderer.js'
import {
  CharPool,
  charInCellAt,
  HyperlinkPool,
  type Screen,
  StylePool,
} from '../../src/ink/cell-grid.js'
import applyStyles, { type Styles } from '../../src/ink/styles.js'

export type SceneNode = {
  kind: 'box' | 'text'
  style?: Styles
  text?: string
  children?: SceneNode[]
}

export type FrameScene = {
  name: string
  cols: number
  rows: number
  root: SceneNode
}

// Mirrors the reconciler's dual application: setStyle for composition,
// applyStyles for the layout node.
export function applySceneStyle(el: DOMElement, style: Styles): void {
  setStyle(el, style)
  if (el.layoutNode) applyStyles(el.layoutNode, style)
}

export function buildDom(spec: SceneNode): DOMElement {
  if (spec.kind === 'text') {
    const el = createNode('ink-text')
    if (spec.style) applySceneStyle(el, spec.style)
    if (spec.text !== undefined) appendChildNode(el, createTextNode(spec.text) as never)
    spec.children?.forEach(c => appendChildNode(el, buildDom(c)))
    return el
  }
  const el = createNode('ink-box')
  // Mirror the public Box component's injected defaults (Box.tsx): a raw
  // ink-box without them is NOT a production-reachable tree (the engine's
  // own default flexShrink is 0, Yoga-classic semantics).
  applySceneStyle(el, {
    flexDirection: 'row',
    flexGrow: 0,
    flexShrink: 1,
    ...spec.style,
  })
  spec.children?.forEach(c => appendChildNode(el, buildDom(c)))
  return el
}

export function screenLines(screen: Screen): string[] {
  const lines: string[] = []
  for (let y = 0; y < screen.height; y++) {
    let line = ''
    for (let x = 0; x < screen.width; x++) {
      line += charInCellAt(screen, x, y) || ' '
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines
}

export type ComposeContext = {
  stylePool: StylePool
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
}

export function makeContext(): ComposeContext {
  return {
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
  }
}

/** Compose a scene into a Frame through the production pipeline. Pass the
 *  previous frame to exercise the blit fast path (prevFrameContaminated
 *  false), or omit it for a fresh contaminated compose. Inline (main-screen)
 *  scenes pass altScreen: false and a viewportRows smaller than the content
 *  — the root is content-sized (no height clamp), like the live REPL. */
export function composeScene(
  scene: FrameScene,
  ctx: ComposeContext,
  prevFrame?: Frame,
  opts?: { altScreen?: boolean; viewportRows?: number; contentHeight?: boolean },
): Frame {
  const altScreen = opts?.altScreen ?? true
  const viewportRows = opts?.viewportRows ?? scene.rows
  const root = createNode('ink-root')
  applySceneStyle(root, {
    width: scene.cols,
    ...(opts?.contentHeight ? {} : { height: scene.rows }),
    flexDirection: 'column',
  })
  appendChildNode(root, buildDom(scene.root))
  root.layoutNode!.calculateLayout(scene.cols, scene.rows)

  const front =
    prevFrame ??
    emptyFrame(viewportRows, scene.cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const back = emptyFrame(
    viewportRows,
    scene.cols,
    ctx.stylePool,
    ctx.charPool,
    ctx.hyperlinkPool,
  )
  const render = createRenderer(root, ctx.stylePool)
  return render({
    frontFrame: front,
    backFrame: back,
    isTTY: true,
    terminalWidth: scene.cols,
    terminalRows: viewportRows,
    altScreen,
    prevFrameContaminated: prevFrame === undefined,
  }).frame
}

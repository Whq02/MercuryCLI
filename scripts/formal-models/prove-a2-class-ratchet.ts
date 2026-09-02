#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-a2-class-ratchet.ts — the mechanical
//  class-root ratchet for PERCENT-VS-BORDER-BOX FRAME BREAK-OUT (A2).
//
//  THE RATIFIED ENGINE LAW (src/ink/layout/cellLayout.ts): percent dimensions
//  resolve against the owner's BORDER-BOX. Therefore a `width="100%"` DIRECT
//  child inside a bordered or padded Box lays out wider than the content
//  area — wrap/truncate budgets cross the frame and copy paints through the
//  padding onto the border (the ledger's A2 class, 3 fixed / 4 filed at the
//  tips fold).
//
//  This ratchet makes the class MECHANICAL: an AST scan (never a regex over
//  JSX) of every Box in src/components + src/ink with borderStyle or
//  padding, whose DIRECT JSX child carries width="100%". Instances live in
//  the typed baseline below with their ratified reasons; a NEW instance is
//  RED (give the child a content-box context: an explicit content-width
//  interior Box — the WorkCapsule pattern — or drop the percent for default
//  cross-axis stretch); a CURED baseline row is RED until pruned (the
//  law at ratchet scale).
//
//  The cockpit center column's rewrap pass closed AS ALREADY-SAFE at the
//  current tree: its direct children are explicitly sized against the
//  border-inner width the size context carries;
//  this ratchet is what keeps that true.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const SCAN_DIRS = ['src/components', 'src/ink']

/** Accepted instances (file · parent Box line-ANCHOR text · reason). Line
 *  numbers drift; the anchor is the parent's opening-attribute snippet. */
const BASELINE: Array<{ file: string; childLine: number; reason: string }> = [
  // (empty at ratification — the scan below determines the live set; rows
  // added here must carry the ledger's ratified reasons.)
]

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (p.endsWith('.tsx')) yield p
  }
}

interface Hit {
  file: string
  parentLine: number
  childLine: number
}

const PAD_ATTRS = new Set(['padding', 'paddingX', 'paddingY', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'])

function attrNames(el: ts.JsxOpeningLikeElement): Set<string> {
  const names = new Set<string>()
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name)) names.add(a.name.text)
  }
  return names
}
function hasPercentWidth(el: ts.JsxOpeningLikeElement): boolean {
  for (const a of el.attributes.properties) {
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name) || a.name.text !== 'width') continue
    const init = a.initializer
    if (init && ts.isStringLiteral(init) && init.text === '100%') return true
    if (
      init &&
      ts.isJsxExpression(init) &&
      init.expression &&
      ts.isStringLiteral(init.expression) &&
      init.expression.text === '100%'
    ) {
      return true
    }
  }
  return false
}
function tagName(el: ts.JsxOpeningLikeElement): string {
  return ts.isIdentifier(el.tagName) ? el.tagName.text : el.tagName.getText()
}

const hits: Hit[] = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('100%')) continue
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node)) {
        const open = node.openingElement
        if (tagName(open) === 'Box') {
          const names = attrNames(open)
          const framed = names.has('borderStyle') || [...names].some(n => PAD_ATTRS.has(n))
          if (framed) {
            for (const child of node.children) {
              let childOpen: ts.JsxOpeningLikeElement | null = null
              if (ts.isJsxElement(child)) childOpen = child.openingElement
              else if (ts.isJsxSelfClosingElement(child)) childOpen = child
              if (childOpen && hasPercentWidth(childOpen)) {
                hits.push({
                  file: file.slice(ROOT.length + 1),
                  parentLine: sf.getLineAndCharacterOfPosition(open.getStart()).line + 1,
                  childLine: sf.getLineAndCharacterOfPosition(childOpen.getStart()).line + 1,
                })
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

console.log('============================================================')
console.log(' A2 class-root ratchet — percent children of bordered/padded frames')
console.log('============================================================')
const baselineKeys = new Set(BASELINE.map(b => `${b.file}:${b.childLine}`))
const fresh = hits.filter(h => !baselineKeys.has(`${h.file}:${h.childLine}`))
const cured = BASELINE.filter(b => !hits.some(h => h.file === b.file && h.childLine === b.childLine))
check(
  `no NEW percent-vs-border-box instance (scanned ${SCAN_DIRS.join(' + ')}; ${hits.length} known)`,
  fresh.length === 0,
  fresh.map(h => `${h.file}:${h.childLine} (frame at :${h.parentLine})`).join(' · '),
)
check(
  'no CURED baseline row lingers (prune it — the CA-10 law)',
  cured.length === 0,
  cured.map(c => `${c.file}:${c.childLine}`).join(' · '),
)

console.log(failures === 0 ? '\nprove-a2-class-ratchet: green' : `\nprove-a2-class-ratchet: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

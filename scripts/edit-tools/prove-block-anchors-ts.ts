#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-block-anchors-ts.ts — syntactic block anchors
//  for the patch dialect (spec 02 c.6.5):
//    B. replace-block / insert-after-block resolve the OUTERMOST node
//       opening at the line (export modifiers included) and land through
//       the real tool
//    S. a single-line node redirects to explicit-line ops
//    N. a closing line / blank line refuses (no node opens there)
//    L. a non-TS file gets the typed use-explicit-ranges refusal
//    P. a file with parse errors refuses — never a guess over a broken tree
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-block-anchors-ts.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'block-anchor-home-'))
process.env.CLAUDE_CODE_SIMPLE = '1'
process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
process.env.MERCURY_ANCHOR_PATCH = '1'
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'block-anchor-cs-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { resolveBlockAt } = await import('../../src/services/changeTransaction/blockAnchors.ts')
const { ChangeSetTool } = await import('../../src/tools/ChangeSetTool/ChangeSetTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { mintFileAnchor } = await import('../../src/services/changeTransaction/snapshotAnchor.ts')
const { countLines } = await import('../../src/services/changeTransaction/hunks.ts')
const { fileGeneration, recordSeenLines } = await import(
  '../../src/services/changeTransaction/seenLines.ts'
)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'block-anchor-fix-')))
const owner = processMainOwner()

function makeContext() {
  const readFileState = new Map<string, unknown>()
  const empty = getEmptyToolPermissionContext()
  const permCtx = {
    ...empty,
    additionalWorkingDirectories: new Map([[fixtures, { source: 'session' }]]),
  }
  return {
    owner,
    readFileState,
    userModified: false,
    updateFileHistoryState: () => {},
    dynamicSkillDirTriggers: new Set<string>(),
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: permCtx }),
  } as never as { readFileState: Map<string, { content: string; timestamp: number }> }
}
type Ctx = ReturnType<typeof makeContext>
function primeRead(ctx: Ctx, p: string): void {
  const content = readFileSync(p, 'utf8').replaceAll('\r\n', '\n')
  ctx.readFileState.set(p, { content, timestamp: Date.now() + 60_000 } as never)
  const generation = fileGeneration(p)
  if (generation !== null) recordSeenLines(owner, p, generation, 1, Math.max(1, countLines(content)))
}
async function callTool(input: Record<string, unknown>, ctx: Ctx) {
  const result = await (ChangeSetTool as { call: Function }).call(input, ctx, null, {
    uuid: '00000000-0000-0000-0000-0000000ba001',
    message: { id: 'msg_fixture' },
  })
  return result as { data: { outcome: string; result: string } }
}

const TS_SOURCE = [
  'const single = 1', //                       1  single-line node
  '', //                                       2  blank
  'export function alpha(): number {', //      3  block opens (with modifier)
  '  const inner = 2', //                      4
  '  return inner', //                         5
  '}', //                                      6  closing line
  '', //                                       7
  'export class Beta {', //                    8
  '  method(): void {', //                     9  nested block opens
  '    // body', //                           10
  '  }', //                                   11
  '}', //                                     12
  '',
].join('\n')

console.log('— resolveBlockAt (pure) —')
{
  const p = join(fixtures, 'blocks.ts')
  writeFileSync(p, TS_SOURCE)
  const alpha = resolveBlockAt(p, TS_SOURCE, 3)
  check('function block resolves 3-6 (export modifier included)', alpha.ok && alpha.startLine === 3 && alpha.endLine === 6, JSON.stringify(alpha))
  const beta = resolveBlockAt(p, TS_SOURCE, 8)
  check('class block resolves 8-12', beta.ok && beta.startLine === 8 && beta.endLine === 12, JSON.stringify(beta))
  const nested = resolveBlockAt(p, TS_SOURCE, 9)
  check('a line opening only a NESTED node resolves that node (9-11)', nested.ok && nested.startLine === 9 && nested.endLine === 11, JSON.stringify(nested))
  const single = resolveBlockAt(p, TS_SOURCE, 1)
  check('single-line node redirects', !single.ok && single.code === 'single-line', JSON.stringify(single))
  const closing = resolveBlockAt(p, TS_SOURCE, 6)
  check('closing line refuses (no node opens)', !closing.ok && closing.code === 'no-block', JSON.stringify(closing))
  const blank = resolveBlockAt(p, TS_SOURCE, 2)
  check('blank line refuses', !blank.ok && blank.code === 'no-block')
  const nonTs = resolveBlockAt(join(fixtures, 'notes.md'), '# heading\n\nbody\n', 1)
  check('non-TS file refuses with use-explicit-ranges', !nonTs.ok && nonTs.code === 'unsupported-language' && /explicit line ranges/.test(nonTs.reason), JSON.stringify(nonTs))
  const broken = resolveBlockAt(p, 'function broken( {', 1)
  check('parse errors refuse — never a guess over a broken tree', !broken.ok && broken.code === 'parse-error', JSON.stringify(broken))
}

console.log('— through the real tool —')
{
  const p = join(fixtures, 'live.ts')
  writeFileSync(p, TS_SOURCE)
  const ctx = makeContext()
  primeRead(ctx, p)
  const anchor = mintFileAnchor(TS_SOURCE)
  const patch = [
    `file ${p} ${anchor}`,
    'replace-block 3',
    '| export function alpha(): number {',
    '|   return 99',
    '| }',
    'insert-after-block 8',
    '| export const AFTER_BETA = true',
  ].join('\n')
  const r = await callTool({ op: 'apply', patch }, ctx)
  check('block patch applied', r.data.outcome === 'succeeded', r.data.result.slice(0, 260))
  const after = readFileSync(p, 'utf8')
  check('replace-block rewrote the whole function', after.includes('export function alpha(): number {\n  return 99\n}') && !after.includes('const inner'), JSON.stringify(after.slice(0, 200)))
  check('insert-after-block landed after the class', after.includes('}\nexport const AFTER_BETA = true'), JSON.stringify(after))
  check('the result carries the block-resolution notes', /replace-block 3 → lines 3-6/.test(r.data.result), r.data.result.slice(0, 300))

  const md = join(fixtures, 'doc.md')
  writeFileSync(md, '# t\n\nbody\n')
  const ctx2 = makeContext()
  primeRead(ctx2, md)
  const r2 = await callTool(
    { op: 'apply', patch: [`file ${md} ${mintFileAnchor('# t\n\nbody\n')}`, 'replace-block 1', '| # T'].join('\n') },
    ctx2,
  )
  check('non-TS block op through the tool refuses typed', r2.data.outcome === 'failed' && /explicit line ranges/.test(r2.data.result), r2.data.result.slice(0, 240))
  check('nothing written on the refusal', readFileSync(md, 'utf8') === '# t\n\nbody\n')
}

console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: block anchors resolve TS-family nodes and refuse everything else by name')

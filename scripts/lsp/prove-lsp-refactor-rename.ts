#!/usr/bin/env bun
import { bootWorkspace, makeChecker } from './refactorsHarness.js'

const t = makeChecker('prove-lsp-refactor-rename')
const guard = setTimeout(() => {
  console.error('prove-lsp-refactor-rename: TIMEOUT')
  process.exit(1)
}, 240_000)
guard.unref?.()

const ws = await bootWorkspace()
const G = 'refactors/src/core/greeting.ts'
const IDX = 'refactors/src/core/index.ts'
const LOUD = 'refactors/src/core/loud.ts'
const APP = 'refactors/src/app.ts'
const B = 'refactors/src/ui/Banner.tsx'
const R = 'refactors/src/legacy/report.js'
const M = 'refactors/src/messy.ts'
const MI = 'refactors/src/missing.ts'
const all = [G, IDX, LOUD, APP, B, R, M, MI]
const countOf = (rel: string, word: string): number => ws.text(rel).split(word).length - 1

try {
  t.section('R1 the dry run returns every reference as data and writes nothing')
  const before = ws.digests(all)
  const decl = ws.position(G, 'makeGreeting')
  const preview = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...decl, newName: 'craftGreeting' }, G)
  const rows = preview.edits ?? []
  const byFile = (rel: string) => rows.filter(row => row.file === rel)
  t.check(
    'applied=false, no changed paths, every digest unchanged',
    preview.applied === false && preview.effect.changedPaths.length === 0 && JSON.stringify(ws.digests(all)) === JSON.stringify(before),
    preview.result.slice(0, 200),
  )
  t.check(
    '11 edits across 6 files',
    rows.length === 11 && new Set(rows.map(row => row.file)).size === 6,
    JSON.stringify(rows.map(row => `${row.file}:${row.range.start.line}:${row.range.start.character}`)),
  )
  t.check(
    'the declaration, the barrel re-export, the JSX file, the JavaScript file, the importers',
    byFile(G).length === 1 && byFile(IDX).length === 1 && byFile(B).length === 2 && byFile(R).length === 2 && byFile(APP).length === 3 && byFile(M).length === 2,
    JSON.stringify(rows.map(row => row.file)),
  )
  t.check(
    'every row carries file, range, before and after',
    rows.every(row => row.before === 'makeGreeting' && row.after === 'craftGreeting' && row.range.end.line === row.range.start.line && row.range.end.character - row.range.start.character === 12),
  )
  t.check("the string 'makeGreeting' in app.ts is not a reference", !byFile(APP).some(row => row.range.start.line === ws.position(APP, "'makeGreeting'").line))
  t.check('the unresolved use in missing.ts is not touched', byFile(MI).length === 0)
  const plan = ws.planOf(preview)
  t.check('the dry run names its plan token in the text', typeof plan === 'string' && plan.startsWith('lsp-') && preview.result.includes(plan), preview.result.slice(-200))
  t.check('the text preview spells each row as :line:col-line:col before → after', /:\d+:\d+-\d+:\d+\s+makeGreeting → craftGreeting/.test(preview.result), preview.result.slice(0, 300))

  t.section('R2 a JSX prop rename reaches the attribute')
  const prop = ws.position(B, 'name: string')
  const jsx = await ws.op({ operation: 'rename', filePath: ws.abs(B), ...prop, newName: 'who' }, B)
  const attributeLine = ws.position(B, 'name="crew"').line
  t.check(
    '4 edits in Banner.tsx including the JSX attribute',
    (jsx.edits ?? []).length === 4 && (jsx.edits ?? []).some(row => row.range.start.line === attributeLine),
    JSON.stringify(jsx.edits),
  )

  t.section('R3 apply without reads and without a plan is refused by the read-before-edit law')
  const refused = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...decl, newName: 'craftGreeting', apply: true }, G)
  t.check(
    'refused, nothing written',
    refused.applied !== true && refused.effect.outcome === 'failed' && /read-before-edit/.test(refused.result) && JSON.stringify(ws.digests(all)) === JSON.stringify(before),
    refused.result.slice(0, 300),
  )
  t.check('the refusal names an unread file and the dry-run road', /legacy\/report\.js/.test(refused.result) && /plan/.test(refused.result), refused.result.slice(0, 300))

  t.section('R4 apply with the plan writes every reference and refreshes the read state')
  const applied = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...decl, newName: 'craftGreeting', apply: true, plan }, G)
  t.check(
    'applied across 6 files',
    applied.applied === true && applied.effect.outcome !== 'failed' && applied.effect.changedPaths.length === 6,
    applied.result.slice(0, 300),
  )
  t.check(
    "no 'makeGreeting' identifier remains except the string and the unresolved use",
    countOf(APP, 'makeGreeting') === 1 && countOf(MI, 'makeGreeting') === 1 && [G, IDX, B, R, M].every(rel => countOf(rel, 'makeGreeting') === 0),
  )
  t.check('craftGreeting appears exactly as previewed per file', all.every(rel => countOf(rel, 'craftGreeting') === byFile(rel).length))
  t.check(
    'read state refreshed for every touched file with the new content',
    [G, IDX, APP, B, R, M].every(rel => ws.readFileState.get(ws.abs(rel))?.content === ws.text(rel)),
  )
  t.check('post-apply diagnostics reported', /post-apply diagnostics/i.test(applied.result), applied.result.slice(-200))

  t.section("R5 a colliding rename is refused with the compiler's reason")
  const shout = ws.position(G, 'shoutGreeting')
  const beforeCollide = ws.digests(all)
  const collide = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...shout, newName: 'makeBanner' }, G)
  t.check(
    'refused naming the conflict',
    collide.effect.outcome === 'failed' && /would collide/.test(collide.result) && /Import declaration conflicts with local declaration of 'makeBanner'/.test(collide.result),
    collide.result.slice(0, 300),
  )
  t.check('the refusal names the file and position', /app\.ts:\d+:\d+/.test(collide.result), collide.result.slice(0, 300))
  t.check('nothing written', JSON.stringify(ws.digests(all)) === JSON.stringify(beforeCollide))

  t.section('R6 a rename that would capture another reference is refused')
  const shift = ws.position(G, 'shift')
  const capture = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...shift, newName: 'loudness' }, G)
  t.check(
    "refused: 'loudness' inside shoutGreeting would rebind",
    capture.effect.outcome === 'failed' && /would change what 'loudness'/.test(capture.result),
    capture.result.slice(0, 300),
  )
  t.check('nothing written', JSON.stringify(ws.digests(all)) === JSON.stringify(beforeCollide))

  t.section('R7 the service refuses a library symbol with its own reason')
  const upper = ws.position(G, 'toUpperCase')
  const lib = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...upper, newName: 'toLoud' }, G)
  t.check('refused with the compiler message', lib.effect.outcome === 'failed' && /standard TypeScript library/.test(lib.result), lib.result.slice(0, 300))

  t.section('R8 a reserved word is refused before anything is computed')
  const bad = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...ws.position(G, 'craftGreeting'), newName: 'class' }, G)
  t.check('reserved word refused', bad.effect.outcome === 'failed' && /reserved word/.test(bad.result), bad.result.slice(0, 300))

  t.section('R9 a JavaScript project with a jsconfig is covered by the same service')
  const COUNT = 'refactors-js/lib/count.js'
  const MAIN = 'refactors-js/main.js'
  const tally = ws.position(COUNT, 'tally')
  const js = await ws.op({ operation: 'rename', filePath: ws.abs(COUNT), ...tally, newName: 'countAll' }, COUNT)
  const jsRows = js.edits ?? []
  t.check(
    '3 edits across count.js and main.js',
    jsRows.length === 3 && jsRows.filter(row => row.file === MAIN).length === 2 && jsRows.filter(row => row.file === COUNT).length === 1,
    JSON.stringify(jsRows.map(row => `${row.file}:${row.range.start.line}`)) + ' ' + js.result.slice(0, 200),
  )
} catch (error) {
  t.check('no exception escaped', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await ws.shutdown()
}
t.finish()

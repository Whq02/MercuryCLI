#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { bootWorkspace, makeChecker } from './refactorsHarness.js'

const t = makeChecker('prove-lsp-refactor-move')
const guard = setTimeout(() => {
  console.error('prove-lsp-refactor-move: TIMEOUT')
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
const TARGET = 'refactors/src/core/loudness.ts'
const all = [G, IDX, LOUD, APP, B, R, M, MI]
const clean = async (rel: string): Promise<boolean> => {
  const out = await ws.op({ operation: 'diagnostics', filePath: ws.abs(rel) }, rel)
  return /No diagnostics/.test(out.result)
}

try {
  t.section('M1 moveSymbol: the dry run shows the removal, the new file and every rewritten import; nothing written')
  const before = ws.digests(all)
  const loudness = ws.position(G, 'loudness')
  const preview = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...loudness, targetPath: ws.abs(TARGET) }, G)
  const rows = preview.edits ?? []
  const files = new Set(rows.map(row => row.file))
  t.check('nothing written, target not created', preview.applied === false && preview.effect.changedPaths.length === 0 && !existsSync(ws.abs(TARGET)) && JSON.stringify(ws.digests(all)) === JSON.stringify(before), preview.result.slice(0, 300))
  t.check(
    'the source, the three importers and the new file are in the plan',
    files.has(G) && files.has(APP) && files.has(M) && files.has(R) && files.has(TARGET),
    JSON.stringify([...files]) + ' ' + preview.result.slice(0, 300),
  )
  t.check('the new file row starts from nothing and carries the declaration', rows.some(row => row.file === TARGET && row.before === '' && /export const loudness = 3/.test(row.after)), JSON.stringify(rows.filter(row => row.file === TARGET)))
  t.check('the importers point at the new module', [APP, M, R].every(rel => rows.some(row => row.file === rel && /loudness\.js/.test(row.after))), JSON.stringify(rows.filter(row => row.file !== G && row.file !== TARGET)))
  t.check('the text names the created file', /new file/.test(preview.result), preview.result.slice(0, 400))
  const plan = ws.planOf(preview)
  t.check('a plan token is offered', typeof plan === 'string' && plan.startsWith('lsp-'))

  t.section('M2 apply with the plan: the declaration moves, the importers follow, the project stays clean')
  const applied = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...loudness, targetPath: ws.abs(TARGET), apply: true, plan }, G)
  t.check('applied', applied.applied === true && applied.effect.outcome !== 'failed', applied.result.slice(0, 300))
  t.check('the target exists with the declaration', existsSync(ws.abs(TARGET)) && /export const loudness = 3/.test(ws.text(TARGET)))
  t.check('the source no longer declares it and imports it instead', !/export const loudness/.test(ws.text(G)) && /import \{ loudness \} from ['"]\.\/loudness\.js['"]/.test(ws.text(G)), ws.text(G).slice(0, 120))
  t.check('the importers were rewritten', [APP, M, R].every(rel => /loudness\.js/.test(ws.text(rel))))
  t.check('changedPaths carry the created file and the edited files', applied.effect.changedPaths.includes(ws.abs(TARGET)) && applied.effect.changedPaths.includes(ws.abs(APP)))
  t.check('the read state knows the created file', ws.readFileState.get(ws.abs(TARGET))?.content === ws.text(TARGET))
  const cleanAfterMove = await Promise.all([G, APP, M, TARGET, IDX].map(clean))
  t.check('greeting.ts, app.ts, messy.ts, loudness.ts and index.ts are clean afterwards', cleanAfterMove.every(Boolean), JSON.stringify(cleanAfterMove))

  t.section('M3 the teaching errors')
  const inBody = ws.position(G, 'toUpperCase')
  const body = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...inBody, targetPath: ws.abs('refactors/src/core/x.ts') }, G)
  t.check("a position inside a body is refused and names the declaration", body.effect.outcome === 'failed' && /shoutGreeting/.test(body.result) && /name/.test(body.result), body.result.slice(0, 300))
  const shout = ws.position(G, 'shoutGreeting')
  const self = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs(G) }, G)
  t.check('the source as target is refused', self.effect.outcome === 'failed' && /differ|same file|itself/.test(self.result), self.result.slice(0, 300))
  const dir = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs('refactors/src/core') }, G)
  t.check('a directory as target is refused', dir.effect.outcome === 'failed', dir.result.slice(0, 300))
  const ext = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs('refactors/src/core/shout.py') }, G)
  t.check('a target of another language is refused naming the extensions', ext.effect.outcome === 'failed' && /\.ts/.test(ext.result), ext.result.slice(0, 300))
  t.check('none of the refusals wrote anything', !existsSync(ws.abs('refactors/src/core/x.ts')) && !existsSync(ws.abs('refactors/src/core/shout.py')))

  t.section('M4 pathRename: the file move previews every import edit and writes nothing')
  const NEW_G = 'refactors/src/core/text/greeting.ts'
  const beforeMove = ws.digests([G, IDX, LOUD, APP, M, R, TARGET])
  const movePreview = await ws.op({ operation: 'pathRename', filePath: ws.abs(G), newPath: ws.abs(NEW_G) }, G)
  const moveRows = movePreview.edits ?? []
  t.check('nothing moved, nothing written', movePreview.applied === false && existsSync(ws.abs(G)) && !existsSync(ws.abs(NEW_G)) && JSON.stringify(ws.digests([G, IDX, LOUD, APP, M, R, TARGET])) === JSON.stringify(beforeMove), movePreview.result.slice(0, 300))
  const moveFiles = new Set(moveRows.map(row => row.file))
  t.check(
    'the barrel, the aliased re-export, the JavaScript importer and the moved module\'s own import are rewritten',
    moveFiles.has(IDX) && moveFiles.has(LOUD) && moveFiles.has(R) && moveFiles.has(G) && moveRows.every(row => /text\/greeting\.js|\.\.\/loudness\.js/.test(row.after)),
    JSON.stringify(moveRows.map(row => `${row.file}: ${row.before} → ${row.after}`)),
  )
  const movePlan = ws.planOf(movePreview)
  t.check('a plan token is offered for the import edits', typeof movePlan === 'string')

  t.section('M5 pathRename apply with the plan moves the file and rewrites every import')
  const moved = await ws.op({ operation: 'pathRename', filePath: ws.abs(G), newPath: ws.abs(NEW_G), apply: true, plan: movePlan }, G)
  t.check('moved', moved.applied === true && !existsSync(ws.abs(G)) && existsSync(ws.abs(NEW_G)), moved.result.slice(0, 300))
  t.check('every importer names the new path', [IDX, LOUD, R].every(rel => /text\/greeting\.js/.test(ws.text(rel))))
  const cleanAfterFileMove = await Promise.all([IDX, LOUD, APP, M, NEW_G, TARGET].map(clean))
  t.check('the importers and the moved module are clean afterwards', cleanAfterFileMove.every(Boolean), JSON.stringify(cleanAfterFileMove))
} catch (error) {
  t.check('no exception escaped', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await ws.shutdown()
}
t.finish()

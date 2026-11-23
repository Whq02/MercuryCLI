#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { bootWorkspace, makeChecker } from './refactorsHarness.js'

const t = makeChecker('prove-lsp-refactor-move')
const guard = setTimeout(() => {
  console.error('prove-lsp-refactor-move: TIMEOUT after 240s waiting for the moveSymbol or pathRename operations of the LSP tool (src/tools/lsp/mercuryOps.ts) to answer; check which section printed last and whether the language server started')
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
  t.check('nothing written, target not created', preview.applied === false && preview.effect.changedPaths.length === 0 && !existsSync(ws.abs(TARGET)) && JSON.stringify(ws.digests(all)) === JSON.stringify(before), preview.result.slice(0, 300) + ' — a dry run must not write or create the target; fix the preview path of opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check(
    'the source, the three importers and the new file are in the plan',
    files.has(G) && files.has(APP) && files.has(M) && files.has(R) && files.has(TARGET),
    JSON.stringify([...files]) + ' ' + preview.result.slice(0, 300) + ' — the plan must include the source, its importers and the new file; fix the edit collection in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts',
  )
  t.check('the new file row starts from nothing and carries the declaration', rows.some(row => row.file === TARGET && row.before === '' && /export const loudness = 3/.test(row.after)), JSON.stringify(rows.filter(row => row.file === TARGET)) + ' — the new file row must start empty and carry the moved declaration; fix the target-file edit in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the importers point at the new module', [APP, M, R].every(rel => rows.some(row => row.file === rel && /loudness\.js/.test(row.after))), JSON.stringify(rows.filter(row => row.file !== G && row.file !== TARGET)) + ' — every importer must be rewritten to the new module; fix the import rewrite in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the text names the created file', /new file/.test(preview.result), preview.result.slice(0, 400) + ' — the dry-run text must say a new file is created; fix the result text in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  const plan = ws.planOf(preview)
  t.check('a plan token is offered', typeof plan === 'string' && plan.startsWith('lsp-'), 'the dry run must offer an lsp- plan token to apply with; fix the plan handoff in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')

  t.section('M2 apply with the plan: the declaration moves, the importers follow, the project stays clean')
  const applied = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...loudness, targetPath: ws.abs(TARGET), apply: true, plan }, G)
  t.check('applied', applied.applied === true && applied.effect.outcome !== 'failed', applied.result.slice(0, 300) + ' — apply with the dry run plan must succeed; fix the apply path of opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the target exists with the declaration', existsSync(ws.abs(TARGET)) && /export const loudness = 3/.test(ws.text(TARGET)), 'apply must write the target file with the moved declaration; fix the file creation in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the source no longer declares it and imports it instead', !/export const loudness/.test(ws.text(G)) && /import \{ loudness \} from ['"]\.\/loudness\.js['"]/.test(ws.text(G)), ws.text(G).slice(0, 120) + ' — the source must drop the declaration and import it from the new module; fix the source edit in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the importers were rewritten', [APP, M, R].every(rel => /loudness\.js/.test(ws.text(rel))), 'apply must write every importer edit of the plan; fix the import rewrite in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('changedPaths carry the created file and the edited files', applied.effect.changedPaths.includes(ws.abs(TARGET)) && applied.effect.changedPaths.includes(ws.abs(APP)), 'effect.changedPaths must list the created and the edited files; fix the effect built in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('the read state knows the created file', ws.readFileState.get(ws.abs(TARGET))?.content === ws.text(TARGET), 'the read state must record the created file after apply; fix the read-state update after the write in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  const cleanAfterMove = await Promise.all([G, APP, M, TARGET, IDX].map(clean))
  t.check('greeting.ts, app.ts, messy.ts, loudness.ts and index.ts are clean afterwards', cleanAfterMove.every(Boolean), JSON.stringify(cleanAfterMove) + ' (order: greeting, app, messy, loudness, index) — the move left diagnostics; fix the import rewrite in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')

  t.section('M3 the teaching errors')
  const inBody = ws.position(G, 'toUpperCase')
  const body = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...inBody, targetPath: ws.abs('refactors/src/core/x.ts') }, G)
  t.check("a position inside a body is refused and names the declaration", body.effect.outcome === 'failed' && /shoutGreeting/.test(body.result) && /name/.test(body.result), body.result.slice(0, 300) + ' — the refusal must name the enclosing declaration; fix the position check in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  const shout = ws.position(G, 'shoutGreeting')
  const self = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs(G) }, G)
  t.check('the source as target is refused', self.effect.outcome === 'failed' && /differ|same file|itself/.test(self.result), self.result.slice(0, 300) + ' — a target equal to the source must be refused; fix the targetPath check in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  const dir = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs('refactors/src/core') }, G)
  t.check('a directory as target is refused', dir.effect.outcome === 'failed', dir.result.slice(0, 300) + ' — a directory target must be refused; fix the targetPath check in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  const ext = await ws.op({ operation: 'moveSymbol', filePath: ws.abs(G), ...shout, targetPath: ws.abs('refactors/src/core/shout.py') }, G)
  t.check('a target of another language is refused naming the extensions', ext.effect.outcome === 'failed' && /\.ts/.test(ext.result), ext.result.slice(0, 300) + ' — a target of another language must be refused naming the extensions; fix the targetPath check in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')
  t.check('none of the refusals wrote anything', !existsSync(ws.abs('refactors/src/core/x.ts')) && !existsSync(ws.abs('refactors/src/core/shout.py')), 'a refused move must write nothing; fix the early returns in opMoveSymbol in src/tools/lsp/mercury-ops/moveSymbol.ts')

  t.section('M4 pathRename: the file move previews every import edit and writes nothing')
  const NEW_G = 'refactors/src/core/text/greeting.ts'
  const beforeMove = ws.digests([G, IDX, LOUD, APP, M, R, TARGET])
  const movePreview = await ws.op({ operation: 'pathRename', filePath: ws.abs(G), newPath: ws.abs(NEW_G) }, G)
  const moveRows = movePreview.edits ?? []
  t.check('nothing moved, nothing written', movePreview.applied === false && existsSync(ws.abs(G)) && !existsSync(ws.abs(NEW_G)) && JSON.stringify(ws.digests([G, IDX, LOUD, APP, M, R, TARGET])) === JSON.stringify(beforeMove), movePreview.result.slice(0, 300) + ' — a pathRename dry run must not move or write; fix the preview path of opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')
  const moveFiles = new Set(moveRows.map(row => row.file))
  t.check(
    'the barrel, the aliased re-export, the JavaScript importer and the moved module\'s own import are rewritten',
    moveFiles.has(IDX) && moveFiles.has(LOUD) && moveFiles.has(R) && moveFiles.has(G) && moveRows.every(row => /text\/greeting\.js|\.\.\/loudness\.js/.test(row.after)),
    JSON.stringify(moveRows.map(row => `${row.file}: ${row.before} → ${row.after}`)) + ' — the dry run must list the barrel, the aliased re-export, the JavaScript importer and the moved module; fix the import edits in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts',
  )
  const movePlan = ws.planOf(movePreview)
  t.check('a plan token is offered for the import edits', typeof movePlan === 'string', 'the pathRename dry run must offer a plan token; fix the plan handoff in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')

  t.section('M5 pathRename apply with the plan moves the file and rewrites every import')
  const moved = await ws.op({ operation: 'pathRename', filePath: ws.abs(G), newPath: ws.abs(NEW_G), apply: true, plan: movePlan }, G)
  t.check('moved', moved.applied === true && !existsSync(ws.abs(G)) && existsSync(ws.abs(NEW_G)), moved.result.slice(0, 300) + ' — apply must move the file; fix the apply path of opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')
  t.check('every importer names the new path', [IDX, LOUD, R].every(rel => /text\/greeting\.js/.test(ws.text(rel))), 'apply must rewrite every importer to the new path; fix the import edits in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')
  const cleanAfterFileMove = await Promise.all([IDX, LOUD, APP, M, NEW_G, TARGET].map(clean))
  t.check('the importers and the moved module are clean afterwards', cleanAfterFileMove.every(Boolean), JSON.stringify(cleanAfterFileMove) + ' (order: index, loud, app, messy, moved greeting, loudness) — the move left diagnostics; fix the import edits in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')

  t.section('M6 pathRename of a directory re-keys every read-state entry under it to the same relative path, whatever the spelling of the directory')
  const NOTE = 'refactors/src/standalone/note.ts'
  const MOVED_NOTE = 'refactors/src/moved/note.ts'
  mkdirSync(dirname(ws.abs(NOTE)), { recursive: true })
  writeFileSync(ws.abs(NOTE), 'export const note = 1\n')
  ws.read(NOTE)
  const dirMoved = await ws.op({ operation: 'pathRename', filePath: `${ws.abs('refactors/src/standalone')}/`, newPath: ws.abs('refactors/src/moved'), apply: true })
  t.check('the directory moved (its path spelled with a trailing slash)', dirMoved.applied === true && existsSync(ws.abs(MOVED_NOTE)) && !existsSync(ws.abs(NOTE)), dirMoved.result.slice(0, 300) + ' — a directory path with a trailing slash must move; fix the path handling in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')
  const keys = [...ws.readFileState.keys()]
  t.check('the read-state entry follows to <dir>/moved/note.ts — never to movednote.ts', ws.readFileState.has(ws.abs(MOVED_NOTE)) && !ws.readFileState.has(ws.abs(NOTE)) && !keys.some(key => key.endsWith('movednote.ts')), JSON.stringify(keys.filter(key => /moved|standalone/.test(key))) + ' — the read-state keys under a moved directory must be re-keyed to the same relative path; fix the re-key after the move in opPathRename in src/tools/lsp/mercury-ops/pathRename.ts')
} catch (error) {
  t.check('no exception escaped', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await ws.shutdown()
}
t.finish()

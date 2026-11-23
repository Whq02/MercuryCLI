#!/usr/bin/env bun
import { bootWorkspace, makeChecker } from './refactorsHarness.js'

const t = makeChecker('prove-lsp-refactor-actions')
const guard = setTimeout(() => {
  console.error('prove-lsp-refactor-actions: TIMEOUT after 240s; a language server request from the organizeImports or codeActions operation (src/tools/lsp/lspTools.ts) never answered, see the last section printed above')
  process.exit(1)
}, 240_000)
guard.unref?.()

const ws = await bootWorkspace()
const M = 'refactors/src/messy.ts'
const MI = 'refactors/src/missing.ts'
const APP = 'refactors/src/app.ts'
const LOUD = 'refactors/src/core/loud.ts'
const B = 'refactors/src/ui/Banner.tsx'

try {
  t.section('A1 organizeImports changes only the import block')
  const messyBefore = ws.text(M)
  const bodyStart = messyBefore.indexOf('\nexport function messy')
  const body = messyBefore.slice(bodyStart)
  const importLines = messyBefore.slice(0, bodyStart).split('\n').length
  const preview = await ws.op({ operation: 'organizeImports', filePath: ws.abs(M) }, M)
  const rows = preview.edits ?? []
  t.check('the dry run writes nothing', preview.applied === false && ws.text(M) === messyBefore, preview.result.slice(0, 300) + ' [the organizeImports operation in src/tools/lsp/lspTools.ts must not write without apply]')
  t.check('every row lies inside the import block', rows.length > 0 && rows.every(row => row.file === M && row.range.end.line <= importLines + 1), JSON.stringify(rows.map(row => row.range)) + ' [the organizeImports operation in src/tools/lsp/lspTools.ts must return edit rows only inside the import block]')
  const plan = ws.planOf(preview)
  t.check('a plan token is offered', typeof plan === 'string')
  const organized = await ws.op({ operation: 'organizeImports', filePath: ws.abs(M), apply: true, plan }, M)
  const messyAfter = ws.text(M)
  t.check('applied', organized.applied === true, organized.result.slice(0, 300) + ' [apply with the plan token in the organizeImports operation, src/tools/lsp/lspTools.ts]')
  t.check('the body after the imports is byte-identical', messyAfter.endsWith(body), JSON.stringify(messyAfter.slice(-80)) + ' [organizeImports in src/tools/lsp/lspTools.ts must change only the import block]')
  t.check('the imports were merged and the unused one dropped', /^import \{ makeGreeting, shoutGreeting \} from '\.\/core\/index\.js'\n/.test(messyAfter) && !/loudness/.test(messyAfter), JSON.stringify(messyAfter.slice(0, 120)) + ' [organizeImports in src/tools/lsp/lspTools.ts must apply the server organize edits: merge imports, drop the unused one]')
  const again = await ws.op({ operation: 'organizeImports', filePath: ws.abs(M) }, M)
  t.check('a second organize is an honest no-change', again.effect.outcome === 'no-change' && /already organized/.test(again.result), again.result.slice(0, 200) + ' [organizeImports in src/tools/lsp/lspTools.ts must answer no-change with already organized when no edit is left]')

  t.section('A2 add missing imports, chosen by kind')
  const missingBefore = ws.text(MI)
  const listing = await ws.op({ operation: 'codeActions', filePath: ws.abs(MI), line: 1, character: 1, kind: 'source.addMissingImports' }, MI)
  t.check('one source action is offered under the kind', /1 code action/.test(listing.result) && /source\.addMissingImports/.test(listing.result), listing.result.slice(0, 300) + ' [the codeActions operation in src/tools/lsp/lspTools.ts must list the source actions of the requested kind]')
  ws.read(MI)
  const added = await ws.op({ operation: 'codeActions', filePath: ws.abs(MI), line: 1, character: 1, kind: 'source.addMissingImports', apply: true }, MI)
  t.check('applied without an actionId because the kind left one action', added.applied === true, added.result.slice(0, 300) + ' [the codeActions operation in src/tools/lsp/lspTools.ts must apply the only action when no actionId is given]')
  const missingAfter = ws.text(MI)
  t.check('both imports were added and the body kept', /import \{ (shoutGreeting, makeGreeting|makeGreeting, shoutGreeting) \} from ["']\.\/core\/greeting\.js["']/.test(missingAfter) && missingAfter.endsWith(missingBefore), JSON.stringify(missingAfter.slice(0, 120)) + ' [the source.addMissingImports edit applied by codeActions in src/tools/lsp/lspTools.ts must add both imports and keep the body]')
  const diag = await ws.op({ operation: 'diagnostics', filePath: ws.abs(MI) }, MI)
  t.check('missing.ts is clean afterwards', /No diagnostics/.test(diag.result), diag.result.slice(0, 200))

  t.section('A3 refactors by kind: an actionId without apply previews that action, and the apply rides the plan')
  const start = ws.position(APP, 'names.map')
  const endCharacter = start.character + 'names.map(n => shoutGreeting(makeGreeting(n)))'.length
  const refactors = await ws.op({ operation: 'codeActions', filePath: ws.abs(APP), line: start.line, character: start.character, endLine: start.line, endCharacter, kind: 'refactor' }, APP)
  t.check('extract actions are listed with their kinds', /refactor\.extract\.constant/.test(refactors.result) && /refactor\.extract\.function/.test(refactors.result), refactors.result.slice(0, 400) + ' [the codeActions listing in src/tools/lsp/lspTools.ts must print each action kind]')
  const constantId = /id:(ca-[0-9a-f]{8}) [^\n]*\(refactor\.extract\.constant\)/.exec(refactors.result)?.[1]
  t.check('the constant extraction has a stable id', typeof constantId === 'string', refactors.result.slice(0, 400) + ' [the codeActions listing in src/tools/lsp/lspTools.ts must print a stable id:ca-xxxxxxxx for each action]')
  const appBefore = ws.text(APP)
  const actionPreview = await ws.op({ operation: 'codeActions', filePath: ws.abs(APP), line: start.line, character: start.character, endLine: start.line, endCharacter, kind: 'refactor', actionId: constantId }, APP)
  const actionRows = actionPreview.edits ?? []
  t.check('the preview shows the edit rows and writes nothing', actionPreview.applied === false && actionRows.length > 0 && ws.text(APP) === appBefore, actionPreview.result.slice(0, 300) + ' [codeActions with an actionId and no apply in src/tools/lsp/lspTools.ts must preview edit rows and write nothing]')
  const actionPlan = ws.planOf(actionPreview)
  const extracted = await ws.op({ operation: 'codeActions', filePath: ws.abs(APP), line: start.line, character: start.character, endLine: start.line, endCharacter, kind: 'refactor', actionId: constantId, apply: true, plan: actionPlan }, APP)
  t.check('applied with the plan and no read', extracted.applied === true, extracted.result.slice(0, 300) + ' [codeActions with actionId, apply and plan in src/tools/lsp/lspTools.ts must apply without a prior read]')
  t.check('a constant was extracted', /const newLocal = names\.map/.test(ws.text(APP)) || /const \w+ = names\.map/.test(ws.text(APP)), ws.text(APP).slice(0, 400))
  const appDiag = await ws.op({ operation: 'diagnostics', filePath: ws.abs(APP) }, APP)
  t.check('app.ts is clean afterwards', /No diagnostics/.test(appDiag.result), appDiag.result.slice(0, 200))

  t.section('A4 a kind nobody offers answers honestly')
  const none = await ws.op({ operation: 'codeActions', filePath: ws.abs(LOUD), line: 1, character: 1, kind: 'source.removeUnused' }, LOUD)
  t.check('no actions for the kind', none.effect.outcome === 'no-change' && /No code actions/.test(none.result) && /source\.removeUnused/.test(none.result), none.result.slice(0, 200) + ' [codeActions in src/tools/lsp/lspTools.ts must answer no-change naming the kind when none is offered]')
  const tidy = await ws.op({ operation: 'organizeImports', filePath: ws.abs(B) }, B)
  t.check('organizeImports on an organized file is a no-change', tidy.effect.outcome === 'no-change', tidy.result.slice(0, 200))
} catch (error) {
  t.check('no exception escaped', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await ws.shutdown()
}
t.finish()

#!/usr/bin/env bun
import { appendFileSync, statSync } from 'node:fs'
import { bootWorkspace, makeChecker } from './refactorsHarness.js'

const t = makeChecker('prove-lsp-edit-road')
const guard = setTimeout(() => {
  console.error('prove-lsp-edit-road: TIMEOUT')
  process.exit(1)
}, 240_000)
guard.unref?.()

const MESSAGE_ID = '11111111-2222-4333-8444-555555555555'
const ws = await bootWorkspace(MESSAGE_ID)
const G = 'refactors/src/core/greeting.ts'
const IDX = 'refactors/src/core/index.ts'
const LOUD = 'refactors/src/core/loud.ts'
const APP = 'refactors/src/app.ts'
const M = 'refactors/src/messy.ts'
const touched = [G, IDX, LOUD, APP, M]

try {
  t.section('E1 an apply on files never read is refused and names them')
  const shout = ws.position(G, 'shoutGreeting')
  const before = ws.digests(touched)
  const refused = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...shout, newName: 'bellowGreeting', apply: true }, G)
  t.check('refused by the read-before-edit law', refused.applied !== true && /read-before-edit/.test(refused.result), refused.result.slice(0, 300) + ' — a rename apply on files not yet read must be refused with a read-before-edit message; see the read check in src/tools/lsp/mercury-ops/apply.ts')
  t.check('the unread files are named', touched.every(rel => refused.result.includes(rel)), refused.result.slice(0, 400) + ' — the refusal must list every file the rename would touch; see the read check in src/tools/lsp/mercury-ops/apply.ts')
  t.check('nothing written', JSON.stringify(ws.digests(touched)) === JSON.stringify(before), 'a refused rename apply must leave every touched file byte-identical; see src/tools/lsp/mercury-ops/apply.ts')

  t.section('E2 a full read of every touched file satisfies the law')
  for (const rel of touched) ws.read(rel)
  const applied = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...shout, newName: 'bellowGreeting', apply: true }, G)
  t.check('applied after the reads', applied.applied === true && applied.effect.changedPaths.length === touched.length, applied.result.slice(0, 300) + ' — once every touched file is read, the rename apply must write all of them and report each in effect.changedPaths; see src/tools/lsp/mercury-ops/apply.ts')
  t.check('the effect carries the written paths', touched.every(rel => applied.effect.changedPaths.includes(ws.abs(rel))), 'effect.changedPaths of the applied rename must hold the absolute path of every written file; see src/tools/lsp/mercury-ops/apply.ts')

  t.section('E3 the read state is refreshed for every written file')
  t.check(
    'content equals the disk text and the timestamp is not behind the file',
    touched.every(rel => {
      const entry = ws.readFileState.get(ws.abs(rel))
      return entry !== undefined && entry.content === ws.text(rel) && entry.timestamp >= Math.floor(statSync(ws.abs(rel)).mtimeMs) - 1
    }),
    'after an applied rename, the read-file state of every written file must hold the new disk text and a timestamp not older than the file; see src/tools/lsp/mercury-ops/apply.ts',
  )

  t.section('E4 attribution: the file history tracked every written file under the message')
  const backups = ws.fileHistory().snapshots[0]?.trackedFileBackups ?? {}
  t.check('every touched file has a backup record on the snapshot', touched.every(rel => Object.keys(backups).some(key => key.endsWith(rel))), JSON.stringify(Object.keys(backups)) + ' — the applied rename must record a file-history backup for every written file under the message id; see src/tools/lsp/mercury-ops/apply.ts')

  t.section('E5 a plan whose files changed since the dry run is refused')
  const bellow = ws.position(G, 'bellowGreeting')
  const preview = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...bellow, newName: 'shoutGreeting' }, G)
  const stalePlan = ws.planOf(preview)
  t.check('the dry run offers a plan', typeof stalePlan === 'string', 'a rename dry run (no apply) must return a plan token the apply can pass back; see src/tools/lsp/mercury-ops/apply.ts')
  appendFileSync(ws.abs(APP), '\nexport const drifted = true\n')
  const stale = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...bellow, newName: 'shoutGreeting', apply: true, plan: stalePlan }, G)
  t.check('refused: the plan no longer names the edit set', stale.applied !== true && /plan/.test(stale.result) && /no longer|changed/.test(stale.result), stale.result.slice(0, 300) + ' — an apply with a plan from before a file changed must be refused with a message saying the plan no longer matches')
  t.check('nothing written', /bellowGreeting/.test(ws.text(G)), 'a refused stale-plan apply must leave greeting.ts unchanged')

  t.section('E6 a fresh dry run and its plan apply without any read of the changed file')
  const fresh = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...bellow, newName: 'shoutGreeting' }, G)
  const freshPlan = ws.planOf(fresh)
  t.check('the token moved with the content', typeof freshPlan === 'string' && freshPlan !== stalePlan, 'the plan token of a rename dry run must change when a file it covers changes')
  const restored = await ws.op({ operation: 'rename', filePath: ws.abs(G), ...bellow, newName: 'shoutGreeting', apply: true, plan: freshPlan }, G)
  t.check('applied on the plan alone', restored.applied === true && !/bellowGreeting/.test(ws.text(APP)), restored.result.slice(0, 300) + ' — an apply carrying a fresh plan must write without the changed file having been read again')

  t.section('E7 receipts: the mutation vocabulary knows the refactor operations')
  const contracts = await import('../../src/tools/engines/change-transaction/contracts.js')
  t.check('lsp.rename, lsp.pathRename and lsp.moveSymbol mint receipts', contracts.isMutationOperation('lsp.rename') && contracts.isMutationOperation('lsp.pathRename') && contracts.isMutationOperation('lsp.moveSymbol'), 'isMutationOperation in src/tools/engines/change-transaction/contracts.ts must accept lsp.rename, lsp.pathRename and lsp.moveSymbol')
} catch (error) {
  t.check('no exception escaped', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  await ws.shutdown()
}
t.finish()

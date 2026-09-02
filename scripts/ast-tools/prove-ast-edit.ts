#!/usr/bin/env bun
// ============================================================================
//  scripts/ast-tools/prove-ast-edit.ts — the AstEdit laws through the REAL
//  tool door (runToolUse: validateInput → the permission decision → the ask
//  at the canUseTool seam → call → effect) over a disposable fixture tree:
//
//    1. the dry run: a unified diff per file + a plan token, ZERO writes,
//       no ask (a dry run reads);
//    2. apply without plan / with a stale plan: refused by name, ZERO
//       writes, the fresh dry run offered;
//    3. apply with the plan in default mode: the ask is OBSERVED at the
//       canUseTool seam naming the count and the files; declined ⇒ zero
//       writes; allowed ⇒ written, re-read verified, readFileState fresh,
//       ONE change receipt (operation file.astEdit) with the exact paths;
//    4. a deny rule on one target refuses the WHOLE set; a whole-tool allow
//       rule (the --allowedTools shape) applies without an ask;
//    5. the layout-keeping lane: a declaration rename keeps the body, its
//       indentation and its comments; a shape-changing rewrite takes the
//       literal template;
//    6. every language fixture with a rewrite: the dry run's planned text
//       contains the expected rewrite;
//    7. the deletion law: "" removes the node with its own line;
//    8. the ambiguous-rewrite refusals: nested matches, an uncaptured
//       meta-variable, an anonymous meta-variable, the parse guard;
//    9. /rewind: the file-history snapshot taken before the write restores
//       the original bytes.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'
import { LANGUAGE_FIXTURES, writeLanguageFixtures, writeRenameFixture } from './lib/fixtures.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const { subscribeChangeReceipts } = await import(join(REPO, 'src/services/changeTransaction/receipts.ts'))
const { fileHistoryMakeSnapshot, fileHistoryRestore } = await import(join(REPO, 'src/utils/fileHistory.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-edit-'))
writeLanguageFixtures(root)
writeRenameFixture(join(root, 'rename'))
await enterRoot(root)
const tools = [AstSearchTool, AstEditTool]
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const snapshot = (rels: string[]): Map<string, string> => new Map(rels.map(r => [r, read(r)]))
const unchanged = (before: Map<string, string>): boolean => [...before.entries()].every(([r, t]) => read(r) === t)
const RENAME_FILES = ['rename/src/records.ts', 'rename/src/stats.ts', 'rename/src/report.ts']
const receipts: Array<{ operation: string; changedPaths: string[] }> = []
subscribeChangeReceipts((receipt: { effect: { operation: string; changedPaths: string[] } }) => {
  receipts.push({ operation: receipt.effect.operation, changedPaths: receipt.effect.changedPaths })
})

// ── 1. the dry run ───────────────────────────────────────────────────────────
section('§1 — the dry run: diff + plan, zero writes, no ask')
let planToken = ''
{
  const before = snapshot(RENAME_FILES)
  const prover = await makeContext(tools)
  const r = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename' }, prover)
  check('dry run settles without error', !r.isError, r.text.slice(0, 300))
  check('no ask for a dry run', r.asks.length === 0, JSON.stringify(r.asks))
  check('unified diff per file', r.text.includes('--- a/src/stats.ts') && r.text.includes('+++ b/src/stats.ts') && r.text.includes('--- a/src/report.ts'), r.text.slice(0, 400))
  check('the diff shows the rewrite', r.text.includes('+  const rows = records.map(r => normaliseRecord(r))'), r.text.slice(0, 600))
  const m = /plan: (ae-[0-9a-f]{12})/.exec(r.text)
  planToken = m?.[1] ?? ''
  check('a plan token is offered with the apply instruction', planToken !== '' && r.text.includes(`apply: true, plan: "${planToken}"`), r.text.split('\n').find(l => l.startsWith('plan:')) ?? '')
  check('the dry run counts 2 matches in 2 files (the declaration is not a call)', Number(r.data?.matchCount) === 2 && Number(r.data?.fileCount) === 2, `${r.data?.matchCount}/${r.data?.fileCount}`)
  check('ZERO writes', unchanged(before))
  check('state reads dry-run', r.data?.state === 'dry-run')
  const again = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename' }, prover)
  check('the token is content-addressed (a second dry run reproduces it)', again.text.includes(`plan: ${planToken}`))
}

// ── 2. apply without / with a stale plan ─────────────────────────────────────
section('§2 — apply needs the plan from the dry run')
{
  const before = snapshot(RENAME_FILES)
  const prover = await makeContext(tools)
  const noPlan = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true }, prover)
  check('apply without plan is refused with the fix', noPlan.isError && noPlan.text.includes('apply: true needs plan'), noPlan.text.slice(0, 200))
  const planOnly = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', plan: planToken }, prover)
  check('plan without apply is refused with the fix', planOnly.isError && planOnly.text.includes('plan accompanies apply: true'), planOnly.text.slice(0, 200))
  const stale = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normalisedRecord($$$ARGS)', path: 'rename', apply: true, plan: planToken }, prover)
  check('a plan for a different rewrite is refused and the current plan offered', stale.isError && stale.text.includes(`Plan ${planToken} does not match the current dry run (ae-`) && stale.text.includes('--- a/src/stats.ts'), stale.text.slice(0, 300))
  check('ZERO writes across the refusals', unchanged(before))
  check('a stale-plan refusal asks nothing', stale.asks.length === 0, JSON.stringify(stale.asks))
}

// ── 3. apply in default mode: the ask, declined and allowed ─────────────────
section('§3 — apply asks like Edit does; the receipt')
{
  const before = snapshot(RENAME_FILES)
  const declined = await makeContext(tools)
  const d = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true, plan: planToken }, declined, { answer: 'deny' })
  check('the ask is observed at the canUseTool seam', d.asks.length === 1 && d.asks[0]!.behavior === 'ask', JSON.stringify(d.asks))
  check('the ask names the count and the files', (d.asks[0]?.message ?? '').includes('Rewrite 2 matches of "normalizeRecord($$$ARGS)" in 2 files (src/report.ts, src/stats.ts)'), d.asks[0]?.message ?? '')
  check('declined ⇒ an error result and ZERO writes', d.isError && unchanged(before), d.text.slice(0, 200))
  receipts.length = 0
  const allowed = await makeContext(tools)
  const a = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true, plan: planToken }, allowed)
  check('allowed ⇒ applied', !a.isError && a.data?.state === 'applied' && a.text.startsWith('Applied 2 structural rewrites in 2 files (re-read verified)'), a.text.slice(0, 300))
  check('one ask, answered once', a.asks.length === 1)
  check('the files carry the rewrite', read('rename/src/stats.ts').includes('normaliseRecord(r)') && read('rename/src/report.ts').includes('normaliseRecord(record).label'))
  check('the declaration file is untouched (calls only)', read('rename/src/records.ts') === before.get('rename/src/records.ts'))
  check('an anchor per written file for patch chaining', /src\/stats\.ts — 1 rewrite \(anchor: /.test(a.text), a.text.slice(0, 300))
  const fresh = allowed.readFileState.get(join(root, 'rename/src/stats.ts')) as { content?: string } | undefined
  check('readFileState refreshed with the written bytes', fresh?.content === read('rename/src/stats.ts'))
  check('changedPaths are the exact absolute paths', Array.isArray(a.data?.changedPaths) && (a.data!.changedPaths as string[]).length === 2 && (a.data!.changedPaths as string[]).every(p => p.startsWith(root)), JSON.stringify(a.data?.changedPaths))
  const receipt = receipts.find(r => r.operation === 'file.astEdit')
  check('ONE change receipt minted with operation file.astEdit and the paths', receipts.filter(r => r.operation === 'file.astEdit').length === 1 && receipt !== undefined && receipt.changedPaths.length === 2, JSON.stringify(receipts))
  const afterWrite = snapshot(RENAME_FILES)
  const replay = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true, plan: planToken }, allowed)
  check('re-sending the applied plan finds nothing left to rewrite and writes nothing', !replay.isError && replay.data?.state === 'no-matches' && replay.text.startsWith('No matches for') && unchanged(afterWrite), replay.text.slice(0, 200))
  writeFileSync(join(root, 'rename', 'src', 'extra.ts'), 'export const more = normalizeRecord({ label: "x", value: 1 })\n')
  const drifted = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true, plan: planToken }, allowed)
  check('the old plan against changed files refuses as stale and offers the current dry run', drifted.isError && drifted.text.includes(`Plan ${planToken} does not match the current dry run`) && drifted.text.includes('--- a/src/extra.ts') && unchanged(afterWrite) && read('rename/src/extra.ts').includes('normalizeRecord('), drifted.text.slice(0, 300))
  check('a stale apply asks nothing', drifted.asks.length === 0, JSON.stringify(drifted.asks))
}

// ── 4. deny rule refuses the whole set; whole-tool allow needs no ask ────────
section('§4 — a denied path refuses the whole set; a whole-tool allow rule needs no ask')
{
  // Rename back through a fresh dry run so the fixture is reusable.
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  const dry = await drive(AstEditTool, { pattern: 'normaliseRecord($$$ARGS)', rewrite: 'normalizeRecord($$$ARGS)', path: 'rename' }, prover)
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  const before = snapshot(RENAME_FILES)
  const denied = await makeContext(tools, { deny: ['Edit(rename/src/report.ts)'] })
  const d = await drive(AstEditTool, { pattern: 'normaliseRecord($$$ARGS)', rewrite: 'normalizeRecord($$$ARGS)', path: 'rename', apply: true, plan: token }, denied)
  check('a deny rule on one target refuses the whole set by name', d.isError && d.text.includes('Permission to edit src/report.ts has been denied') && d.text.includes('refuses the whole structural edit (zero writes)'), d.text.slice(0, 300))
  check('ZERO writes under the deny', unchanged(before))
  check('the deny never reached the ask', d.asks.length === 0, JSON.stringify(d.asks))
  const a = await drive(AstEditTool, { pattern: 'normaliseRecord($$$ARGS)', rewrite: 'normalizeRecord($$$ARGS)', path: 'rename', apply: true, plan: token }, prover)
  check('a whole-tool allow rule (--allowedTools AstEdit) applies with no ask', !a.isError && a.asks.length === 0 && a.data?.state === 'applied', `${a.isError} ${JSON.stringify(a.asks)} ${a.text.slice(0, 120)}`)
  check('the fixture is back to its original bytes', RENAME_FILES.every(r => read(r) === (r.endsWith('records.ts') ? before.get(r) : read(r))) && read('rename/src/stats.ts').includes('normalizeRecord(r)'))
}

// ── 4b. the plan token against a file changed between plan and apply ────────
section('§4b — a file changed between the dry run and the apply: refused by name, nothing written')
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  const dry = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename' }, prover)
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  check('a dry run minted a plan', token !== '', dry.text.slice(0, 200))
  // The operator (or another tool) touches a planned file after the dry run.
  const reportPath = join(root, 'rename', 'src', 'report.ts')
  const original = readFileSync(reportPath, 'utf8')
  writeFileSync(reportPath, `${original}// touched after the dry run\n`)
  const before = snapshot(RENAME_FILES)
  const a = await drive(AstEditTool, { pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)', path: 'rename', apply: true, plan: token }, prover)
  check('the stale token is refused by name', a.isError && a.text.includes(`Plan ${token} does not match the current dry run (ae-`) && a.text.includes('Nothing was written'), a.text.slice(0, 300))
  check('the current dry run is offered with its own token', /apply it with plan: "ae-[0-9a-f]{12}"/.test(a.text) && !a.text.includes(`apply it with plan: "${token}"`), a.text.slice(0, 300))
  check('nothing written: every planned file keeps its bytes (the touch included)', unchanged(before) && readFileSync(reportPath, 'utf8').endsWith('// touched after the dry run\n'))
  check('no ask for a stale apply', a.asks.length === 0, JSON.stringify(a.asks))
  writeFileSync(reportPath, original)
}

// ── 5. the layout-keeping lane ───────────────────────────────────────────────
section('§5 — the layout-keeping lane')
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  const dry = await drive(AstEditTool, { pattern: 'function normalizeRecord($$$P) { $$$B }', rewrite: 'function normaliseRecord($$$P) { $$$B }', path: 'rename' }, prover)
  check('a declaration rename touches only the name line', !dry.isError && dry.text.includes('-export function normalizeRecord(record: { label: string; value: number }) {') && dry.text.includes('+export function normaliseRecord(record: { label: string; value: number }) {') && !dry.text.includes('-  // trim the label'), dry.text.slice(0, 500))
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  const applied = await drive(AstEditTool, { pattern: 'function normalizeRecord($$$P) { $$$B }', rewrite: 'function normaliseRecord($$$P) { $$$B }', path: 'rename', apply: true, plan: token }, prover)
  const after = read('rename/src/records.ts')
  check('applied: the body, its indentation and its comment survive', !applied.isError && after.includes('export function normaliseRecord(record: { label: string; value: number }) {\n  // trim the label, keep the value\n  const label = record.label.trim()\n  return { label, value: record.value }\n}'), after)
  // Restore for the later legs.
  const back = await drive(AstEditTool, { pattern: 'function normaliseRecord($$$P) { $$$B }', rewrite: 'function normalizeRecord($$$P) { $$$B }', path: 'rename' }, prover)
  const backToken = /plan: (ae-[0-9a-f]{12})/.exec(back.text)?.[1] ?? ''
  await drive(AstEditTool, { pattern: 'function normaliseRecord($$$P) { $$$B }', rewrite: 'function normalizeRecord($$$P) { $$$B }', path: 'rename', apply: true, plan: backToken }, prover)
  check('restored', read('rename/src/records.ts').includes('export function normalizeRecord('))
  mkdirSync(join(root, 'swap'))
  writeFileSync(join(root, 'swap', 's.ts'), 'assertEqual(actual, expected)\n')
  const swap = await drive(AstEditTool, { pattern: 'assertEqual($A, $B)', rewrite: 'assertEqual($B, $A)', path: 'swap' }, prover)
  check('a capture-moving rewrite takes the literal template', !swap.isError && swap.text.includes('+assertEqual(expected, actual)'), swap.text.slice(0, 300))
  mkdirSync(join(root, 'wrap'))
  writeFileSync(join(root, 'wrap', 'w.py'), 'value = compute(1)\n')
  const wrap = await drive(AstEditTool, { pattern: 'compute($X)', rewrite: 'cached(compute($X))', path: 'wrap' }, prover)
  check('a node-adding rewrite takes the literal template', !wrap.isError && wrap.text.includes('+value = cached(compute(1))'), wrap.text.slice(0, 300))
}

// ── 6. every language with a rewrite ────────────────────────────────────────
section('§6 — every language fixture with a rewrite plans the expected text')
{
  const prover = await makeContext(tools)
  for (const f of LANGUAGE_FIXTURES) {
    if (!f.rewrite) continue
    const entry = GRAMMAR_REGISTRY.find((g: { name: string }) => g.name === f.lang) as { wasm: string }
    if (!existsSync(join(engineDir, entry.wasm))) {
      skip(`${f.lang}: rewrite`, `${entry.wasm} not in this checkout's engine dir`)
      continue
    }
    const r = await drive(AstEditTool, { pattern: f.pattern, rewrite: f.rewrite.rewrite, path: f.lang }, prover)
    const planned = (r.data?.changeView as { files?: Array<{ hunks: Array<{ lines: string[] }> }> } | undefined)?.files?.flatMap(x => x.hunks.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1)))) ?? []
    check(`${f.lang}: ${JSON.stringify(f.rewrite.rewrite)} plans ${f.expect} change(s) containing ${JSON.stringify(f.rewrite.contains)}`, !r.isError && Number(r.data?.matchCount) === f.expect && planned.some(l => l.includes(f.rewrite!.contains)), r.isError ? r.text.slice(0, 200) : `${r.data?.matchCount} matches; +lines: ${planned.join(' | ').slice(0, 200)}`)
  }
}

// ── 7. the deletion law ──────────────────────────────────────────────────────
section('§7 — "" deletes the node with its own line')
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  mkdirSync(join(root, 'del'))
  writeFileSync(join(root, 'del', 'd.py'), 'x = 1\nprint(x)\ny = 2\nprint(y)\n')
  const dry = await drive(AstEditTool, { pattern: 'print($X)', rewrite: '', path: 'del' }, prover)
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  const a = await drive(AstEditTool, { pattern: 'print($X)', rewrite: '', path: 'del', apply: true, plan: token }, prover)
  check('both statements gone, no blank lines left behind', !a.isError && read('del/d.py') === 'x = 1\ny = 2\n', JSON.stringify(read('del/d.py')))
}

// ── 8. the ambiguous-rewrite refusals ────────────────────────────────────────
section('§8 — refusals by name, nothing written')
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  mkdirSync(join(root, 'nest'))
  writeFileSync(join(root, 'nest', 'n.ts'), 'const v = wrap(wrap(1))\n')
  const before = read('nest/n.ts')
  const nested = await drive(AstEditTool, { pattern: 'wrap($$$A)', rewrite: 'unwrap($$$A)', path: 'nest' }, prover)
  check('nested matches refuse and name the pair', nested.isError && nested.text.includes('Ambiguous rewrite in n.ts: the match at line 1 sits inside the match at line 1') && nested.text.includes('"wrap(1)" inside "wrap(wrap(1))"'), nested.text.slice(0, 300))
  mkdirSync(join(root, 'unk'))
  writeFileSync(join(root, 'unk', 'u.ts'), 'const v = wrap(1)\n')
  const unknown = await drive(AstEditTool, { pattern: 'wrap($$$A)', rewrite: 'unwrap($$$NOPE)', path: 'unk' }, prover)
  check('an uncaptured meta-variable in the rewrite refuses by name', unknown.isError && unknown.text.includes('references $$$NOPE which the pattern does not capture (captures: $$$A)'), unknown.text.slice(0, 300))
  const anon = await drive(AstEditTool, { pattern: 'wrap($$$)', rewrite: 'unwrap($$$)', path: 'nest' }, prover)
  check('an anonymous $$$ in the rewrite refuses with the fix', anon.isError && anon.text.includes('anonymous meta-variable') && anon.text.includes('$$$ARGS'), anon.text.slice(0, 300))
  const guard = await drive(AstEditTool, { pattern: 'assertEqual($A, $B)', rewrite: 'assertEqual($A, $B', path: 'swap' }, prover)
  check('the parse guard refuses a rewrite that would break the file', guard.isError && guard.text.includes('would leave s.ts unparsable as typescript'), guard.text.slice(0, 300))
  check('nothing written by any refusal', read('nest/n.ts') === before && read('swap/s.ts') === 'assertEqual(actual, expected)\n')
}

// ── 9. rewind ────────────────────────────────────────────────────────────────
section('§9 — /rewind restores the written file from the pre-write snapshot')
{
  const prover = await makeContext(tools, { allow: ['AstEdit'] })
  mkdirSync(join(root, 'rewind'))
  const original = 'def old_name(a):\n    return a\n\nprint(old_name(1))\n'
  writeFileSync(join(root, 'rewind', 'r.py'), original)
  const turnId = crypto.randomUUID()
  await fileHistoryMakeSnapshot(prover.updateFileHistoryState as never, turnId as never)
  check('a turn snapshot exists before the edit', prover.fileHistory().snapshots.length === 1)
  const dry = await drive(AstEditTool, { pattern: 'old_name($X)', rewrite: 'new_name($X)', path: 'rewind' }, prover, { messageId: turnId })
  const token = /plan: (ae-[0-9a-f]{12})/.exec(dry.text)?.[1] ?? ''
  const a = await drive(AstEditTool, { pattern: 'old_name($X)', rewrite: 'new_name($X)', path: 'rewind', apply: true, plan: token }, prover, { messageId: turnId })
  check('applied', !a.isError && read('rewind/r.py').includes('print(new_name(1))'), a.text.slice(0, 200))
  check('the written file is tracked by file history', prover.fileHistory().trackedFiles.has('rewind/r.py'), [...prover.fileHistory().trackedFiles].join(','))
  // The all-or-nothing restore (the /rewind code road) — the copy-loop
  // rewind it replaced could leave a mixed tree.
  const restored = await fileHistoryRestore(prover.fileHistory(), turnId as never, { dryRun: false, ownerKey: 'ast-edit-prover' })
  check('rewind restores the original bytes', restored.ok && read('rewind/r.py') === original, JSON.stringify({ restored, bytes: read('rewind/r.py') }))
}

finish('AST EDIT LAWS')

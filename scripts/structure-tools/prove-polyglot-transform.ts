#!/usr/bin/env bun
// ============================================================================
//  scripts/structure-tools/prove-polyglot-transform.ts — Family 1, the rewrite
//  preview/apply laws (the digest-exact discipline of the JS/TS lane,
//  proved on the polyglot lane over a DISPOSABLE fixture):
//
//    1. preview writes NOTHING and substitutes captures exactly;
//    2. drift between preview and apply ⇒ typed 'stale' refusal, files
//       untouched, the preview record flips to stale;
//    3. a clean apply re-reads, verifies, records evidence, flips the
//       record to applied; a second apply refuses 'already-applied';
//    4. a rewrite whose output breaks the syntax ⇒ 'parse-guard' refusal,
//       files untouched;
//    5. overlapping (nested) match selections refuse at preview;
//    6. an out template naming an unbound capture refuses at preview;
//    7. empty out deletes the matched node; matchIds subsets apply exactly.
// ============================================================================

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_TREESITTER_VENDOR_DIR ??= join(import.meta.dir, '..', '..', 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')

const { runPolyglotQuery } = await import('../../src/services/structure/polyglotQuery.ts')
const { buildPolyglotPreview, applyPolyglotPreview } = await import('../../src/services/structure/polyglotTransform.ts')
const { rememberQuery, getPreview } = await import('../../src/services/structure/store.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// F6 hygiene: pin the change-set home to a fixture dir.
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'lathe-transform-cs-'))
const root = mkdtempSync(join(tmpdir(), 'lathe-transform-'))
const owner = makeOwnerKey({ workspace: root, sessionId: 'lathe-transform-proof', lane: 'main' })
const appPy = join(root, 'app.py')
const utilGo = join(root, 'util.go')
writeFileSync(appPy, 'def greet(name):\n    print(name)\n    print("hi")\n')
writeFileSync(utilGo, 'package util\n\nimport "fmt"\n\nfunc Greet() {\n\tfmt.Println("a")\n\tfmt.Println("b")\n}\n')

async function freshQuery(pattern: string, lang?: string) {
  const q = await runPolyglotQuery(root, { pattern, ...(lang ? { lang } : {}) })
  if ('state' in q) throw new Error(q.note)
  rememberQuery(owner, q)
  return q
}

// 1+2: preview substitution + drift refusal
{
  const q = await freshQuery('print($X)')
  const before = readFileSync(appPy, 'utf8')
  const p = await buildPolyglotPreview(owner, q, undefined, { kind: 'rewrite', out: 'logging.info($X)' })
  if ('reason' in p) {
    check('preview builds', false, p.reason)
  } else {
    check('preview substitutes captures', p.files[0]!.after[0] === 'logging.info(name)', JSON.stringify(p.files[0]!.after))
    check('preview wrote nothing', readFileSync(appPy, 'utf8') === before)
    writeFileSync(appPy, `${before}# drift\n`)
    const refused = await applyPolyglotPreview(owner, p.id)
    check('drifted apply refuses [stale]', refused.state === 'refused' && refused.code === 'stale')
    check('refused apply left the file alone', readFileSync(appPy, 'utf8') === `${before}# drift\n`)
    check('preview record flipped to stale', getPreview(owner, p.id)?.state === 'stale')
  }
}

// 3: clean MULTI-FILE apply in ONE preview + evidence + double-apply refusal
{
  const secondPy = join(root, 'second.py')
  writeFileSync(secondPy, 'def other():\n    print("second")\n')
  const q = await freshQuery('print($X)')
  const p = await buildPolyglotPreview(owner, q, undefined, { kind: 'rewrite', out: 'logging.info($X)' })
  if ('reason' in p) {
    check('clean preview builds', false, p.reason)
  } else {
    check('one preview spans both files', p.files.length === 2, JSON.stringify(p.files.map(f => f.file)))
    const applied = await applyPolyglotPreview(owner, p.id)
    check('clean apply lands', applied.state === 'applied', applied.state === 'refused' ? applied.reason : '')
    if (applied.state === 'applied') {
      const now = readFileSync(appPy, 'utf8')
      check('re-read shows the rewrite (file 1)', now.includes('logging.info(name)') && !now.includes('print(name)'))
      check('re-read shows the rewrite (file 2)', readFileSync(secondPy, 'utf8').includes('logging.info("second")'))
      check('both files in changedPaths', applied.changedPaths.length === 2)
      check('post-apply diagnostics clean', applied.diagnostics.every(d => d.ok))
      check('evidence refs recorded', applied.evidenceRefs.length === 2, JSON.stringify(applied.evidenceRefs))
      check('preview record flipped to applied', getPreview(owner, p.id)?.state === 'applied')
      const dbl = await applyPolyglotPreview(owner, p.id)
      check('double apply refuses', dbl.state === 'refused' && dbl.code === 'already-applied')
    }
  }
}

// 4: parse guard — a rewrite that breaks the syntax never lands
{
  const q = await freshQuery('fmt.Println($X)')
  const before = readFileSync(utilGo, 'utf8')
  const p = await buildPolyglotPreview(owner, q, [q.matches[0]!.id], { kind: 'rewrite', out: 'if broken((( $X' })
  if ('reason' in p) {
    check('parse-guard preview builds (guard fires at apply)', false, p.reason)
  } else {
    const guard = await applyPolyglotPreview(owner, p.id)
    check('broken rewrite refuses [parse-guard]', guard.state === 'refused' && guard.code === 'parse-guard')
    check('parse-guard left the file alone', readFileSync(utilGo, 'utf8') === before)
  }
}

// 5: nested selections refuse at preview
{
  const nested = join(root, 'nested.py')
  writeFileSync(nested, 'print(print(1))\n')
  const q = await freshQuery('print($X)')
  const nestedIds = q.matches.filter(m => m.file === 'nested.py').map(m => m.id)
  check('nested matches both reported by the query', nestedIds.length === 2, JSON.stringify(q.matches.map(m => m.file)))
  const p = await buildPolyglotPreview(owner, q, nestedIds, { kind: 'rewrite', out: 'log($X)' })
  check('overlapping selection refuses at preview', 'reason' in p && p.reason.includes('overlapping'), 'reason' in p ? p.reason : 'built')
}

// 6: unbound template capture refuses
{
  const q = await freshQuery('fmt.Println($X)')
  const p = await buildPolyglotPreview(owner, q, [q.matches[0]!.id], { kind: 'rewrite', out: 'fmt.Println($NOPE)' })
  check('unbound $NOPE refuses at preview', 'reason' in p && p.reason.includes('$NOPE'), 'reason' in p ? p.reason : 'built')
}

// 7: empty out deletes; matchIds subsets apply exactly one of two
{
  const q = await freshQuery('fmt.Println($X)')
  check('two go matches to subset', q.matches.length === 2, String(q.matches.length))
  const first = q.matches[0]!
  const p = await buildPolyglotPreview(owner, q, [first.id], { kind: 'rewrite', out: '' })
  if ('reason' in p) {
    check('deletion preview builds', false, p.reason)
  } else {
    const applied = await applyPolyglotPreview(owner, p.id)
    check('deletion applies', applied.state === 'applied', applied.state === 'refused' ? applied.reason : '')
    const now = readFileSync(utilGo, 'utf8')
    check('exactly the selected match deleted', !now.includes('fmt.Println("a")') && now.includes('fmt.Println("b")'), now)
  }
}

// 8 (verify-wave regressions): template substitution is ONE pass — capture
// text containing $UPPER rides through verbatim (no corruption, no spurious
// refusal); concurrent applies of one preview never double-write
{
  const inj = join(root, 'inj.py')
  writeFileSync(inj, 'f("has $LAST inside", tail)\n')
  const q = await freshQuery('f($$$INIT, $LAST)', 'python')
  const injIds = q.matches.filter(m => m.file === 'inj.py').map(m => m.id)
  const p = await buildPolyglotPreview(owner, q, injIds, { kind: 'rewrite', out: 'g($$$INIT, $LAST)' })
  if ('reason' in p) {
    check('injection preview builds', false, p.reason)
  } else {
    check(
      'capture text with $UPPER survives verbatim (single-pass law)',
      p.files[0]!.after[0] === 'g("has $LAST inside", tail)',
      JSON.stringify(p.files[0]!.after),
    )
  }
  const q2 = await freshQuery('f($$$ARGS)', 'python')
  writeFileSync(join(root, 'dollar.py'), 'f("price $Y total", n)\n')
  const q3 = await freshQuery('f($$$ARGS)', 'python')
  const dollarIds = q3.matches.filter(m => m.file === 'dollar.py').map(m => m.id)
  const p2 = await buildPolyglotPreview(owner, q3, dollarIds, { kind: 'rewrite', out: 'g($$$ARGS)' })
  check(
    'capture containing $Y never refuses the template',
    !('reason' in p2),
    'reason' in p2 ? p2.reason : '',
  )
  void q2

  const racePy = join(root, 'race.py')
  writeFileSync(racePy, 'race_target(1)\n')
  const rq = await freshQuery('race_target($X)', 'python')
  const rp = await buildPolyglotPreview(owner, rq, undefined, { kind: 'rewrite', out: 'raced($X)' })
  if ('reason' in rp) {
    check('race preview builds', false, rp.reason)
  } else {
    const [first, second] = await Promise.all([
      applyPolyglotPreview(owner, rp.id),
      applyPolyglotPreview(owner, rp.id),
    ])
    const applied = [first, second].filter(r => r.state === 'applied')
    const refused = [first, second].filter(r => r.state === 'refused')
    check('concurrent applies: exactly ONE lands', applied.length === 1 && refused.length === 1, `${applied.length} applied`)
    check('the loser refuses as already-applied/in-flight', refused[0]?.state === 'refused' && refused[0].code === 'already-applied')
  }
}

console.log(failures === 0 ? '\nPOLYGLOT TRANSFORM LAWS GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

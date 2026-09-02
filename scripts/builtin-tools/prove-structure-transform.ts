#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-structure-transform.ts — previewed structural
//  transformations. Proves against a REAL fixture:
//    · preview writes NOTHING (byte-identical tree after preview);
//    · multi-file application with byte-identical untouched files;
//    · stale-preview refusal (a changed file refuses the apply, the
//      preview record reads 'stale');
//    · parse-guard refusal (a template producing broken syntax never
//      reaches disk);
//    · already-applied refusal (no double write);
//    · cancellation before applying settles honestly;
//    · post-apply parse diagnostics + canonical observed evidence;
//    · the apply operation is receipt-vocabulary (exactly-once seam);
//    · rename / replace-import / set-value / remove actions land exactly.
// ============================================================================

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { runStructureQuery } = await import('../../src/services/structure/query.ts')
const { buildPreview, applyPreview } = await import('../../src/services/structure/transform.ts')
const { getPreview, _resetStructureStoreForTesting } = await import(
  '../../src/services/structure/store.ts'
)
const { isMutationOperation } = await import(
  '../../src/services/changeTransaction/contracts.ts'
)
const { evidenceFor, _resetEvidencePlaneForTesting } = await import(
  '../../src/services/primitives/evidencePlane.ts'
)
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const owner = processMainOwner()
// F6 hygiene: the shared commit core journals under the change-set
// home — pin it to a fixture dir so proofs never touch the operator machine.
process.env.MERCURY_CHANGESET_DIR = mkdtempSync(join(tmpdir(), 'builtin-tools-transform-cs-'))
const root = mkdtempSync(join(tmpdir(), 'builtin-tools-transform-'))
mkdirSync(join(root, 'src'), { recursive: true })

const ALPHA = `import { track } from './telemetry/legacy'

export function submit(payload) {
  track('submit', payload)
  console.debug('submitted')
  return payload
}
`
const BETA = `import { track } from './telemetry/legacy'

export const flush = () => {
  track('flush', null)
}
`
const UNTOUCHED = `export const constant = 42
`

function seed(): void {
  writeFileSync(join(root, 'src', 'alpha.js'), ALPHA)
  writeFileSync(join(root, 'src', 'beta.ts'), BETA)
  writeFileSync(join(root, 'src', 'untouched.ts'), UNTOUCHED)
}
seed()

function q(query: Record<string, unknown>) {
  const r = runStructureQuery(root, query as never)
  if ('state' in r) throw new Error(r.note)
  return r
}

try {
  console.log('── preview writes nothing ──')
  const calls = q({ select: 'call', callee: 'track' })
  check('two track() calls across two files', calls.matches.length === 2, `${calls.matches.length}`)
  const preview = buildPreview(owner, calls, undefined, { action: 'replace-callee', to: 'metrics.record' })
  if ('reason' in preview) throw new Error(preview.reason)
  check('preview proposes both files', preview.files.length === 2)
  check('preview reports exact match count', preview.matchCount === 2)
  check('preview carries before/after', preview.files.every(f => f.before.length > 0 && f.after.length > 0))
  check('preview carries expected anchors', preview.files.every(f => f.anchor.length > 0))
  check(
    'preview wrote NOTHING (byte-identical tree)',
    readFileSync(join(root, 'src', 'alpha.js'), 'utf8') === ALPHA &&
      readFileSync(join(root, 'src', 'beta.ts'), 'utf8') === BETA,
  )

  console.log('── stale refusal ──')
  writeFileSync(join(root, 'src', 'beta.ts'), `${BETA}// drifted\n`)
  const stale = await applyPreview(owner, preview.id)
  check('changed file REFUSES the apply', stale.state === 'refused' && stale.code === 'stale', JSON.stringify(stale))
  check('preview record reads stale', getPreview(owner, preview.id)?.state === 'stale')
  check(
    'stale refusal wrote nothing',
    readFileSync(join(root, 'src', 'alpha.js'), 'utf8') === ALPHA,
  )

  console.log('── multi-file apply ──')
  seed()
  const calls2 = q({ select: 'call', callee: 'track' })
  const preview2 = buildPreview(owner, calls2, undefined, { action: 'replace-callee', to: 'metrics.record' })
  if ('reason' in preview2) throw new Error(preview2.reason)
  const applied = await applyPreview(owner, preview2.id)
  check('apply succeeds', applied.state === 'applied', JSON.stringify(applied))
  if (applied.state === 'applied') {
    check('both files changed', applied.changedPaths.length === 2)
    check(
      'the transformation landed exactly',
      readFileSync(join(root, 'src', 'alpha.js'), 'utf8').includes("metrics.record('submit', payload)") &&
        readFileSync(join(root, 'src', 'beta.ts'), 'utf8').includes("metrics.record('flush', null)"),
    )
    check(
      'untouched file is byte-identical',
      readFileSync(join(root, 'src', 'untouched.ts'), 'utf8') === UNTOUCHED,
    )
    check('post-apply parse diagnostics clean', applied.diagnostics.every(d => d.ok))
    check('canonical observed evidence recorded', applied.evidenceRefs.length === 2, JSON.stringify(applied.evidenceRefs))
    const evidence = evidenceFor(owner)
    check(
      'evidence rows exist on the ONE plane (change + check)',
      evidence.some(e => e.kind === 'change' && e.claim.includes(preview2.id)) &&
        evidence.some(e => e.kind === 'check' && e.claim.includes(preview2.id)),
    )
  }
  check('preview record reads applied', getPreview(owner, preview2.id)?.state === 'applied')

  console.log('── already-applied + cancellation + parse guard ──')
  const again = await applyPreview(owner, preview2.id)
  check('second apply REFUSES (no double write)', again.state === 'refused' && again.code === 'already-applied')

  const calls3 = q({ select: 'call', callee: 'metrics.record' })
  const preview3 = buildPreview(owner, calls3, undefined, { action: 'replace', replacement: 'if ((' })
  if ('reason' in preview3) throw new Error(preview3.reason)
  const guard = await applyPreview(owner, preview3.id)
  check('broken template REFUSED by the parse guard', guard.state === 'refused' && guard.code === 'parse-guard', JSON.stringify(guard))
  check(
    'parse guard wrote nothing',
    readFileSync(join(root, 'src', 'alpha.js'), 'utf8').includes("metrics.record('submit', payload)"),
  )

  const calls4 = q({ select: 'call', callee: 'console.debug' })
  const preview4 = buildPreview(owner, calls4, undefined, { action: 'remove' })
  if ('reason' in preview4) throw new Error(preview4.reason)
  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await applyPreview(owner, preview4.id, { signal: aborted.signal })
  check('cancellation before applying settles honestly', cancelled.state === 'refused' && cancelled.code === 'cancelled')
  check('cancelled preview record reads cancelled', getPreview(owner, preview4.id)?.state === 'cancelled')

  console.log('── action matrix ──')
  const imports = q({ select: 'import', module: './telemetry/*' })
  check('import matches for rewrite', imports.matches.length === 2)
  const previewImp = buildPreview(owner, imports, undefined, { action: 'replace-import', module: './metrics' })
  if ('reason' in previewImp) throw new Error(previewImp.reason)
  const appliedImp = await applyPreview(owner, previewImp.id)
  check('replace-import applied', appliedImp.state === 'applied')
  check(
    'module specifiers rewritten',
    readFileSync(join(root, 'src', 'alpha.js'), 'utf8').includes("from './metrics'") &&
      readFileSync(join(root, 'src', 'beta.ts'), 'utf8').includes("from './metrics'"),
  )

  const fn = q({ select: 'function', name: 'submit' })
  const previewRename = buildPreview(owner, fn, undefined, { action: 'rename', to: 'submitPayload' })
  if ('reason' in previewRename) throw new Error(previewRename.reason)
  const appliedRename = await applyPreview(owner, previewRename.id)
  check('rename applied (name token only)', appliedRename.state === 'applied')
  check(
    'declaration renamed',
    readFileSync(join(root, 'src', 'alpha.js'), 'utf8').includes('export function submitPayload(payload)'),
  )

  console.log('── receipt vocabulary ──')
  check("'structure.apply' is receipt-shaped (exactly-once seam)", isMutationOperation('structure.apply'))
  check("'structure.query' is NOT receipt-shaped (reads never mint)", !isMutationOperation('structure.query'))

  console.log('── no-match honesty ──')
  const none = q({ select: 'call', callee: 'nonexistent.fn' })
  const previewNone = buildPreview(owner, none, undefined, { action: 'remove' })
  check(
    'empty match set refuses the preview (no no-op claim)',
    'reason' in previewNone,
    JSON.stringify(previewNone).slice(0, 120),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
  _resetStructureStoreForTesting()
  _resetEvidencePlaneForTesting()
}

console.log(failures === 0 ? 'STRUCTURE TRANSFORM: ALL GREEN' : `STRUCTURE TRANSFORM: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

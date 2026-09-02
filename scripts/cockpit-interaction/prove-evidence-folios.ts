#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-evidence-folios.ts — the Evidence Folio depths
// Glance / Inspect / Audit over EXISTING evidence owners.
//
//  The failure this exists to prevent is a review surface that says less than
//  the owners know (an artifact head with no way to reach its chronology) or
//  more than they can prove (a summary invented from prose). The folio is a
//  PURE PROJECTION of the review journal, the receipt ring and the evidence
//  plane; depth switching is section navigation on the one panes grammar, so
//  stable focus between depths is the hook's own remembered-row law.
//
//  The guarded gap: services/workbench/folio.ts does not exist, or /diff
//  takes no file argument for the folio's focused-diff deep-link.
//
//  The folio's SURFACE (the WORK/workbench board's depth sections, its 'v'
//  opener, the esc carry-back) retired in place with the WORK panel;
//  the owners stay as services.
//
//  §1 the assembler is honest      §2 the surface retired; the panel re-grows nothing
//  §3 the real-binary journey retired with its surface (the panel is captured elsewhere)
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-folio-'))
// The store root is env-resolved at CALL time (registered value flag), so the
// prover pins its own hermetic root before any store call (proof hygiene).
process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(scratch, 'artifacts')

const { addReviewComment, createReviewArtifact, reviseReviewArtifact, setReviewCommentState } =
  await import('../../src/utils/artifacts/reviewStore.ts')
const { contentDigest } = await import('../../src/utils/artifacts/anchors.ts')
const { assembleFolio, folioArtifactId } = await import('../../src/services/workbench/folio.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const OWNER = processMainOwner()
const PRODUCER = { sessionId: 'folio-prover' }
const WORKSPACE = { roots: [process.cwd()] }

const DIFF_BODY = {
  kind: 'diff' as const,
  files: [
    {
      path: 'src/alpha.ts',
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' context', '+added line'] },
      ],
    },
    { path: 'src/beta.ts', hunks: [{ oldStart: 3, oldLines: 0, newStart: 3, newLines: 1, lines: ['+beta line'] }] },
  ],
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the assembler projects the owners, never invents')
{
  const made = createReviewArtifact({
    kind: 'diff',
    title: 'FolioFix',
    producer: PRODUCER,
    workspace: WORKSPACE,
    body: DIFF_BODY,
    evidenceRefs: ['mercury://evidence/ev-alpha'],
    initialStatus: 'ready-for-review',
  })
  t.check('fixture artifact created', made.ok, made.ok ? made.value.id : made.reason)
  if (!made.ok) throw new Error('cannot continue without the fixture')
  const id = made.value.id

  const c1 = addReviewComment({
    artifactId: id,
    version: 1,
    anchor: { t: 'whole' },
    author: 'operator',
    body: 'first review pass — check the beta path',
  })
  const c2 = addReviewComment({
    artifactId: id,
    version: 1,
    anchor: {
      t: 'diff-line',
      path: 'src/alpha.ts',
      side: 'new',
      lineDigest: contentDigest('added line'),
      hunkIndex: 0,
      line: 2,
    },
    author: 'operator',
    body: 'anchored: this line needs a test',
  })
  t.check('two comments attached (whole + diff-line)', c1.ok && c2.ok, `${c1.ok}/${c2.ok}`)
  if (c1.ok) {
    const resolved = setReviewCommentState({
      artifactId: id,
      commentId: c1.value.commentId,
      state: 'resolved',
      resolutionRef: 'mercury://evidence/ev-resolution',
    })
    t.check('one comment resolved with its ref', resolved.ok)
  }

  const folio = assembleFolio(id, OWNER)
  t.check('folio assembles from the bare id', folio !== null)
  if (folio) {
    t.check('glance: status is the journal status', folio.glance.status === 'ready-for-review', folio.glance.status)
    t.check('glance: changed files come from the diff body', folio.glance.changedFileCount === 2, String(folio.glance.changedFileCount))
    t.check(
      'glance: an ownerless prover has NO check records — said plainly, never faked',
      folio.glance.checkSummary === 'no check records',
      folio.glance.checkSummary,
    )
    t.check('glance: open-comment count is live', folio.glance.openComments === 1, String(folio.glance.openComments))
    t.check(
      'inspect: comment rows carry state + anchor place',
      folio.inspect.commentList.length === 2 &&
        folio.inspect.commentList.some(c => c.state === 'resolved') &&
        folio.inspect.commentList.some(c => c.where === 'src/alpha.ts:2'),
      folio.inspect.commentList.map(c => `${c.state}@${c.where}`).join(' · '),
    )
    t.check(
      'inspect: no receipts in this process ⇒ no invented actions',
      folio.inspect.groupedActions.length === 0 && folio.glance.elapsedMs === null,
    )
    t.check(
      'audit: the chronology holds version + comments + state change, time-ordered',
      folio.audit.chronology.length >= 4 &&
        folio.audit.chronology.every((e, i, a) => i === 0 || a[i - 1]!.at <= e.at) &&
        folio.audit.chronology[0]!.line.includes('v1 diff — FolioFix'),
      folio.audit.chronology.map(e => e.line).join(' | '),
    )
    t.check(
      'audit: raw refs = version evidence + resolution refs, nothing else',
      folio.audit.rawRefs.includes('mercury://evidence/ev-alpha') &&
        folio.audit.rawRefs.includes('mercury://evidence/ev-resolution') &&
        folio.audit.rawRefs.length === 2,
      folio.audit.rawRefs.join(' '),
    )
  }

  // Revision keeps the folio identity — "the same folio updates".
  const rev = reviseReviewArtifact({
    id,
    body: DIFF_BODY,
    producer: PRODUCER,
    workspace: WORKSPACE,
  })
  t.check('revision lands on the SAME artifact', rev.ok && rev.ok === true && rev.value.version === 2)
  const after = assembleFolio(`mercury://artifact/${id}/comments`, OWNER)
  t.check(
    'the comments ref reaches the same folio (workbench review rows)',
    after !== null && after.artifactId === id,
    folioArtifactId(`mercury://artifact/${id}/comments`),
  )
  t.check(
    'the chronology grew a v2 event — the rerun path updates in place',
    after !== null && after.audit.chronology.some(e => e.line.startsWith('v2 diff')),
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the folio surface retired with the WORK panel; the owners stay')
{
  // The WORK/workbench board carried the folio's depth grammar (glance …
  // refs), the 'v' opener, the esc carry-back and the rerun enqueue;
  // that surface retired in place.
  // The folio owners (§1, §3) stay as services for the retire-or-adopt decision;
  // the prompts panel must not quietly re-grow the verbs.
  const panel = readFileSync('src/components/prompts-panel/PromptsPanel.tsx', 'utf8')
  t.check(
    'the prompts panel carries no folio section, opener or rerun enqueue',
    !panel.includes("id: 'glance'") && !panel.includes('assembleFolio') && !panel.includes('enqueue({'),
  )
  const diffCmd = readFileSync('src/commands/diff/diff.tsx', 'utf8')
  t.check('/diff accepts the file argument', diffCmd.includes('initialPath={initialPath}'))
  const folioSrc = readFileSync('src/services/workbench/folio.ts', 'utf8')
  t.check(
    'the assembler imports ONLY evidence owners (no store of its own)',
    !folioSrc.includes('writeFileSync') && !folioSrc.includes('useState') &&
      folioSrc.includes("from '../changeTransaction/receipts.js'") &&
      folioSrc.includes("from '../primitives/evidencePlane.js'") &&
      folioSrc.includes("from '../../utils/artifacts/reviewStore.js'"),
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — the real-binary folio journey retired with its surface')
{
  // The glance → folio → audit → esc journey drove the WORK/workbench board;
  // that surface retired in place,
  // and /workbench is the prompts panel — a record with no
  // folio opener. The owners above (§1) keep their service laws; the panel
  // must not quietly re-grow the journey's verbs (§2). The built binary's
  // /workbench surface is captured per sheet line by
  // scripts/prompts-panel/prove-panel-captures.ts.
  t.check('the prompts panel is the /workbench route (the folio journey has no surface to drive)', readFileSync('src/commands/workbench/workbench.tsx', 'utf8').includes('PromptsPanel'))
}

if (process.env.FOLIO_KEEP_SCRATCH !== '1') rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
t.finish('prove-evidence-folios')

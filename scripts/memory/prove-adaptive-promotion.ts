#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-adaptive-promotion.ts
//  PROOF: the adaptive promotion layer of the experience-card
//  system works end-to-end against the REAL production code (no reimpl):
//    A. Transferability triage — scope (general|regime-specific, default
//       regime-specific) + Applies-when/Not-when cues; surfaced in frontmatter,
//       body, and the recall banner (with a regime-specific guard).
//    B. Non-destructive supersede — a rewrite preserves the prior card as a
//       `.superseded.<stamp>.md` audit artifact (freshness flipped); opt-out =0
//       clobbers in place (byte-identical to before).
//    C. Precision-biased recall — the manifest enriches card rows with
//       `| class=<problemClass>`; opt-out =0 ⇒ byte-identical manifest.
//
//  Under bun-run the build stamp is false (no MACRO); we set globalThis.MACRO
//  so the stamp-gated adaptive flags are live.
// ============================================================================

import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildExperienceCard,
  readCardMeta,
  renderExperienceCardForRecall,
  writeExperienceCard,
  type BuildCardInput,
} from '../../src/memdir/experienceCards.js'
import { formatMemoryManifest, scanMemoryFiles, type MemoryHeader } from '../../src/memdir/memoryScan.js'
import { parseFrontmatter } from '../../src/utils/frontmatterParser.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
function clearEnv(): void {
  delete process.env.MERCURY_CARD_SUPERSEDE
  delete process.env.MERCURY_CARD_RECALL_PRECISION
}

const base: BuildCardInput = {
  name: 'retro-demo',
  title: 'Retro demo',
  summary: 'a demo lesson for the adaptive-promotion proof',
  problemClass: 'harness-recon',
  lesson: 'When wiring a gated substrate live, mirror the experience-card opt-out shape.',
  sourceRefs: ['commit:deadbeef'],
  createdAt: '2026-06-17T05:30:00.000Z',
  greenGate: true,
}

setStamp(true)
clearEnv()

console.log('============================================================')
console.log(' adaptive promotion — proof')
console.log('============================================================')

// ── A. Transferability triage ────────────────────────────────────────────────
section('A — transferability triage (scope + applies/not-when)')
{
  const noScope = buildExperienceCard(base)
  if (!noScope.ok) throw new Error('build failed')
  check("scope defaults to 'regime-specific' (conservative)", noScope.meta.scope === 'regime-specific')
  check('frontmatter carries scope', noScope.markdown.includes('scope: regime-specific'))
  check('status line carries scope', noScope.markdown.includes('· scope: regime-specific'))

  const general = buildExperienceCard({
    ...base,
    scope: 'general',
    appliesWhen: 'porting any gated capability to default-on',
    notWhen: 'the capability changes behavior unsafely',
  })
  if (!general.ok) throw new Error('build failed')
  check('explicit scope=general carried in meta', general.meta.scope === 'general')
  check('Applies-when emitted into body', general.markdown.includes('**Applies when:** porting any gated capability to default-on'))
  check('Not-when emitted into body', general.markdown.includes('**Not when:** the capability changes behavior unsafely'))

  // readCardMeta round-trips scope; a card with no scope field defaults safe.
  const fmNoScope = parseFrontmatter(
    '---\nname: x\nmetadata:\n  type: experience-card\n  problemClass: p\n---\nbody',
  ).frontmatter
  check('readCardMeta defaults missing scope to regime-specific', readCardMeta(fmNoScope as Record<string, unknown>)?.scope === 'regime-specific')

  // recall banner surfaces scope + a regime-specific guard.
  const recalledRegime = renderExperienceCardForRecall(noScope.markdown)
  check('recall banner shows scope', recalledRegime.includes('scope: regime-specific'))
  check('recall banner warns: regime-specific, do NOT generalize', /REGIME-SPECIFIC[\s\S]*do NOT generalize/.test(recalledRegime))
  const recalledGeneral = renderExperienceCardForRecall(general.markdown)
  check('general card banner says transferable principle', recalledGeneral.includes('scope: general'))
  check('general card banner does NOT carry the regime warning', !recalledGeneral.includes('do NOT generalize'))
}

// ── B. Non-destructive supersede ──────────────────────────────────────────────
section('B — non-destructive supersede on rewrite')
{
  setStamp(true)
  clearEnv()
  const dir = mkdtempSync(join(tmpdir(), 'retro-sup-'))
  const r1 = await writeExperienceCard(dir, base)
  check('first write ok', r1.ok === true)
  check('first write has no superseded artifact', r1.ok === true && r1.supersededPath === undefined)

  // rewrite with DIFFERENT content (newer lesson + timestamp).
  const r2 = await writeExperienceCard(dir, {
    ...base,
    lesson: 'REVISED: also add a proof harness per wired-live slice.',
    createdAt: '2026-06-17T06:00:00.000Z',
  })
  check('rewrite ok', r2.ok === true)
  check('rewrite preserved the prior as a .superseded artifact', r2.ok === true && typeof r2.supersededPath === 'string' && existsSync(r2.supersededPath!))
  if (r2.ok && r2.supersededPath) {
    const sup = readFileSync(r2.supersededPath, 'utf-8')
    check('superseded artifact has freshness flipped to superseded', sup.includes('freshness: superseded'))
    check('superseded artifact retains the ORIGINAL lesson', sup.includes('mirror the experience-card opt-out shape'))
  }
  const canonical = readFileSync(join(dir, 'retro-demo.md'), 'utf-8')
  check('canonical file now holds the REVISED lesson', canonical.includes('REVISED: also add a proof harness'))
  // MEMORY.md keeps a single pointer to the canonical filename (not the superseded one).
  const idx = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
  check('MEMORY.md points at the canonical card, not the superseded copy', idx.includes('(retro-demo.md)') && !idx.includes('.superseded.'))

  // opt-out: MERCURY_CARD_SUPERSEDE=0 ⇒ clobber in place, no artifact.
  const dir2 = mkdtempSync(join(tmpdir(), 'retro-clob-'))
  process.env.MERCURY_CARD_SUPERSEDE = '0'
  await writeExperienceCard(dir2, base)
  const c2 = await writeExperienceCard(dir2, { ...base, lesson: 'clobbered lesson body for the opt-out path.' })
  check('opt-out (=0): no superseded artifact produced', c2.ok === true && c2.supersededPath === undefined)
  check('opt-out (=0): no .superseded.* file on disk', !readdirSync(dir2).some(f => f.includes('.superseded.')))
  clearEnv()
}

// ── C. Precision-biased recall manifest ───────────────────────────────────────
section('C — precision-biased recall manifest (| class=)')
{
  setStamp(true)
  clearEnv()
  const cardRow: MemoryHeader = {
    filename: 'retro-demo.md',
    absolutePath: '/x/retro-demo.md',
    mtimeMs: Date.parse('2026-06-17T05:30:00.000Z'),
    description: 'a demo lesson',
    type: undefined,
    problemClass: 'harness-recon',
    transferabilityScope: 'general',
  }
  const plainRow: MemoryHeader = {
    filename: 'note.md',
    absolutePath: '/x/note.md',
    mtimeMs: Date.parse('2026-06-17T05:00:00.000Z'),
    description: 'a plain note',
    type: 'project',
    problemClass: null,
    transferabilityScope: null,
  }
  // The precision gate is the CALLER's read (findRelevantMemories wires
  // cardRecallPrecisionEnabled() into the parameter); the formatter itself
  // takes the boolean.
  const onManifest = formatMemoryManifest([cardRow, plainRow], true)
  check('precision ON: card row carries | class=harness-recon', onManifest.includes('| class=harness-recon'))
  // The scope is surfaced so the selector can prefer general (transferable) cards.
  check('precision ON: card row carries | scope=general', onManifest.includes('| scope=general'))
  check('precision ON: a non-card row gets no class/scope suffix', /note\.md \(.*\): a plain note$/m.test(onManifest))

  const offManifest = formatMemoryManifest([cardRow, plainRow], false)
  check('precision OFF: no class suffix anywhere (byte-identical)', !offManifest.includes('| class='))
  check('precision OFF: no scope suffix anywhere (byte-identical)', !offManifest.includes('| scope='))
  {
    const caller = readFileSync(join(import.meta.dir, '../../src/memdir/findRelevantMemories.ts'), 'utf8')
    check(
      'the production caller wires the env gate into the parameter',
      caller.includes('const precision = cardRecallPrecisionEnabled()') &&
        caller.includes('formatMemoryManifest(candidates, precision)'),
    )
  }
  clearEnv()
}

// ── D. Review-hardening: supersede edge cases (collision + frontmatter-scope) ──
section('D — supersede hardening (collision-proof name · frontmatter-scoped flip)')
{
  setStamp(true)
  clearEnv()
  // #6 collision-proof: two rewrites at the SAME createdAt but different prior
  // content must preserve TWO distinct .superseded copies, not overwrite one.
  const dir = mkdtempSync(join(tmpdir(), 'retro-coll-'))
  await writeExperienceCard(dir, { ...base, lesson: 'V1 body — the very first lesson.' })
  const r2 = await writeExperienceCard(dir, { ...base, lesson: 'V2 body — second.', createdAt: '2026-06-17T09:00:00.000Z' })
  const r3 = await writeExperienceCard(dir, { ...base, lesson: 'V3 body — third.', createdAt: '2026-06-17T09:00:00.000Z' })
  const supFiles = readdirSync(dir).filter(f => f.includes('.superseded.'))
  check('two same-timestamp rewrites preserve TWO distinct superseded copies (no collision)', supFiles.length === 2, `found ${supFiles.length}`)
  check('both rewrites reported a supersededPath', r2.ok === true && r3.ok === true && !!(r2 as {supersededPath?:string}).supersededPath && !!(r3 as {supersededPath?:string}).supersededPath)
  const bodies = supFiles.map(f => readFileSync(join(dir, f), 'utf-8'))
  check('the two superseded copies retain DIFFERENT prior bodies (V1 and V2)', bodies.some(b => b.includes('V1 body')) && bodies.some(b => b.includes('V2 body')))

  // #7 frontmatter-scoped: a "freshness:" line in the LESSON BODY must NOT be
  // rewritten by the supersede flip — only the frontmatter freshness flips.
  const dir2 = mkdtempSync(join(tmpdir(), 'retro-fm-'))
  await writeExperienceCard(dir2, { ...base, lesson: 'Body mentions a yaml-ish line:\nfreshness: pinned-in-body\nkeep it intact.' })
  const rw = await writeExperienceCard(dir2, { ...base, lesson: 'revised body.', createdAt: '2026-06-17T10:00:00.000Z' })
  if (rw.ok && rw.supersededPath) {
    const sup = readFileSync(rw.supersededPath, 'utf-8')
    check('superseded: BODY freshness line is preserved (frontmatter-scoped flip)', sup.includes('freshness: pinned-in-body'))
    check('superseded: FRONTMATTER freshness flipped to superseded', /metadata:[\s\S]*freshness: superseded/.test(sup))
  } else {
    check('frontmatter-scope rewrite produced a superseded artifact', false)
  }
  clearEnv()
}

// ── E. Read-side exclusion: superseded copies are NOT recall candidates ────────
section('E — scanMemoryFiles excludes superseded copies from recall')
{
  setStamp(true)
  clearEnv()
  const dir = mkdtempSync(join(tmpdir(), 'retro-scan-'))
  await writeExperienceCard(dir, base)
  const rw = await writeExperienceCard(dir, {
    ...base,
    lesson: 'REVISED for the scan-exclusion proof.',
    createdAt: '2026-06-17T11:00:00.000Z',
  })
  check('rewrite produced a .superseded artifact on disk', rw.ok === true && readdirSync(dir).some(f => f.includes('.superseded.')))

  const headers = await scanMemoryFiles(dir, new AbortController().signal)
  check('scan returns the canonical card (not over-filtered)', headers.some(h => h.filename === 'retro-demo.md'))
  check('scan EXCLUDES the .superseded.* audit copy', !headers.some(h => h.filename.includes('.superseded.')))
  // FN-014 row 6: the per-turn header fan-out stays BOUNDED (an uncapped
  // burst of opens queued as random seeks on the field's spinning disk —
  // SCAN_CAP bounds only the output).
  {
    const scanSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'memdir', 'memoryScan.ts'), 'utf8')
    check('the header reads ride the bounded pool (width pinned, no uncapped allSettled)', scanSrc.includes('mapWithConcurrency(candidates, SCAN_READ_WIDTH') && scanSrc.includes('SCAN_READ_WIDTH = 8') && !scanSrc.includes('Promise.allSettled'))
  }
  const manifest = formatMemoryManifest(headers)
  check('manifest omits any superseded filename (selector never sees it)', !manifest.includes('.superseded.'))

  // Belt-and-suspenders: a normally-named card flipped to freshness: superseded
  // in place is likewise excluded from recall.
  writeFileSync(
    join(dir, 'manually-decayed.md'),
    '---\nname: manually-decayed\ndescription: a manually decayed card\nmetadata:\n  type: experience-card\n  problemClass: p\n  freshness: superseded\n---\nbody\n',
  )
  const headers2 = await scanMemoryFiles(dir, new AbortController().signal)
  check('scan EXCLUDES a normally-named freshness: superseded card', !headers2.some(h => h.filename === 'manually-decayed.md'))
  check('scan still returns the live canonical card alongside', headers2.some(h => h.filename === 'retro-demo.md'))
  clearEnv()
}

setStamp(false)
clearEnv()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ADAPTIVE-PROMOTION PROOFS PASS')
else console.log(`❌ ${failures} ADAPTIVE-PROMOTION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

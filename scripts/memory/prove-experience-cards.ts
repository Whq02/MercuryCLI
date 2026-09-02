#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-experience-cards.ts
//  PROOF: the 3-part experience-card memory extension works end-to-end against
//  the REAL production code (src/memdir/experienceCards.ts), exercised exactly
//  as the live call-sites do — not a reimplementation.
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-experience-cards.ts
//
//  Covers:
//   PROOF 0  Gating / OFF byte-identical (fork+TF gate; doctrine ⇒ [] when off)
//   PROOF 1  Feature 1 — cards as a new memory type: built, indexed, loadable
//            via the existing scanMemoryFiles substrate (no new engine)
//   PROOF 2  Feature 2 — distill-on-high-signal: fires only on green/operator,
//            non-trivial lesson, no secrets
//   PROOF 3  Feature 3 — lifecycle as frontmatter: unapproved ⇒ candidate,
//            approve-flip ⇒ trusted, secret-bearing ⇒ refused
// ============================================================================

import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPERIENCE_CARD_TYPE,
  buildExperienceCard,
  cardTraceGroundEnabled,
  detectSecrets,
  experienceCardDoctrineLines,
  experienceCardsEnabled,
  fullScanSecretRefusal,
  isExperienceCardMarkdown,
  readCardMeta,
  renderExperienceCardForRecall,
  shouldDistill,
  writeExperienceCard,
} from '../../src/memdir/experienceCards.js'
import { scanMemoryFiles } from '../../src/memdir/memoryScan.js'
import { parseFrontmatter } from '../../src/utils/frontmatterParser.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`,
  )
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

// Under bun-run the build stamp is false (no build-time MACRO). config.ts reads
// MACRO at CALL time via `typeof MACRO`, so setting globalThis.MACRO flips the
// stamp shim — used to exercise the stamp-gated MERCURY_CARD_TRACE_GROUND path below.
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

// AWS's own public example key — matches the AKIA pattern, is NOT a real secret.
const FAKE_SECRET = 'AKIAIOSFODNN7EXAMPLE'

const goodLesson =
  'Scout the target seam inline (read the loader + gating + green-gate) before fanning out a recon workflow, so the fan-out agents map methodology onto verified file paths instead of guesses.'

//
section('PROOF 0 — Gating / OFF byte-identical')
//
// Wired live: ON by default on a stamped build, opt out with MERCURY_EXPERIENCE_CARDS=0.
// bun-run reads as a bare stamp (no MACRO)
// and fold the gate off; the version seam is retired — the default-ON gate is
// stamp-independent and `=0` is the only off-switch.
delete process.env.MERCURY_EXPERIENCE_CARDS
check('experienceCardsEnabled() TRUE with no MACRO (default-ON, stamp-independent)', experienceCardsEnabled() === true)
process.env.MERCURY_EXPERIENCE_CARDS = '0'
check('MERCURY_EXPERIENCE_CARDS=0 forces it off (explicit opt-out)', experienceCardsEnabled() === false)
process.env.MERCURY_EXPERIENCE_CARDS = '1'
check('flag truthy ⇒ on (stamp-independent)', experienceCardsEnabled() === true)
delete process.env.MERCURY_EXPERIENCE_CARDS

const offDoctrine = experienceCardDoctrineLines(false)
check('experienceCardDoctrineLines(false) === [] (zero elements ⇒ byte-identical)', Array.isArray(offDoctrine) && offDoctrine.length === 0)
const onDoctrine = experienceCardDoctrineLines(true)
check('experienceCardDoctrineLines(true) is non-empty', onDoctrine.length > 0)
check('on-doctrine leads with a blank separator (no caller blank needed)', onDoctrine[0] === '')
check('on-doctrine carries an experience-cards section heading', onDoctrine.some(l => /^## .*experience cards/i.test(l)))
check('on-doctrine teaches the untrusted-candidate lifecycle', onDoctrine.some(l => /not (?:yet )?a trusted|untrusted|candidate lesson/i.test(l)))

// render is identity for non-card content (so the gated call-site is safe)
const plain = '---\nname: x\ndescription: y\nmetadata:\n  type: project\n---\n\nplain memory'
check('renderExperienceCardForRecall is identity for non-card memory', renderExperienceCardForRecall(plain) === plain)

//
section('PROOF 1 — Feature 1: experience cards as a new memory type (built · indexed · loadable)')
//
const built = buildExperienceCard({
  name: 'recon-before-fanout',
  title: 'Scout the seam inline before fanning out',
  summary: 'Read loader+gating+green-gate yourself before a recon workflow',
  problemClass: 'harness-recon',
  lesson: goodLesson,
  sourceRefs: ['commit:abc1234', 'src/memdir/experienceCards.ts'],
  confidence: 'likely',
  freshness: 'fresh',
  approved: false,
  createdAt: '2026-06-17T00:00:00.000Z',
  greenGate: true,
})
check('buildExperienceCard returns ok', built.ok === true)
if (built.ok) {
  console.log('\n  --- generated card markdown ---')
  console.log(built.markdown.split('\n').map(l => '  | ' + l).join('\n'))
  console.log(`  --- index line ---\n  | ${built.indexLine}\n`)

  const { frontmatter } = parseFrontmatter(built.markdown)
  const meta = readCardMeta(frontmatter as Record<string, unknown>)
  check('frontmatter round-trips to a card meta', meta !== null)
  check('metadata.type === experience-card', meta?.type === EXPERIENCE_CARD_TYPE)
  check('problemClass preserved', meta?.problemClass === 'harness-recon')
  check('sourceRefs preserved (2 refs)', meta?.sourceRefs.length === 2)
  check('confidence preserved', meta?.confidence === 'likely')
  check('approved defaults to false', meta?.approved === false)
  check('index line matches "- [Title](file.md) — …" format', /^- \[.+\]\(recon-before-fanout\.md\) — experience-card \(candidate\):/.test(built.indexLine))

  // write to a temp memory dir + index in MEMORY.md, then prove loadable
  const dir = mkdtempSync(join(tmpdir(), 'hermes-ec-'))
  const w1 = await writeExperienceCard(dir, {
    name: 'recon-before-fanout',
    title: 'Scout the seam inline before fanning out',
    summary: 'Read loader+gating+green-gate yourself before a recon workflow',
    problemClass: 'harness-recon',
    lesson: goodLesson,
    sourceRefs: ['commit:abc1234'],
    createdAt: '2026-06-17T00:00:00.000Z',
    greenGate: true,
  })
  check('writeExperienceCard ok', w1.ok === true)
  if (w1.ok) {
    check('card file written to disk', existsSync(w1.path))
    check('MEMORY.md index created/updated', w1.indexUpdated === true && existsSync(w1.indexPath))
    const idx = readFileSync(w1.indexPath, 'utf-8')
    check('MEMORY.md contains the card pointer', idx.includes('(recon-before-fanout.md)'))

    // loadable via the EXISTING substrate (no new engine)
    const scanned = await scanMemoryFiles(dir, new AbortController().signal)
    const found = scanned.find(m => m.filename.endsWith('recon-before-fanout.md'))
    check('scanMemoryFiles finds the card (existing substrate)', found !== undefined)
    check('scanned card exposes its description (selectable by the model)', !!found?.description)
    check('scanMemoryFiles excludes MEMORY.md itself', !scanned.some(m => m.filename.endsWith('MEMORY.md')))

    // idempotent index
    const w2 = await writeExperienceCard(dir, {
      name: 'recon-before-fanout',
      title: 'Scout the seam inline before fanning out',
      summary: 'dup',
      problemClass: 'harness-recon',
      lesson: goodLesson,
      sourceRefs: [],
      createdAt: '2026-06-17T00:00:00.000Z',
      greenGate: true,
    })
    // A rewrite must never DUPLICATE the pointer; and (the adaptive-promotion
    // #9) it now REFRESHES a stale line in place rather than skipping, so a
    // changed summary/lifecycle is reflected. Here the summary changed to 'dup'.
    const idxAfter = readFileSync(w1.indexPath, 'utf-8')
    const ptrCount = (idxAfter.match(/\(recon-before-fanout\.md\)/g) || []).length
    check('re-write keeps exactly one index pointer (no duplication)', w2.ok === true && ptrCount === 1)
    check('re-write refreshes the stale index line in place (now shows new summary)', idxAfter.includes('dup'))
  }
}

//
section('PROOF 2 — Feature 2: distill-on-high-signal write path')
//
check('fires on green-gate-passing commit + transferable lesson', shouldDistill({ greenGatePassed: true, lesson: goodLesson }).fire === true)
check('does NOT fire when green-gate did not pass', shouldDistill({ greenGatePassed: false, lesson: goodLesson }).fire === false)
check('fires on explicit operator signal even without green', shouldDistill({ greenGatePassed: false, operatorSignal: true, lesson: goodLesson }).fire === true)
check('does NOT fire on a trivial/empty lesson', shouldDistill({ greenGatePassed: true, lesson: 'fixed it' }).fire === false)
const secretDecision = shouldDistill({ greenGatePassed: true, lesson: `${goodLesson} key=${FAKE_SECRET}` })
check('REFUSES a secret-bearing lesson (fatal)', secretDecision.fire === false && /secret/i.test((secretDecision as { reason: string }).reason))

//
section('PROOF 2b — #4 trace-ground gate (MERCURY_CARD_TRACE_GROUND, default-OFF / opt-IN)')
//
// Anchor the lesson body to captured signal (arXiv:2605.29463). The gate is the
// INVERSE of the =0-opt-out card flags: active ONLY when explicitly opted-IN ('1')
// AND on a stamped build. OFF ⇒ byte-identical (a green pass with empty sourceRefs
// STILL fires — same as the existing :175 assertion). It is placed AFTER the
// operatorSignal short-circuit so /remember / operator-banked cards with a legit
// empty sourceRefs are NEVER blocked.
const greenEmptyRefs = { greenGatePassed: true, lesson: goodLesson, sourceRefs: [] as string[] }
const greenWithRefs = { greenGatePassed: true, lesson: goodLesson, sourceRefs: ['commit:abc1234'] }
const opEmptyRefs = { greenGatePassed: true, operatorSignal: true, lesson: goodLesson, sourceRefs: [] as string[] }

// gate-OFF half (default): the flag is unset AND fork is off ⇒ enabled() false.
delete process.env.MERCURY_CARD_TRACE_GROUND
setStamp(false)
check('cardTraceGroundEnabled() false by default (flag unset, bare-stamp)', cardTraceGroundEnabled() === false)
check('flag-OFF: green + empty sourceRefs STILL fires (byte-identical guard)', shouldDistill(greenEmptyRefs).fire === true)

// the opt-in works stamp-independently.
process.env.MERCURY_CARD_TRACE_GROUND = '1'
setStamp(false)
check('flag=1 under a bare stamp ⇒ gate ON (stamp-independence)', cardTraceGroundEnabled() === true)
check('flag=1 bare stamp: green + EMPTY sourceRefs REFUSED (same as stamped)', shouldDistill(greenEmptyRefs).fire === false)

// gate-ON half: flag '1' AND stamped build.
setStamp(true)
check('cardTraceGroundEnabled() true when opted-IN on a stamped build', cardTraceGroundEnabled() === true)
const blocked = shouldDistill(greenEmptyRefs)
check('flag-ON: green + EMPTY sourceRefs ⇒ does NOT fire (trace-ground refusal)', blocked.fire === false)
check('flag-ON: the refusal names the missing anchor', blocked.fire === false && /sourceRefs|grounded|captured signal/i.test((blocked as { reason: string }).reason))
check('flag-ON: green + NON-empty sourceRefs ⇒ fires (anchored to captured signal)', shouldDistill(greenWithRefs).fire === true)
check('flag-ON: operatorSignal + empty sourceRefs STILL fires (short-circuit FIRST — /remember never blocked)', shouldDistill(opEmptyRefs).fire === true)

// flag set to any other value ⇒ OFF (strict '1' opt-in)
process.env.MERCURY_CARD_TRACE_GROUND = 'yes'
setStamp(true)
check('flag set to a non-"1" value ⇒ gate OFF (strict opt-in)', cardTraceGroundEnabled() === false)
check('flag non-"1": green + empty sourceRefs fires again (byte-identical)', shouldDistill(greenEmptyRefs).fire === true)

// restore the harness env/fork state for the proofs that follow
delete process.env.MERCURY_CARD_TRACE_GROUND
setStamp(false)

// the gated write path honours the predicate
const dir2 = mkdtempSync(join(tmpdir(), 'hermes-ec2-'))
const skipped = await writeExperienceCard(dir2, {
  name: 'should-not-write',
  title: 'nope', summary: 'nope', problemClass: 'x',
  lesson: goodLesson, sourceRefs: [], createdAt: '2026-06-17T00:00:00.000Z', greenGate: false,
}, { signal: { greenGatePassed: false, lesson: goodLesson } })
check('writeExperienceCard with non-high-signal ⇒ skipped (no file)', skipped.ok === false && (skipped as { blocked: string }).blocked === 'skipped')
check('skipped write left no file', !existsSync(join(dir2, 'should-not-write.md')))

//
section('PROOF 3 — Feature 3: lifecycle as frontmatter (candidate → approved · secrets refused)')
//
const candidate = buildExperienceCard({
  name: 'lifecycle-demo', title: 'Lifecycle demo', summary: 'demo',
  problemClass: 'demo', lesson: goodLesson, sourceRefs: ['commit:abc1234'],
  approved: false, createdAt: '2026-06-17T00:00:00.000Z', greenGate: true,
})
if (candidate.ok) {
  const renderedCandidate = renderExperienceCardForRecall(candidate.markdown)
  console.log('\n  --- unapproved card, rendered at recall ---')
  console.log(renderedCandidate.split('\n').slice(0, 4).map(l => '  | ' + l).join('\n'))
  const bannerOf = (s: string): string => (s.split('\n')[0] ?? '').split('(')[0] ?? ''
  check('unapproved card renders with a candidate banner', /candidate/i.test(bannerOf(renderedCandidate)))
  check('candidate render warns the lesson is not yet trusted', /not (?:yet )?a trusted|untrusted/i.test(renderedCandidate))
  check('candidate render is NOT presented as approved', !/approved/i.test(bannerOf(renderedCandidate)))

  // operator approves by flipping the field (a plain edit)
  const approvedMarkdown = candidate.markdown.replace('approved: false', 'approved: true')
  const renderedApproved = renderExperienceCardForRecall(approvedMarkdown)
  console.log('\n  --- same card after operator flips metadata.approved: true ---')
  console.log(renderedApproved.split('\n').slice(0, 2).map(l => '  | ' + l).join('\n'))
  check('flipping approved:true ⇒ an approved banner (field drives lifecycle)', /approved/i.test(bannerOf(renderedApproved)))
  check('approved render no longer carries the candidate banner', !/candidate/i.test(bannerOf(renderedApproved)))
}

// #12: a truncated candidate card whose frontmatter closing `---` sits PAST the recall
// cap. The body the renderer surfaces is the truncated PREFIX (no closing `---`), so parsing
// meta from the prefix yields nothing ⇒ the old one-arg path surfaced it with NO "UNVERIFIED"
// framing. The fix sources the banner/meta from the FULL card via the second arg.
section('PROOF 3d — #12: candidate banner renders from the FULL card even when truncated')
{
  // Frontmatter is pushed past 4096 bytes by a long description BEFORE the metadata block,
  // so a 4096-byte prefix cuts mid-frontmatter (no closing ---, no metadata block visible).
  const fullCard = [
    '---',
    'name: big-fm-candidate',
    'description: ' + 'x'.repeat(4200),
    'metadata:',
    '  type: experience-card',
    '  problemClass: bigfm',
    '  confidence: possible',
    '  freshness: fresh',
    '  approved: false',
    '  sourceRefs: []',
    '---',
    '',
    'BODY-MARKER the distilled lesson body',
  ].join('\n')
  const truncatedPrefix = fullCard.slice(0, 4096) // what the recall budget surfaces

  // The gap: the prefix alone has no parseable frontmatter ⇒ one-arg render = NO banner.
  const oneArg = renderExperienceCardForRecall(truncatedPrefix)
  const bannerOf12 = (s: string): string => (s.split('\n')[0] ?? '').split('(')[0] ?? ''
  check('one-arg (prefix only) yields NO candidate banner — the #12 gap', !/candidate/i.test(bannerOf12(oneArg)))

  // The fix: pass the FULL card as metaSource ⇒ the CANDIDATE banner is restored.
  const twoArg = renderExperienceCardForRecall(truncatedPrefix, fullCard)
  check('two-arg render emits the candidate banner from the full frontmatter', /candidate/i.test(bannerOf12(twoArg)))
  check('two-arg render keeps the untrusted framing', /not (?:yet )?a trusted|untrusted/i.test(twoArg))
  // The BODY surfaced is still the truncated prefix (never the full text — that would defeat the cap).
  check('two-arg render surfaces the truncated body, not the full card', twoArg.endsWith(truncatedPrefix))
  check('two-arg render did NOT re-inflate to the full card body', !twoArg.includes('BODY-MARKER'))
  // single-arg callers stay byte-identical (default metaSource = markdown).
  check('single-arg call is unchanged for a normal (untruncated) card', renderExperienceCardForRecall(candidate.ok ? candidate.markdown : '') === (candidate.ok ? renderExperienceCardForRecall(candidate.markdown, candidate.markdown) : ''))
}

// secret-bearing card refused at BUILD time
const secretBuild = buildExperienceCard({
  name: 'secret-card', title: 'leak', summary: 'leak', problemClass: 'x',
  lesson: `${goodLesson} aws_secret_access_key=${FAKE_SECRET}`,
  sourceRefs: [], createdAt: '2026-06-17T00:00:00.000Z', greenGate: true,
})
check('buildExperienceCard refuses secret-bearing input', secretBuild.ok === false && (secretBuild as { blocked: string }).blocked === 'secret-bearing')

// secret-bearing card withheld at LOAD time (defense in depth)
const sneakyCard = [
  '---', 'name: sneaky', 'description: d',
  'metadata:', '  type: experience-card', '  problemClass: x',
  '  confidence: possible', '  freshness: fresh', '  approved: true', '  sourceRefs: []',
  '---', '', `body leaks a token ghp_${'a'.repeat(36)}`,
].join('\n')
const renderedSneaky = renderExperienceCardForRecall(sneakyCard)
check('renderExperienceCardForRecall WITHHOLDS a secret-bearing card', renderedSneaky.includes('refused') && !renderedSneaky.includes('ghp_'))
check('detectSecrets reports the kind, never the value', detectSecrets(`x=${FAKE_SECRET}`).every(m => m.redacted === '[redacted]'))

// the recall path scans only the truncated prefix (4KB/200 lines), so a
// secret PAST the cap would slip past the per-prefix detectSecrets. fullScanSecretRefusal
// (run on a bounded FULL read by readMemoriesForSurfacing) is the load-side fix.
section('PROOF 3b — HB-0095: a secret PAST the truncation cap is withheld via the full scan')
{
  const cleanPrefix = `clean lesson line\n`.repeat(300) // > the 4KB/200-line cap
  const secretTail = `then a leaked token ghp_${'b'.repeat(36)}` // a secret only in the tail
  const fullText = cleanPrefix + secretTail
  const truncatedPrefix = cleanPrefix.slice(0, 4096) // what the renderer would see
  // the renderer scanning ONLY the truncated prefix MISSES it (the gap this fixes)
  check('the truncated prefix alone has NO detectable secret (the gap)', detectSecrets(truncatedPrefix).length === 0)
  // the full-scan helper CATCHES it ⇒ withhold
  check('fullScanSecretRefusal WITHHOLDS when the full text bears a tail secret', fullScanSecretRefusal(fullText) !== null && fullScanSecretRefusal(fullText)!.includes('refused'))
  // fail-closed: cannot fully read (null) ⇒ withhold
  check('fullScanSecretRefusal is FAIL-CLOSED on an unscannable (null) read', fullScanSecretRefusal(null) !== null)
  // clean full text ⇒ surface normally (null = no refusal)
  check('fullScanSecretRefusal passes a clean full text', fullScanSecretRefusal(cleanPrefix) === null)
}

// the OLD truncated branch gated on isExperienceCardMarkdown(content) — i.e.
// on the truncated PREFIX. A card whose `metadata.type` marker (the frontmatter)
// AND a secret both sit PAST MAX_MEMORY_BYTES reads as a NON-card in the prefix, so
// the old branch was SKIPPED and the prefix surfaced with NO full scan. The fix
// runs the full scan on ANY truncated file in the gated branch (deciding card
// framing on the FULL text), so the secret-bearing card is WITHHELD.
section('PROOF 3c — C10: a truncated card whose metadata.type marker + secret sit PAST the cap is WITHHELD')
{
  const MAX_MEMORY_BYTES = 4096 // mirror attachments.ts
  // The threat has TWO faces; the fix closes BOTH by full-scanning ANY truncated
  // file in the gated branch instead of gating on the PREFIX card-check.
  //
  // Face A — the prefix does NOT look like a card (so the OLD prefix-gate skipped the
  // full scan entirely) yet the full file bears a secret PAST the cap. A real card's
  // `metadata.type` frontmatter must sit at line 1 to parse, so the way a card's
  // marker ends up "past the cap" relative to the prefix view is when the prefix is
  // not card-shaped at all — exactly this case.
  const padPrefix = `just some recalled prose line\n`.repeat(200) // ~5.8KB > the cap
  const secretTailA = `\nleaked token: ghp_${'c'.repeat(36)}\n`
  const fullText = padPrefix + secretTailA // secret only past the cap
  const prefix = fullText.slice(0, MAX_MEMORY_BYTES) // what readMemoriesForSurfacing sees

  // Threat preconditions: the prefix is NOT a card and bears NO secret (so a
  // prefix-only gate would have surfaced it without ever full-scanning).
  check('precondition: the truncated PREFIX does NOT parse as a card', isExperienceCardMarkdown(prefix) === false)
  check('precondition: the truncated PREFIX bears NO detectable secret', detectSecrets(prefix).length === 0)
  // The FULL text bears a detectable secret past the cap.
  check('the FULL text bears a detectable secret (past the cap)', detectSecrets(fullText).length > 0)

  // Faithful models of the BRANCH logic (truncated arm of readMemoriesForSurfacing).
  // OLD = the regression: full-scan gated on isExperienceCardMarkdown(PREFIX).
  const oldBranch = (content: string, full: string | null): string => {
    if (full && isExperienceCardMarkdown(content)) {
      const refusal = fullScanSecretRefusal(full)
      return refusal ?? renderExperienceCardForRecall(content)
    }
    return renderExperienceCardForRecall(content)
  }
  // NEW = the fix: full-scan on ANY truncated file; card framing decided on FULL.
  const newBranch = (content: string, full: string | null): string => {
    const refusal = fullScanSecretRefusal(full)
    return refusal
      ? refusal
      : full !== null && isExperienceCardMarkdown(full)
        ? renderExperienceCardForRecall(content)
        : content
  }

  // PLANTED-BAD ARM: the old prefix-gated branch LEAKS — it surfaces the prefix
  // verbatim, never refusing (the regression this proof must catch).
  const oldOut = oldBranch(prefix, fullText)
  check('PLANTED-BAD (old prefix-gate): does NOT withhold — surfaces the prefix (the leak)', !oldOut.includes('refused') && oldOut === prefix)

  // REAL-THING ARM: the fixed branch WITHHOLDS via the full scan.
  const newOut = newBranch(prefix, fullText)
  check('FIXED: the secret-bearing truncated card is WITHHELD (refusal, not the prefix)', newOut.includes('refused') && newOut !== prefix)

  // Fail-closed: an unscannable full read (null) also withholds in the fixed branch.
  check('FIXED: fail-closed on an unscannable (null) full read ⇒ withheld', newBranch(prefix, null).includes('refused'))

  // A CLEAN truncated card (marker in prefix, no secret) still surfaces (card framing).
  const cleanCardFull = [
    '---',
    'metadata:',
    `  type: ${EXPERIENCE_CARD_TYPE}`,
    '  approved: false',
    '  confidence: likely',
    '  freshness: fresh',
    '  scope: general',
    '  problemClass: harness-recon',
    '---',
    `${goodLesson}\n`,
  ].join('\n') + 'tail line\n'.repeat(400)
  const cleanCardPrefix = cleanCardFull.slice(0, MAX_MEMORY_BYTES)
  const cleanOut = newBranch(cleanCardPrefix, cleanCardFull)
  check('FIXED: a CLEAN truncated card still surfaces with card framing (not withheld)', !cleanOut.includes('refused') && /candidate|hypothesis|CANDIDATE/i.test(cleanOut))

  // Face B — a GENUINE card (frontmatter at line 1, so the prefix IS card-shaped)
  // whose secret sits in a huge body PAST the cap. Both old & new branches full-scan
  // here (the prefix is a card), but assert the fix STILL withholds it.
  const cardHeadB = [
    '---',
    'metadata:',
    `  type: ${EXPERIENCE_CARD_TYPE}`,
    '  approved: true',
    '  confidence: confirmed',
    '  freshness: fresh',
    '  scope: general',
    '  problemClass: harness-recon',
    '---',
    '',
  ].join('\n')
  const fullCardB = cardHeadB + `${goodLesson}\n`.repeat(60) + `\nleaked: AKIA${'D'.repeat(16)}\n`
  const prefixCardB = fullCardB.slice(0, MAX_MEMORY_BYTES)
  check('Face B precondition: the prefix IS a card but bears NO secret in the prefix', isExperienceCardMarkdown(prefixCardB) === true && detectSecrets(prefixCardB).length === 0)
  check('Face B precondition: the FULL card bears a secret past the cap', detectSecrets(fullCardB).length > 0)
  const outB = newBranch(prefixCardB, fullCardB)
  check('FIXED: a genuine card with a tail secret is WITHHELD', outB.includes('refused') && outB !== prefixCardB)

  // Source-structure guard on the REAL integration (attachments.ts is unloadable
  // under bun-run — the feature() voice macro — so assert the fixed SHAPE in source):
  // the truncated arm must be gated only on `truncated` (NOT on the prefix card
  // check) and must run fullScanSecretRefusal before surfacing.
  // Re-anchored: the recall pipeline moved to the owned
  // attachments/memorySurfacing.ts submodule (R3 extraction); same invariants.
  const attach = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'attachments', 'memorySurfacing.ts'), 'utf-8')
  check('attachments.ts: truncated arm is `else if (truncated)` (NOT gated on the prefix card check)', /else if \(truncated\) \{/.test(attach))
  check('attachments.ts: the prefix-card gate is GONE from the truncated branch', !/else if \(truncated && isExperienceCardMarkdown\(content\)\)/.test(attach))
  check('attachments.ts: the truncated arm runs fullScanSecretRefusal', /const refusal = fullScanSecretRefusal\(full\)/.test(attach))
  check('attachments.ts: card framing decided on the FULL text (isExperienceCardMarkdown(full))', /isExperienceCardMarkdown\(full\)/.test(attach))
  check('attachments.ts: whole block stays under the experienceCardsEnabled() gate (OFF ⇒ byte-identical)', /if \(!experienceCardsEnabled\(\)\) \{[\s\S]*?else if \(truncated\)/.test(attach))
}

//
section('PROOF 4 — MEMORY.md index is concurrency-safe (no dropped pointers)')
// The card .md write is single-file safe, but the shared MEMORY.md index update
// was a lock-free read-modify-write: two near-simultaneous card writes both read
// the same snapshot and the second clobbered the first's appended pointer line —
// a silently lost index entry. Fire N distinct cards concurrently (Promise.all,
// none awaited individually) and assert EVERY pointer survives in MEMORY.md.
{
  const dirC = mkdtempSync(join(tmpdir(), 'hermes-ec-race-'))
  const N = 8
  const writes = Array.from({ length: N }, (_, i) =>
    writeExperienceCard(dirC, {
      name: `race-card-${i}`,
      title: `Race card ${i}`,
      summary: `concurrent card ${i}`,
      problemClass: 'harness-recon',
      lesson: goodLesson,
      sourceRefs: [],
      createdAt: '2026-06-17T00:00:00.000Z',
      greenGate: true,
    }),
  )
  const results = await Promise.all(writes)
  check('all concurrent writes returned ok', results.every(r => r.ok === true))
  const idxPath = join(dirC, 'MEMORY.md')
  const idxText = readFileSync(idxPath, 'utf-8')
  const present = Array.from({ length: N }, (_, i) => `(race-card-${i}.md)`).filter(tok => idxText.includes(tok))
  check(`all ${N} pointers survive in MEMORY.md (was lossy without serialization)`, present.length === N, `${present.length}/${N} present`)
  // and the index is well-formed (single header, no temp-file leftover on disk)
  check('no .tmp- index leftover after atomic rename', !readdirSync(dirC).some(f => f.includes('.tmp-')))
}

//
console.log(`\n${'═'.repeat(76)}`)
if (failures === 0) {
  console.log('✅ ALL EXPERIENCE-CARD PROOFS PASS')
} else {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
}
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

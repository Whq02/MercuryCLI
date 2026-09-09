#!/usr/bin/env bun

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

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

const FAKE_SECRET = 'AKIAIOSFODNN7EXAMPLE'

const goodLesson =
  'Scout the target seam inline (read the loader + gating + green-gate) before fanning out a recon workflow, so the fan-out agents map methodology onto verified file paths instead of guesses.'

section('PROOF 0 — Gating / OFF byte-identical')
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

const plain = '---\nname: x\ndescription: y\nmetadata:\n  type: project\n---\n\nplain memory'
check('renderExperienceCardForRecall is identity for non-card memory', renderExperienceCardForRecall(plain) === plain)

section('PROOF 1 — Feature 1: experience cards as a new memory type (built · indexed · loadable)')
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

  const dir = mkdtempSync(join(tmpdir(), 'mercury-ec-'))
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

    const scanned = await scanMemoryFiles(dir, new AbortController().signal)
    const found = scanned.find(m => m.filename.endsWith('recon-before-fanout.md'))
    check('scanMemoryFiles finds the card (existing substrate)', found !== undefined)
    check('scanned card exposes its description (selectable by the model)', !!found?.description)
    check('scanMemoryFiles excludes MEMORY.md itself', !scanned.some(m => m.filename.endsWith('MEMORY.md')))

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
    const idxAfter = readFileSync(w1.indexPath, 'utf-8')
    const ptrCount = (idxAfter.match(/\(recon-before-fanout\.md\)/g) || []).length
    check('re-write keeps exactly one index pointer (no duplication)', w2.ok === true && ptrCount === 1)
    check('re-write refreshes the stale index line in place (now shows new summary)', idxAfter.includes('dup'))
  }
}

section('PROOF 2 — Feature 2: distill-on-high-signal write path')
check('fires on green-gate-passing commit + transferable lesson', shouldDistill({ greenGatePassed: true, lesson: goodLesson }).fire === true)
check('does NOT fire when green-gate did not pass', shouldDistill({ greenGatePassed: false, lesson: goodLesson }).fire === false)
check('fires on explicit operator signal even without green', shouldDistill({ greenGatePassed: false, operatorSignal: true, lesson: goodLesson }).fire === true)
check('does NOT fire on a trivial/empty lesson', shouldDistill({ greenGatePassed: true, lesson: 'fixed it' }).fire === false)
const secretDecision = shouldDistill({ greenGatePassed: true, lesson: `${goodLesson} key=${FAKE_SECRET}` })
check('REFUSES a secret-bearing lesson (fatal)', secretDecision.fire === false && /secret/i.test((secretDecision as { reason: string }).reason))

section('PROOF 2b — #4 trace-ground gate (MERCURY_CARD_TRACE_GROUND, default-OFF / opt-IN)')
const greenEmptyRefs = { greenGatePassed: true, lesson: goodLesson, sourceRefs: [] as string[] }
const greenWithRefs = { greenGatePassed: true, lesson: goodLesson, sourceRefs: ['commit:abc1234'] }
const opEmptyRefs = { greenGatePassed: true, operatorSignal: true, lesson: goodLesson, sourceRefs: [] as string[] }

delete process.env.MERCURY_CARD_TRACE_GROUND
setStamp(false)
check('cardTraceGroundEnabled() false by default (flag unset, bare-stamp)', cardTraceGroundEnabled() === false)
check('flag-OFF: green + empty sourceRefs STILL fires (byte-identical guard)', shouldDistill(greenEmptyRefs).fire === true)

process.env.MERCURY_CARD_TRACE_GROUND = '1'
setStamp(false)
check('flag=1 under a bare stamp ⇒ gate ON (stamp-independence)', cardTraceGroundEnabled() === true)
check('flag=1 bare stamp: green + EMPTY sourceRefs REFUSED (same as stamped)', shouldDistill(greenEmptyRefs).fire === false)

setStamp(true)
check('cardTraceGroundEnabled() true when opted-IN on a stamped build', cardTraceGroundEnabled() === true)
const blocked = shouldDistill(greenEmptyRefs)
check('flag-ON: green + EMPTY sourceRefs ⇒ does NOT fire (trace-ground refusal)', blocked.fire === false)
check('flag-ON: the refusal names the missing anchor', blocked.fire === false && /sourceRefs|grounded|captured signal/i.test((blocked as { reason: string }).reason))
check('flag-ON: green + NON-empty sourceRefs ⇒ fires (anchored to captured signal)', shouldDistill(greenWithRefs).fire === true)
check('flag-ON: operatorSignal + empty sourceRefs STILL fires (short-circuit FIRST — /remember never blocked)', shouldDistill(opEmptyRefs).fire === true)

process.env.MERCURY_CARD_TRACE_GROUND = 'yes'
setStamp(true)
check('flag set to a non-"1" value ⇒ gate OFF (strict opt-in)', cardTraceGroundEnabled() === false)
check('flag non-"1": green + empty sourceRefs fires again (byte-identical)', shouldDistill(greenEmptyRefs).fire === true)

delete process.env.MERCURY_CARD_TRACE_GROUND
setStamp(false)

const dir2 = mkdtempSync(join(tmpdir(), 'mercury-ec2-'))
const skipped = await writeExperienceCard(dir2, {
  name: 'should-not-write',
  title: 'nope', summary: 'nope', problemClass: 'x',
  lesson: goodLesson, sourceRefs: [], createdAt: '2026-06-17T00:00:00.000Z', greenGate: false,
}, { signal: { greenGatePassed: false, lesson: goodLesson } })
check('writeExperienceCard with non-high-signal ⇒ skipped (no file)', skipped.ok === false && (skipped as { blocked: string }).blocked === 'skipped')
check('skipped write left no file', !existsSync(join(dir2, 'should-not-write.md')))

section('PROOF 3 — Feature 3: lifecycle as frontmatter (candidate → approved · secrets refused)')
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

  const approvedMarkdown = candidate.markdown.replace('approved: false', 'approved: true')
  const renderedApproved = renderExperienceCardForRecall(approvedMarkdown)
  console.log('\n  --- same card after operator flips metadata.approved: true ---')
  console.log(renderedApproved.split('\n').slice(0, 2).map(l => '  | ' + l).join('\n'))
  check('flipping approved:true ⇒ an approved banner (field drives lifecycle)', /approved/i.test(bannerOf(renderedApproved)))
  check('approved render no longer carries the candidate banner', !/candidate/i.test(bannerOf(renderedApproved)))
}

section('PROOF 3d — #12: candidate banner renders from the FULL card even when truncated')
{
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
  const truncatedPrefix = fullCard.slice(0, 4096)

  const oneArg = renderExperienceCardForRecall(truncatedPrefix)
  const bannerOf12 = (s: string): string => (s.split('\n')[0] ?? '').split('(')[0] ?? ''
  check('one-arg (prefix only) yields NO candidate banner — the #12 gap', !/candidate/i.test(bannerOf12(oneArg)))

  const twoArg = renderExperienceCardForRecall(truncatedPrefix, fullCard)
  check('two-arg render emits the candidate banner from the full frontmatter', /candidate/i.test(bannerOf12(twoArg)))
  check('two-arg render keeps the untrusted framing', /not (?:yet )?a trusted|untrusted/i.test(twoArg))
  check('two-arg render surfaces the truncated body, not the full card', twoArg.endsWith(truncatedPrefix))
  check('two-arg render did NOT re-inflate to the full card body', !twoArg.includes('BODY-MARKER'))
  check('single-arg call is unchanged for a normal (untruncated) card', renderExperienceCardForRecall(candidate.ok ? candidate.markdown : '') === (candidate.ok ? renderExperienceCardForRecall(candidate.markdown, candidate.markdown) : ''))
}

const secretBuild = buildExperienceCard({
  name: 'secret-card', title: 'leak', summary: 'leak', problemClass: 'x',
  lesson: `${goodLesson} aws_secret_access_key=${FAKE_SECRET}`,
  sourceRefs: [], createdAt: '2026-06-17T00:00:00.000Z', greenGate: true,
})
check('buildExperienceCard refuses secret-bearing input', secretBuild.ok === false && (secretBuild as { blocked: string }).blocked === 'secret-bearing')

const sneakyCard = [
  '---', 'name: sneaky', 'description: d',
  'metadata:', '  type: experience-card', '  problemClass: x',
  '  confidence: possible', '  freshness: fresh', '  approved: true', '  sourceRefs: []',
  '---', '', `body leaks a token ghp_${'a'.repeat(36)}`,
].join('\n')
const renderedSneaky = renderExperienceCardForRecall(sneakyCard)
check('renderExperienceCardForRecall WITHHOLDS a secret-bearing card', renderedSneaky.includes('refused') && !renderedSneaky.includes('ghp_'))
check('detectSecrets reports the kind, never the value', detectSecrets(`x=${FAKE_SECRET}`).every(m => m.redacted === '[redacted]'))

section('PROOF 3b — HB-0095: a secret PAST the truncation cap is withheld via the full scan')
{
  const cleanPrefix = `clean lesson line\n`.repeat(300)
  const secretTail = `then a leaked token ghp_${'b'.repeat(36)}`
  const fullText = cleanPrefix + secretTail
  const truncatedPrefix = cleanPrefix.slice(0, 4096)
  check('the truncated prefix alone has NO detectable secret (the gap)', detectSecrets(truncatedPrefix).length === 0)
  check('fullScanSecretRefusal WITHHOLDS when the full text bears a tail secret', fullScanSecretRefusal(fullText) !== null && fullScanSecretRefusal(fullText)!.includes('refused'))
  check('fullScanSecretRefusal is FAIL-CLOSED on an unscannable (null) read', fullScanSecretRefusal(null) !== null)
  check('fullScanSecretRefusal passes a clean full text', fullScanSecretRefusal(cleanPrefix) === null)
}

section('PROOF 3c — C10: a truncated card whose metadata.type marker + secret sit PAST the cap is WITHHELD')
{
  const MAX_MEMORY_BYTES = 4096
  const padPrefix = `just some recalled prose line\n`.repeat(200)
  const secretTailA = `\nleaked token: ghp_${'c'.repeat(36)}\n`
  const fullText = padPrefix + secretTailA
  const prefix = fullText.slice(0, MAX_MEMORY_BYTES)

  check('precondition: the truncated PREFIX does NOT parse as a card', isExperienceCardMarkdown(prefix) === false)
  check('precondition: the truncated PREFIX bears NO detectable secret', detectSecrets(prefix).length === 0)
  check('the FULL text bears a detectable secret (past the cap)', detectSecrets(fullText).length > 0)

  const oldBranch = (content: string, full: string | null): string => {
    if (full && isExperienceCardMarkdown(content)) {
      const refusal = fullScanSecretRefusal(full)
      return refusal ?? renderExperienceCardForRecall(content)
    }
    return renderExperienceCardForRecall(content)
  }
  const newBranch = (content: string, full: string | null): string => {
    const refusal = fullScanSecretRefusal(full)
    return refusal
      ? refusal
      : full !== null && isExperienceCardMarkdown(full)
        ? renderExperienceCardForRecall(content)
        : content
  }

  const oldOut = oldBranch(prefix, fullText)
  check('PLANTED-BAD (old prefix-gate): does NOT withhold — surfaces the prefix (the leak)', !oldOut.includes('refused') && oldOut === prefix)

  const newOut = newBranch(prefix, fullText)
  check('FIXED: the secret-bearing truncated card is WITHHELD (refusal, not the prefix)', newOut.includes('refused') && newOut !== prefix)

  check('FIXED: fail-closed on an unscannable (null) full read ⇒ withheld', newBranch(prefix, null).includes('refused'))

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

  const attach = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'attachments', 'memorySurfacing.ts'), 'utf-8')
  check('attachments.ts: truncated arm is `else if (truncated)` (NOT gated on the prefix card check)', /else if \(truncated\) \{/.test(attach))
  check('attachments.ts: the prefix-card gate is GONE from the truncated branch', !/else if \(truncated && isExperienceCardMarkdown\(content\)\)/.test(attach))
  check('attachments.ts: the truncated arm runs fullScanSecretRefusal', /const refusal = fullScanSecretRefusal\(full\)/.test(attach))
  check('attachments.ts: card framing decided on the FULL text (isExperienceCardMarkdown(full))', /isExperienceCardMarkdown\(full\)/.test(attach))
  check('attachments.ts: whole block stays under the experienceCardsEnabled() gate (OFF ⇒ byte-identical)', /if \(!experienceCardsEnabled\(\)\) \{[\s\S]*?else if \(truncated\)/.test(attach))
}

section('PROOF 4 — MEMORY.md index is concurrency-safe (no dropped pointers)')
{
  const dirC = mkdtempSync(join(tmpdir(), 'mercury-ec-race-'))
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
  check('no .tmp- index leftover after atomic rename', !readdirSync(dirC).some(f => f.includes('.tmp-')))
}

console.log(`\n${'═'.repeat(76)}`)
if (failures === 0) {
  console.log('✅ ALL EXPERIENCE-CARD PROOFS PASS')
} else {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
}
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)

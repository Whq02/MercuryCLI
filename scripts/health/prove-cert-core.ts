#!/usr/bin/env bun
// prove-cert-core — table-tests the PURE certificate trust rules
// (src/utils/healthCertCore.ts: zero harness imports, bun-loadable by design).
// The decision tables here ARE the docs/HEALTH-CERTIFICATE.md contract:
// verdict roll-up precedence, the gate-verdict interpretation table (green@HEAD
// ⇒ ok · HEAD-moved/dirty ⇒ stale · red ⇒ fail · absent ⇒ unknown), age
// formatting, defensive decodes, next-action ranking, and the Helm chip's
// staleness policy.
import {
  chipFromLastCert,
  composeChip,
  countByStatus,
  decodeGateVerdict,
  decodeLastCertSummary,
  decodePreflightSummary,
  filterCertificateToCheck,
  formatAge,
  interpretGateVerdict,
  nextActions,
  sha7,
  summarizeCert,
  verdictFromStatuses,
  CERT_CHIP_STALE_MS,
  type HealthCertificate,
  type HealthCheck,
  type GateVerdict,
} from '../../src/utils/healthCertCore.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failures++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── verdict roll-up precedence ───────────────────────────────────────────────
check('empty ⇒ certified', verdictFromStatuses([]) === 'certified')
check('ok/off/info are neutral ⇒ certified', verdictFromStatuses(['ok', 'off', 'info']) === 'certified')
check('warn ⇒ caution', verdictFromStatuses(['ok', 'warn']) === 'caution')
check('stale ⇒ caution', verdictFromStatuses(['ok', 'stale']) === 'caution')
check('unknown ⇒ caution', verdictFromStatuses(['ok', 'unknown']) === 'caution')
check('fail dominates ⇒ fault', verdictFromStatuses(['ok', 'warn', 'fail', 'stale']) === 'fault')

// ── `--only` narrowing (filterCertificateToCheck) ────────────────────────────
{
  const mk = (id: string, status: HealthCheck['status']): HealthCheck =>
    ({ id, label: id, status, evidence: 'e' }) as HealthCheck
  const cert = {
    verdict: 'fault',
    sections: [
      { id: 's1', title: 'S1', checks: [mk('alpha', 'ok'), mk('beta', 'fail')] },
      { id: 's2', title: 'S2', checks: [mk('gamma', 'warn')] },
    ],
  } as Pick<HealthCertificate, 'sections' | 'verdict'>
  const one = filterCertificateToCheck(cert, 'alpha')
  check('--only narrows to exactly the named check', one !== null && one.sections.flatMap(s => s.checks).length === 1 && one.sections[0]!.checks[0]!.id === 'alpha')
  check('empty sections drop from the narrowed record', one !== null && one.sections.length === 1 && one.sections[0]!.id === 's1')
  check('the verdict is recomputed over what REMAINS (ok ⇒ certified, not the inherited fault)', one !== null && one.verdict === 'certified')
  const warned = filterCertificateToCheck(cert, 'gamma')
  check('…and honestly (warn ⇒ caution)', warned !== null && warned.verdict === 'caution')
  check('an unknown id returns null (the caller owns the refusal)', filterCertificateToCheck(cert, 'nope') === null)
  check('the input certificate is untouched (pure)', cert.sections[0]!.checks.length === 2 && cert.verdict === 'fault')
}

// ── gate-verdict interpretation table ────────────────────────────────────────
const NOW = Date.parse('2026-07-03T12:00:00Z')
const green: GateVerdict = {
  ok: true,
  pass: ['ui', 'scribe', 'typecheck'],
  fail: [],
  ranAt: '2026-07-03T11:46:00Z',
  headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  dirty: false,
  durationS: 80,
  treeSha: null,
}
{
  const r = interpretGateVerdict(null, { sha: 'a', dirty: false }, NOW)
  // Re-trued (first-contact law): never-run is 'info' — neutral, never a
  // caution on a fresh install — and never assumed green either (the
  // evidence says no verdict exists; only a RECORDED verdict can certify
  // or caution the proofs section).
  check('absent artifact ⇒ info (a never-run install has not failed a check)', r.status === 'info')
  check('absent artifact evidence says no verdict was recorded', r.evidence.includes('no gate verdict recorded'))
  check('…and the optional road stays named', (r.fix ?? '').includes('run-all-suites.sh'))
}
{
  const red: GateVerdict = { ...green, ok: false, pass: ['ui'], fail: ['scribe', 'memory'] }
  const r = interpretGateVerdict(red, { sha: green.headSha, dirty: false }, NOW)
  check('red verdict at the SAME state ⇒ live fail', r.status === 'fail')
  check('red evidence names the red suites', r.evidence.includes('scribe') && r.evidence.includes('RED'))
  // Inventory S3: a red AGES exactly like a green — recorded
  // against a superseded commit/tree it is stale evidence of a PAST red,
  // never a present-tense assertion.
  const movedHead = interpretGateVerdict(red, { sha: 'somewhere-else', dirty: false }, NOW)
  check('red verdict at a SUPERSEDED commit ⇒ stale, never present-tense fail', movedHead.status === 'stale')
  check('the stale red still names what WAS red', movedHead.evidence.includes('scribe') && movedHead.evidence.includes('superseded'))
  const movedTree = interpretGateVerdict(
    { ...red, treeSha: 'tree-a' },
    { sha: green.headSha, dirty: false, treeSha: 'tree-b' },
    NOW,
  )
  check('red verdict against a changed working tree ⇒ stale', movedTree.status === 'stale')
}
{
  const r = interpretGateVerdict(green, { sha: green.headSha, dirty: false }, NOW)
  check('green @ same HEAD, both clean ⇒ ok', r.status === 'ok')
  check('ok evidence carries suites+age', r.evidence.includes('3 suites green') && r.evidence.includes('14m ago'))
}
{
  const r = interpretGateVerdict(green, { sha: 'b'.repeat(40), dirty: false }, NOW)
  check('green but HEAD moved ⇒ stale', r.status === 'stale')
  check('stale evidence says HEAD moved', r.evidence.includes('HEAD has moved'))
}
{
  const r = interpretGateVerdict(green, { sha: green.headSha, dirty: true }, NOW)
  check('green but tree NOW dirty ⇒ stale', r.status === 'stale')
}
{
  const r = interpretGateVerdict({ ...green, dirty: true }, { sha: green.headSha, dirty: false }, NOW)
  check('green from a dirty run ⇒ stale', r.status === 'stale')
}
{
  const r = interpretGateVerdict({ ...green, headSha: null }, { sha: null, dirty: false }, NOW)
  check('green, no shas either side ⇒ ok with the comparison skipped', r.status === 'ok' && r.evidence.includes('sha comparison skipped'))
}

// ── content binding ──────────
const TREE = 'f'.repeat(40)
{
  // The chronic case: gate ran DIRTY, the commit landed (HEAD moved, tree now
  // clean) — but the gated tree IS the current tree ⇒ fresh, not stale.
  const bound: GateVerdict = { ...green, dirty: true, treeSha: TREE }
  const r = interpretGateVerdict(bound, { sha: 'b'.repeat(40), dirty: false, treeSha: TREE }, NOW)
  check('content-bound: dirty-run + moved HEAD but SAME tree ⇒ ok', r.status === 'ok')
  check('content-bound evidence says so', r.evidence.includes('content-bound'))
}
{
  // Mismatched tree falls through to the honest staleness rules.
  const bound: GateVerdict = { ...green, treeSha: TREE }
  const r = interpretGateVerdict(bound, { sha: 'b'.repeat(40), dirty: false, treeSha: 'e'.repeat(40) }, NOW)
  check('tree MISMATCH ⇒ still stale (HEAD moved)', r.status === 'stale')
}
{
  // Red is never rescued by a matching tree.
  const red: GateVerdict = { ...green, ok: false, fail: ['ui'], treeSha: TREE }
  const r = interpretGateVerdict(red, { sha: green.headSha, dirty: false, treeSha: TREE }, NOW)
  check('red + matching tree ⇒ still fail (content match never rescues red)', r.status === 'fail')
}
{
  // Legacy verdicts (no treeSha) keep the original rules bit-for-bit.
  const r = interpretGateVerdict(green, { sha: 'b'.repeat(40), dirty: false, treeSha: TREE }, NOW)
  check('legacy verdict without treeSha ⇒ the old staleness rules stand', r.status === 'stale')
}

// ── defensive decodes ────────────────────────────────────────────────────────
check('decodeGateVerdict rejects non-objects', decodeGateVerdict('nope') === null && decodeGateVerdict(null) === null)
check('decodeGateVerdict rejects missing ok', decodeGateVerdict({ pass: [], fail: [], ranAt: green.ranAt }) === null)
check('decodeGateVerdict rejects unparseable ranAt', decodeGateVerdict({ ...green, ranAt: 'yesterday-ish' }) === null)
check('decodeGateVerdict rejects non-string suites', decodeGateVerdict({ ...green, pass: [1, 2] }) === null)
{
  const d = decodeGateVerdict({ ...green, headSha: '', durationS: 'x' })
  check('decodeGateVerdict normalizes empty sha → null, bad duration → 0', d !== null && d.headSha === null && d.durationS === 0)
}

// ── age formatting ───────────────────────────────────────────────────────────
check('formatAge seconds', formatAge(5_000) === '5s ago')
check('formatAge minutes', formatAge(5 * 60_000) === '5m ago')
check('formatAge hours', formatAge(3 * 3_600_000) === '3h ago')
check('formatAge days', formatAge(3 * 86_400_000) === '3d ago')
check('formatAge negative ⇒ clock skew (honest)', formatAge(-5) === 'clock skew')
check('sha7 of null is honest placeholders', sha7(null) === '???????')

// ── next-action ranking ──────────────────────────────────────────────────────
const mk = (id: string, status: HealthCheck['status'], fix?: string): HealthCheck => ({
  id,
  label: id,
  status,
  evidence: 'e',
  ...(fix ? { fix } : {}),
})
{
  const ranked = nextActions(
    [mk('w', 'warn', 'fix-w'), mk('f', 'fail', 'fix-f'), mk('s', 'stale', 'fix-s'), mk('u', 'unknown', 'fix-u'), mk('n', 'fail')],
    3,
  )
  check(
    'nextActions ranks fail > stale > warn and drops fixless checks',
    ranked.length === 3 && ranked[0]!.fix === 'fix-f' && ranked[1]!.fix === 'fix-s' && ranked[2]!.fix === 'fix-w',
  )
}

// ── last-cert summary round-trip + chip policy ───────────────────────────────
const cert: HealthCertificate = {
  verdict: 'caution',
  sections: [
    { id: 's1', title: 'S1', checks: [mk('a', 'ok'), mk('b', 'warn', 'f')] },
    { id: 's2', title: 'S2', checks: [mk('c', 'stale')] },
  ],
  ranAt: '2026-07-03T11:59:00Z',
  head: { sha: 'a'.repeat(40), branch: 'main', dirty: true },
  version: '1.0.0',
  durationMs: 100,
}
{
  const sum = summarizeCert(cert)
  const rt = decodeLastCertSummary(JSON.parse(JSON.stringify({ ...sum, _v: 1 })))
  check('summary round-trips through JSON + decode', rt !== null && rt.verdict === 'caution' && rt.counts.stale === 1 && rt.head.dirty === true)
  const counts = countByStatus(cert.sections.flatMap(s => s.checks))
  check('countByStatus covers the 7-status enum', counts.ok === 1 && counts.warn === 1 && counts.stale === 1 && counts.unknown === 0)
  // The summary NAMES its verdict-driving rows — a `caution`
  // artifact must never again report `warn: 1` and name nothing.
  check(
    'summary carries the attention rows (stale before warn, ids + evidence)',
    sum.attention.length === 2 && sum.attention[0]!.id === 'c' && sum.attention[0]!.status === 'stale' && sum.attention[1]!.id === 'b' && sum.attention[1]!.evidence === 'e',
    JSON.stringify(sum.attention),
  )
  check('attention rows round-trip through decode', rt !== null && rt.attention.length === 2 && rt.attention[0]!.id === 'c')
  const pre = decodeLastCertSummary({
    verdict: 'caution',
    ranAt: cert.ranAt,
    head: cert.head,
    version: 'v',
    counts: { ok: 1, warn: 1, fail: 0, stale: 0, unknown: 0, off: 0, info: 0 },
  })
  check('a older-format summary (no attention field) decodes to []', pre !== null && Array.isArray(pre.attention) && pre.attention.length === 0)
}
check('decodeLastCertSummary rejects garbage', decodeLastCertSummary({ verdict: 'meh' }) === null)
{
  const sum = summarizeCert(cert)
  const fresh = chipFromLastCert(sum, Date.parse(cert.ranAt) + 5 * 60_000)
  const old = chipFromLastCert(sum, Date.parse(cert.ranAt) + CERT_CHIP_STALE_MS + 1)
  check('chip: fresh cert not stale, verdict carried', fresh.stale === false && fresh.verdict === 'caution' && fresh.ageLabel === '5m ago')
  check('chip: >24h cert reads stale', old.stale === true)
  check('chip: never-issued reads verdict null / "never"', chipFromLastCert(null, NOW).verdict === null && chipFromLastCert(null, NOW).ageLabel === 'never')
}

// ── composeChip: newer evidence may only DOWNGRADE/annotate (trust-cockpit) ──
// This is a trust primitive — enumerate the input space (cert × preflight ×
// gate, each: absent / older / newer-good / newer-bad).
{
  const NOW = Date.parse('2026-07-03T12:00:00Z')
  const iso = (offsetMin: number): string => new Date(NOW + offsetMin * 60_000).toISOString()
  const cert = (verdict: 'certified' | 'caution' | 'fault', atMin: number) =>
    decodeLastCertSummary({
      verdict,
      ranAt: iso(atMin),
      head: { sha: 'a'.repeat(40), branch: 'main', dirty: false },
      version: 'v',
      counts: { ok: 1, warn: 0, fail: 0, stale: 0, unknown: 0, off: 0, info: 0 },
    })
  const pf = (verdict: 'certified' | 'caution' | 'fault', atMin: number) =>
    decodePreflightSummary({
      via: 'preflight',
      verdict,
      ranAt: iso(atMin),
      failing: verdict === 'fault' ? [{ id: 'wrapper', evidence: 'digest drifted' }] : [],
      durationMs: 12,
    })
  const gate = (ok: boolean, atMin: number): GateVerdict => ({
    ok,
    pass: ok ? ['ui'] : [],
    fail: ok ? [] : ['ui', 'memory'],
    ranAt: iso(atMin),
    headSha: 'a'.repeat(40),
    dirty: false,
    durationS: 60,
  })

  const base = cert('certified', -60)
  check('compose: no newer evidence ⇒ plain chip, no alert', composeChip(base, pf('certified', -120), gate(true, -120), NOW).alert === undefined)
  const pfFault = composeChip(base, pf('fault', -5), null, NOW)
  check('compose: newer preflight FAULT ⇒ CRIMSON alert naming the check', pfFault.alert?.source === 'preflight' && pfFault.alert.tone === 'fault' && pfFault.alert.text.includes('wrapper'))
  check('compose: preflight fault does NOT change verdict/age (no upgrade, no re-issue)', pfFault.verdict === 'certified' && pfFault.ageLabel === chipFromLastCert(base, NOW).ageLabel)
  const gateRed = composeChip(base, null, gate(false, -5), NOW)
  check('compose: newer gate RED ⇒ fault-tone alert with suite count', gateRed.alert?.source === 'gate' && gateRed.alert.tone === 'fault' && gateRed.alert.text.includes('2 suites'))
  const gateGreen = composeChip(base, null, gate(true, -5), NOW)
  check('compose: newer gate green ⇒ FAINT annotation (go re-certify), never an upgrade', gateGreen.alert?.tone === 'ok' && gateGreen.verdict === 'certified')
  const both = composeChip(base, pf('fault', -3), gate(false, -5), NOW)
  check('compose: both newer ⇒ the NEWER speaks (preflight at -3 over gate at -5)', both.alert?.source === 'preflight')
  const gateSupersedes = composeChip(base, pf('fault', -10), gate(true, -2), NOW)
  check('compose: a newer GREEN gate supersedes an older preflight-fault (its fault WAS the red gate)', gateSupersedes.alert?.source === 'gate' && gateSupersedes.alert.tone === 'ok')
  const older = composeChip(base, pf('fault', -120), gate(false, -90), NOW)
  check('compose: evidence OLDER than the cert never alerts (the cert superseded it)', older.alert === undefined)
  const noCert = composeChip(null, pf('fault', -5), null, NOW)
  check('compose: preflight fault with NO cert still alerts (verdict stays null)', noCert.verdict === null && noCert.alert?.tone === 'fault')
  const skew = composeChip(base, pf('fault', 120), null, NOW)
  check('compose: a far-future stamp (clock skew) is not "newer" — no alert', skew.alert === undefined)
  check('compose: preflight caution (non-fault) never alerts', composeChip(base, pf('caution', -5), null, NOW).alert === undefined)

  // decodePreflightSummary defensive table
  check('decode preflight: happy path', decodePreflightSummary({ via: 'preflight', verdict: 'fault', ranAt: iso(0), failing: [], durationMs: 1 })?.verdict === 'fault')
  check('decode preflight: wrong via ⇒ null', decodePreflightSummary({ via: 'cert', verdict: 'fault', ranAt: iso(0) }) === null)
  check('decode preflight: bad verdict ⇒ null', decodePreflightSummary({ via: 'preflight', verdict: 'green', ranAt: iso(0) }) === null)
  check('decode preflight: bad ranAt ⇒ null', decodePreflightSummary({ via: 'preflight', verdict: 'fault', ranAt: 'nope' }) === null)
  check('decode preflight: malformed failing entries dropped, not fatal', decodePreflightSummary({ via: 'preflight', verdict: 'fault', ranAt: iso(0), failing: [{ id: 1 }, { id: 'x', evidence: 'y' }] })?.failing.length === 1)
  check('decode preflight: non-object ⇒ null', decodePreflightSummary('x') === null && decodePreflightSummary(null) === null)
  // The caution-driving rows persist and decode; a older-format
  // artifact (no degraded field) decodes to [] rather than refusing.
  const withDegraded = decodePreflightSummary({
    via: 'preflight', verdict: 'caution', ranAt: iso(0), failing: [],
    degraded: [{ id: 'gate', status: 'stale', evidence: 'verdict predates HEAD' }, { id: 'bad', status: 'nope', evidence: 'x' }],
    durationMs: 1,
  })
  check('decode preflight: degraded rows carried (invalid statuses dropped)', withDegraded !== null && withDegraded.degraded.length === 1 && withDegraded.degraded[0]!.id === 'gate' && withDegraded.degraded[0]!.status === 'stale')
  const olderFormat = decodePreflightSummary({ via: 'preflight', verdict: 'caution', ranAt: iso(0), failing: [], durationMs: 1 })
  check('decode preflight: older-format artifact (no degraded) ⇒ []', olderFormat !== null && olderFormat.degraded.length === 0)
}

if (failures > 0) {
  console.log(`\n❌ ${failures} core-contract check(s) failed`)
  process.exit(1)
}
console.log('\n✅ healthCertCore trust rules hold')

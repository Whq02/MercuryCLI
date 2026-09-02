#!/usr/bin/env bun
// prove-integrity-drift — the designed PAIR: exact SHA-256 + HMAC lockfile
// (catches the single-token edits Jaccard can't see) and token-set Jaccard
// drift (classifies the structural rewrites a SHA can only call "changed").
//
//   §1 enroll → verify ok; the key is machine-local and 0600.
//   §2 tampered ENROLLED FILE ⇒ 'mismatch' naming the path (single-token
//      edit — exactly drift's documented gap, caught here).
//   §3 tampered LOCKFILE bytes ⇒ 'hmac' refuse.
//   §4 missing enrolled file ⇒ 'mismatch' with missing named.
//   §5 drift classification: identical ⇒ low/J=1 · reworded ⇒ high ·
//      deleted ⇒ high/J=0 · thresholds honored · single-token edit stays
//      LOW for drift (the documented gap §2 covers).
//   §6 normalizeBody strips frontmatter + fences (legit churn excluded).
//   §7 approve re-stamps: after §2's tamper, themisApprove ⇒ verify ok.
//   §8 trust-state removal is NOISY: a corrupt drift store ⇒ synthetic HIGH
//      row (never a silent []); a half-deleted lock/drift PAIR ⇒ boot
//      problem both directions (lock writes both in one act).
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// Config-home isolation: the HMAC key must never touch the real ~/.mercury.
const configHome = mkdtempSync(join(tmpdir(), 'themis-cfg-'))
process.env.MERCURY_CONFIG_DIR = configHome
process.env.MERCURY_THEMIS = 'warn'

const { enrollLockfile, lockfilePath, verifyLockfile } = await import('../../src/substrate/themis/integrity.ts')
const { checkDriftBaselines, classifyDrift, driftStorePath, enrollDriftBaselines, jaccard, normalizeBody, tokenSet } =
  await import('../../src/substrate/themis/drift.ts')
const { themisApprove, themisBootVerify } = await import('../../src/substrate/themis/boot.ts')
const { resetAuditChainForTests } = await import('../../src/substrate/themis/auditChain.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const repo = mkdtempSync(join(tmpdir(), 'themis-repo-'))
process.chdir(repo)
resetAuditChainForTests()
mkdirSync(join(repo, '.mercury'), { recursive: true })
writeFileSync(join(repo, 'MERCURY.md'), '# Rules\n\nAlways verify before claiming done. The gate is the law.\n')
writeFileSync(join(repo, '.mercury', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2))

section('§1 enroll → verify ok · key hygiene')
{
  const r = await enrollLockfile(['MERCURY.md', '.mercury/settings.json'], repo)
  check('enrolled both', r.enrolled.length === 2, r.enrolled.join(','))
  const v = await verifyLockfile(repo)
  check('verifies ok', v.ok && v.checked === 2, JSON.stringify(v))
  const keyStat = statSync(join(configHome, 'themis.key'))
  check('key exists in ISOLATED config home', keyStat.isFile())
  check('key mode 0600', (keyStat.mode & 0o777) === 0o600, (keyStat.mode & 0o777).toString(8))
}

section('§2 tampered enrolled file ⇒ mismatch (the single-token edit)')
{
  // One token flipped — Jaccard would read ≈1.0; the SHA catches it.
  writeFileSync(join(repo, 'MERCURY.md'), '# Rules\n\nNever verify before claiming done. The gate is the law.\n')
  const v = await verifyLockfile(repo)
  check('mismatch verdict', !v.ok && v.kind === 'mismatch', JSON.stringify(v))
  check('names MERCURY.md', !v.ok && v.kind === 'mismatch' && v.mismatched.includes('MERCURY.md'))
}

section('§3 tampered lockfile bytes ⇒ HMAC refuse')
{
  const p = lockfilePath(repo)
  const lock = JSON.parse(readFileSync(p, 'utf8')) as { files: Record<string, { sha256: string; bytes: number }> }
  // The forger recomputes the file digest but cannot re-stamp without the key.
  lock.files['MERCURY.md'] = { sha256: 'a'.repeat(64), bytes: 1 }
  writeFileSync(p, JSON.stringify(lock, null, 1), 'utf8')
  const v = await verifyLockfile(repo)
  check('hmac refuse', !v.ok && v.kind === 'hmac', JSON.stringify(v))
}

section('§4 missing enrolled file ⇒ mismatch with missing named')
{
  await enrollLockfile(['MERCURY.md', '.mercury/settings.json'], repo) // re-stamp clean
  unlinkSync(join(repo, '.mercury', 'settings.json'))
  const v = await verifyLockfile(repo)
  check('missing named', !v.ok && v.kind === 'mismatch' && v.missing.includes('.mercury/settings.json'), JSON.stringify(v))
  writeFileSync(join(repo, '.mercury', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2))
}

section('§5 drift classification (operating defaults, documented)')
{
  const prose = (body: string): string => `# Doc\n\n${body}\n`
  writeFileSync(join(repo, 'PROSE.md'), prose('the quick brown fox jumps over the lazy dog and keeps the repo tidy'))
  await enrollDriftBaselines(['PROSE.md'], repo)
  let reports = await checkDriftBaselines(repo)
  check('identical ⇒ J=1 low', reports[0]!.jaccard === 1 && reports[0]!.severity === 'low', JSON.stringify(reports[0]))

  writeFileSync(join(repo, 'PROSE.md'), prose('completely different injected content replacing every original instruction wholesale tonight'))
  reports = await checkDriftBaselines(repo)
  check('rewrite ⇒ high', reports[0]!.severity === 'high', JSON.stringify(reports[0]))

  unlinkSync(join(repo, 'PROSE.md'))
  reports = await checkDriftBaselines(repo)
  check('deleted ⇒ J=0 high', reports[0]!.jaccard === 0 && reports[0]!.severity === 'high')

  check('thresholds: 0.80 low · 0.79 medium · 0.59 high',
    classifyDrift(0.8) === 'low' && classifyDrift(0.79) === 'medium' && classifyDrift(0.59) === 'high')

  // The documented gap, honestly held: one token flipped in 12 ⇒ J≈0.85 ⇒ LOW.
  const a = tokenSet('the quick brown fox jumps over the lazy dog and keeps tidy')
  const b = tokenSet('the quick brown fox jumps over the lazy cat and keeps tidy')
  const j = jaccard(a, b)
  check('single-token edit stays LOW for drift (SHA’s job, §2)', classifyDrift(j) === 'low', `J=${j.toFixed(3)}`)
}

section('§6 normalizeBody excludes legit churn')
{
  const doc = '---\ntitle: x\n---\nProse line.\n\n```js\nconst code = 1\n```\nMore prose.\n'
  const n = normalizeBody(doc)
  check('frontmatter stripped', !n.includes('title: x'))
  check('fence stripped', !n.includes('const code'))
  check('prose kept', n.includes('Prose line.') && n.includes('More prose.'))
}

section('§7 approve re-stamps to current content')
{
  writeFileSync(join(repo, 'MERCURY.md'), '# Rules v2\n\nOperator reviewed this change.\n')
  const before = await verifyLockfile(repo)
  check('drifted before approve', !before.ok)
  const r = await themisApprove(repo)
  check('approve re-enrolled the PRIOR key set', r.lockPaths.length === 2, r.lockPaths.join(','))
  const after = await verifyLockfile(repo)
  check('verifies after approve', after.ok, JSON.stringify(after))
}

section('§8 trust-state removal is NOISY, never silent')
{
  // Corrupt store ⇒ synthetic HIGH row, not [] (which would read as
  // "nothing enrolled" and silently disable the whole drift layer).
  writeFileSync(driftStorePath(repo), 'not-json{', 'utf8')
  let reports = await checkDriftBaselines(repo)
  check(
    'corrupt store ⇒ synthetic HIGH row',
    reports.length === 1 && reports[0]!.severity === 'high' && reports[0]!.path === '<drift-store corrupt>',
    JSON.stringify(reports),
  )
  // A malformed baseline row (non-array tokens) is the same class: HIGH,
  // named, and never a TypeError out of the checker.
  writeFileSync(driftStorePath(repo), JSON.stringify({ version: 1, updatedAt: 'x', baselines: { 'PROSE.md': 'not-an-array' } }), 'utf8')
  reports = await checkDriftBaselines(repo)
  check(
    'non-array baseline ⇒ HIGH named path',
    reports.length === 1 && reports[0]!.severity === 'high' && reports[0]!.path === 'PROSE.md',
    JSON.stringify(reports),
  )
  // Pairing: `themis lock` writes BOTH stores in one act, so a half-present
  // pair means removal, not never-enrolled — boot flags both directions.
  unlinkSync(driftStorePath(repo))
  let boot = await themisBootVerify(repo)
  check(
    'boot flags missing drift store while lockfile enrolled',
    boot.problems.some(p => p.includes('drift baselines store missing')),
    JSON.stringify(boot.problems),
  )
  await enrollDriftBaselines(['PROSE.md'], repo) // store back (empty — PROSE.md is absent)
  unlinkSync(lockfilePath(repo))
  boot = await themisBootVerify(repo)
  check(
    'boot flags missing lockfile while drift store present',
    boot.problems.some(p => p.includes('lockfile missing')),
    JSON.stringify(boot.problems),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} INTEGRITY/DRIFT PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL INTEGRITY/DRIFT PROOFS PASS')

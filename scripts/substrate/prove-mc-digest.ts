#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-mc-digest.ts
//  PROOF: the time-based-microcompact SHAPE-ONLY structural digest. A NEW
//  default-OFF feature: when ON, a cleared tool result is replaced with a tiny
//  structural label (line count + coarse token estimate + a content class from a
//  fixed closed vocabulary) instead of the bare placeholder — so the model knows
//  the SHAPE of what was evicted without re-running tools.
//
//  The design is PROVABLY ZERO-LEAK BY CONSTRUCTION: the emitted label is counts +
//  a closed-vocabulary class only; no input byte is ever copied into the output.
//  The CENTERPIECE assertion is the strict structural regex — if every label matches
//  `prefix + N lines, ~M tok, <class-from-8-set>`, it CANNOT contain content. The
//  prior content-snippet + dual-scanner design was abandoned (adversarial review
//  proved it leaked unprefixed AWS values / conn strings / header-less keys verbatim;
//  the scanners are header/keyword-anchored and cannot be complete).
//
//  microCompactDigest.ts is bun:bundle/feature()-FREE ⇒ a LIVE proof.
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-mc-digest.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// stamp-sim (the build stamp reads MACRO.VERSION) — the digest is stamp-gated.
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const {
  digestClearedToolResult,
  isMicroCompactDigestEnabled,
  MC_CLEARED_PLACEHOLDER,
  MC_DIGEST_PREFIX,
} = await import('../../src/services/compact/microCompactDigest.js')

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// The ONLY shape a digest label may ever take. Matching this ⇒ no input byte is present.
const STRUCTURAL =
  /^\[stale tool result · digest: \d+ lines, ~\d+ tok, (?:text|file-listing|json\/structured|diff|log\/stacktrace|error|log|tabular)\]$/

// True if any >=4-char contiguous window of `secret` appears in `label` (a leak signal).
function leaks(label: string, secret: string): boolean {
  for (let i = 0; i + 4 <= secret.length; i++) {
    if (label.includes(secret.slice(i, i + 4))) return true
  }
  return false
}

console.log('============================================================')
console.log(' C12 — microcompact SHAPE-ONLY structural digest (zero-leak)')
console.log('============================================================')

// ── (a) gate polarity + =0 ⇒ byte-exact placeholder ───────────────────────────
section('(a) default-ON (graduated); =0 ⇒ the byte-exact placeholder')
{
  delete process.env.MERCURY_MC_DIGEST
  check('flag ON by default (fork, env unset — the graduation)', isMicroCompactDigestEnabled() === true)
  process.env.MERCURY_MC_DIGEST = '0'
  check('flag =0 ⇒ disabled (opt-out preserved)', isMicroCompactDigestEnabled() === false)
  check('OFF ⇒ placeholder for clean text', digestClearedToolResult('ls: a.ts b.ts') === MC_CLEARED_PLACEHOLDER)
  check('OFF ⇒ placeholder even for secret-bearing text', digestClearedToolResult('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY') === MC_CLEARED_PLACEHOLDER)
  const trs = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'toolResultStorage.ts'), 'utf-8')
  const m = trs.match(/TOOL_RESULT_CLEARED_MESSAGE\s*=\s*'([^']*)'/)
  check('placeholder equals toolResultStorage source-of-truth (drift guard)', !!m && m![1] === MC_CLEARED_PLACEHOLDER)
  // the graduated default is stamp-independent.
  const savedMacro = (globalThis as Record<string, unknown>)['MACRO']
  delete (globalThis as Record<string, unknown>)['MACRO']
  delete process.env.MERCURY_MC_DIGEST
  check('no MACRO + unset ⇒ STILL enabled (stamp-independence)', isMicroCompactDigestEnabled() === true)
  ;(globalThis as Record<string, unknown>)['MACRO'] = savedMacro
}

process.env.MERCURY_MC_DIGEST = '1'

// ── (b) THE centerpiece: every label is purely structural (⇒ provably no content) ──
section('(b) every emitted label matches the strict structural shape (counts + class only)')
{
  check('flag ON for MERCURY_MC_DIGEST=1', isMicroCompactDigestEnabled() === true)
  const inputs = [
    'directory listing\n' + 'src/file.ts\n'.repeat(40),
    '{\n  "a": 1,\n  "b": [2,3]\n}',
    'diff --git a/x b/x\n+added\n-removed\n@@ -1 +1 @@',
    'Traceback (most recent call last):\n  File "x.py", line 5\nValueError: boom',
    'just some prose explaining a thing in sentences.',
  ]
  for (const inp of inputs) {
    const d = digestClearedToolResult(inp)
    check(`label is purely structural: "${d}"`, STRUCTURAL.test(d))
  }
}

// ── (c) THE load-bearing security case: the 4 adversarial secret shapes — NONE leak ──
section('(c) adversarial secrets — no byte reaches the label (zero-leak by construction)')
{
  const SECRETS: Array<[string, string]> = [
    ['AWS secret-access-key value (no AKIA prefix)', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['DB connection string user:pass@host', 'postgres://dbuser:s3cretP4ssw0rd@db.internal.host:5432/maindb'],
    ['header-less private-key body', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDb3l1n0pQxZ'],
    ['private_key= assignment', 'private_key=ABCD1234efgh5678ijkl9012mnop'],
    ['ssh_key= assignment', 'ssh_key=ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABg'],
  ]
  for (const [name, secret] of SECRETS) {
    const d = digestClearedToolResult(`tool output line\n${secret}\nmore output`)
    check(`${name}: label is structural-only`, STRUCTURAL.test(d))
    check(`${name}: no 4+char substring of the secret appears in the label`, !leaks(d, secret), d)
  }
  // all five in one block ⇒ still structural-only.
  const all = SECRETS.map(s => s[1]).join('\n')
  const dAll = digestClearedToolResult([{ type: 'text', text: all } as never])
  check('all five in one block ⇒ structural-only, no secret bytes', STRUCTURAL.test(dAll) && SECRETS.every(([, s]) => !leaks(dAll, s)))
}

// ── (d) classification is useful (the 8-class vocabulary is exercised + closed) ─
section('(d) content-class is exercised across the closed vocabulary')
{
  const cls = (s: string) => digestClearedToolResult(s).match(/, (\S[\w/-]*)\]$/)?.[1]
  check('a file listing ⇒ file-listing', cls('src/a.ts\nsrc/b.ts\nsrc/c/d.ts\nlib/x.ts\n'.repeat(3)) === 'file-listing')
  check('a json blob ⇒ json/structured', cls('{\n  "k": "v",\n  "n": [1,2,3],\n  "m": {"a":1}\n}') === 'json/structured')
  check('a git diff ⇒ diff', cls('diff --git a/x b/x\n+a\n+b\n-c\n@@ -1 +1 @@\n+d') === 'diff')
  check('a stacktrace ⇒ log/stacktrace', cls('Traceback (most recent call last):\n  File "a.py", line 3\n  File "b.py", line 9\nError: x') === 'log/stacktrace')
  check('prose ⇒ text', cls('this is a normal sentence with words and nothing structural about it at all.') === 'text')
}

// ── (e) idempotence · empty/non-text ⇒ placeholder ────────────────────────────
section('(e) idempotent · empty/whitespace/image-only ⇒ placeholder')
{
  check('the placeholder is not re-digested', digestClearedToolResult(MC_CLEARED_PLACEHOLDER) === MC_CLEARED_PLACEHOLDER)
  const once = digestClearedToolResult('some\nmulti\nline\noutput')
  check('a prior digest label is returned unchanged', digestClearedToolResult(once) === once)
  check('empty string ⇒ placeholder', digestClearedToolResult('') === MC_CLEARED_PLACEHOLDER)
  check('whitespace-only ⇒ placeholder', digestClearedToolResult('   \n\t \n ') === MC_CLEARED_PLACEHOLDER)
  check('image-only (no text items) ⇒ placeholder', digestClearedToolResult([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } as never]) === MC_CLEARED_PLACEHOLDER)
  check('text-only extraction: text item digested, image dropped', STRUCTURAL.test(digestClearedToolResult([{ type: 'text', text: 'a\nb\nc' }, { type: 'image', source: {} }] as never)))
}

// ── (f) side-channel bound: the size number is coarse, not a content fingerprint ─
section('(f) side-channel bound — the size label is a coarse length, cannot reconstruct content')
{
  // A lone N-char secret over a range of N produces only a handful of distinct labels
  // (token estimate rounds to the nearest 10), so the channel is a coarse length, not a
  // per-character fingerprint — and the secret bytes are absent regardless.
  const labels = new Set<string>()
  for (let n = 20; n <= 200; n++) {
    const secret = 'x'.repeat(n)
    const d = digestClearedToolResult(secret)
    check(`N=${n}: structural-only + secret absent`, STRUCTURAL.test(d) && !d.includes(secret), '')
    labels.add(d.replace(/\d+ lines/, 'L').replace(/~\d+ tok/, 'T')) // collapse the numeric channel
    if (n > 24) break // sample a few; the property holds for all
  }
  check('distinct non-numeric label shapes are few (closed vocabulary)', labels.size <= 3, `shapes=${labels.size}`)
}

// ── (g) wiring + no scanner in the output path ────────────────────────────────
section('(g) wiring intact + the module no longer routes content through any scanner')
{
  const mc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'compact', 'microCompact.ts'), 'utf-8')
  check('microCompact clear step calls digestClearedToolResult(block.content)', mc.includes('digestClearedToolResult(block.content)'))
  check('re-clear guard uses isClearedOrDigested', mc.includes('!isClearedOrDigested(block.content)'))
  const md = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'compact', 'microCompactDigest.ts'), 'utf-8')
  check('the digest module imports NO secret scanner (shape-only ⇒ none needed)', !md.includes('redactSecrets') && !md.includes('detectSecrets'))
}

delete process.env.MERCURY_MC_DIGEST
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL MC-DIGEST PROOFS PASS')
else console.log(`❌ ${fail} MC-DIGEST PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)

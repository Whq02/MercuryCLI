#!/usr/bin/env bun
// ============================================================================
//  scripts/hooks/prove-ssrf-v6-spellings.ts — the HTTP-hook SSRF guard
//  blocks EVERY IPv6 spelling of an internal target (FC-147). The mapped
//  (::ffff:) family was expanded and judged; four sibling spellings of the
//  same or equivalent targets sailed through: the IPv4-COMPATIBLE form
//  (::a.b.c.d), 6to4 (2002:V4::/48), the NAT64 well-known prefix
//  (64:ff9b::/96), and the deprecated-but-answering site-local band
//  (fec0::/10). The module's own header argues a narrow check "is a real
//  bypass, not a theoretical one" — the same argument for these four.
//
//  Run: ~/.bun/bin/bun run scripts/hooks/prove-ssrf-v6-spellings.ts
// ============================================================================
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { isBlockedAddress } = await import('../../src/utils/hooks/ssrfGuard.ts')

console.log('§1 the standing blocks (controls)')
for (const addr of ['169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fe80::1', 'fc00::1']) {
  check(`${addr} blocked`, isBlockedAddress(addr) === true)
}

console.log('§2 the four spellings (FC-147)')
check('::169.254.169.254 (IPv4-compatible) blocked', isBlockedAddress('::169.254.169.254') === true)
check('2002:a9fe:a9fe:: (6to4 of 169.254.169.254) blocked', isBlockedAddress('2002:a9fe:a9fe::') === true)
check('64:ff9b::169.254.169.254 (NAT64) blocked', isBlockedAddress('64:ff9b::169.254.169.254') === true)
check('fec0::1 (site-local) blocked', isBlockedAddress('fec0::1') === true)

console.log('§3 the allows stand (never over-blocked)')
check('::1 keeps its DOCUMENTED loopback allow', isBlockedAddress('::1') === false)
check('a public v4 stays allowed', isBlockedAddress('93.184.216.34') === false)
check('a public v6 stays allowed', isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946') === false)
check('a public 6to4 (embedding a PUBLIC v4) stays allowed', isBlockedAddress('2002:5db8:d822::') === false)
check('a public NAT64 (embedding a PUBLIC v4) stays allowed', isBlockedAddress('64:ff9b::93.184.216.34') === false)

console.log(failures === 0 ? '\nprove-ssrf-v6-spellings: all green' : `\nprove-ssrf-v6-spellings: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

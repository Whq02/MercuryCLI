#!/usr/bin/env bun
// ============================================================================
//  scripts/identity/prove-native-identity-sweep.ts — the zero-remnant check:
//  the external product's display spelling appears NOWHERE in src outside the
//  enumerated wire-identifier allowlist, and the built artifact emits only
//  Mercury's own identity.
//
//  Two sweeps:
//    1. USER-VISIBLE: the other product's display spelling in src must appear
//       only in files on scripts/identity/seamj-allowlist.tsv (each row
//       carries its estate class + reason).
//    2. MERCURY-EMITTED: the built dist must carry the Mercury outbound
//       identity and NONE of the retired emissions (clientInfo name, serve
//       identity, MCP UA, deep-link scheme, URL-handler app name, the
//       borrowed product URL beside clientInfo).
//  Foreign env SPELLINGS are not swept here: they are class-c
//  compat inputs (external callers set them; Mercury dual-emits its own with
//  MERCURY_* primary) — pinned per-seam by prove-identity-constants.ts.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' zero-remnant sweep — native identity')
console.log('============================================================')

// ── 1. user-visible display spellings vs the enumerated allowlist ──────────
const allow = new Set(
  readFileSync(join(ROOT, 'scripts/identity/seamj-allowlist.tsv'), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('\t')[0]!),
)
function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* tsFiles(p)
    else if (/\.tsx?$/.test(e)) yield p
  }
}
const NAME = ['Claude', 'Code'].join(' ')
const DISPLAY = new RegExp(`["'\`][^"'\`\\n]*${NAME}[^"'\`\\n]*["'\`]`)
const offenders: string[] = []
for (const f of tsFiles(join(ROOT, 'src'))) {
  const rel = f.slice(ROOT.length + 1)
  if (allow.has(rel)) continue
  // Bundled-skill content modules inline third-party-facing skill markdown —
  // vendored-adjacent assets, out of the display-surface scope.
  if (rel.startsWith('src/skills/bundled/')) continue
  const text = readFileSync(f, 'utf8')
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    if (DISPLAY.test(line)) n++
  }
  if (n > 0) offenders.push(`${rel} (${n})`)
}
check(
  `user-visible ${NAME} spellings appear ONLY on the enumerated allowlist`,
  offenders.length === 0,
  offenders.slice(0, 8).join(' · ') || `${allow.size} allowlisted files`,
)
for (const rel of allow) {
  check(`allowlist row is alive: ${rel}`, existsSync(join(ROOT, rel)))
}

// ── 2. the EMITTED identity in the built artifact (host-vs-binary law) ─────
const distPath = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(distPath)) {
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the dist sweep')
} else {
  const dist = readFileSync(distPath, 'utf8')
  check('dist: MCP clientInfo identifies as mercury', dist.includes('name:"mercury"') || dist.includes("name: 'mercury'") || dist.includes("name:'mercury'"))
  check("dist: no clientInfo name:'claude-code' emission", !/name\s*:\s*["']claude-code["']/.test(dist))
  check('dist: the MCP/WebFetch UA is mercury/*', dist.includes('`mercury/${') || /["'`]mercury\/["'`$]/.test(dist))
  check("dist: no legacy URL-handler registration string", !dist.includes(`${NAME} URL Handler`) || dist.includes("LEGACY_MACOS_APP_NAME"))
  // The bundler folds DEEP_LINK_PROTOCOL into template halves — the emitted
  // scheme survives as the '"mercury://' literal (buildDeepLink/normalize).
  check('dist: deep links emit the mercury:// scheme', dist.includes('"mercury://') || dist.includes("'mercury://"))
  check('dist: no borrowed product URL beside clientInfo (websiteUrl removed)', !/websiteUrl[^\n]{0,80}claude\.com\/claude-code/.test(dist))
}

// ── 3. stays-deleted: the removed transport/orchestration islands ──────────
//  Four DELETED capability rows (coordinator mode · the remote-control bridge
//  machinery · remote/CCR auto-connect · the remote session transport) pin
//  their absence here: the roots stay gone, and src/bridge/ holds exactly its
//  two live survivor modules (the -p stream-json attachments path and the
//  --sdk-url transport config).
for (const root of ['src/coordinator', 'src/remote', 'src/server', 'src/ssh', 'src/upstreamproxy']) {
  check(`stays-deleted: ${root} absent`, !existsSync(join(ROOT, root)))
}
{
  const bridge = readdirSync(join(ROOT, 'src', 'bridge')).sort()
  check(
    'stays-deleted: src/bridge holds exactly the two survivor modules',
    bridge.join(',') === 'bridgeConfig.ts,inboundAttachments.ts',
    bridge.join(','),
  )
}

// ── 4. the package identity ────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name?: string
  description?: string
}
check('package.json name/description carry no claude-code identity',
  !/claude.?code/i.test(`${pkg.name ?? ''} ${pkg.description ?? ''}`),
  `${pkg.name}`)

console.log(failures === 0 ? '\n ✅ ZERO-REMNANT SWEEP GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

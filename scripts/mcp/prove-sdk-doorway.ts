#!/usr/bin/env bun
// ============================================================================
//  scripts/mcp/prove-sdk-doorway.ts — the SDK doorway ratchet.
//
//  src/services/mcp/sdk.ts is the ONE static doorway to
//  @modelcontextprotocol/sdk. This proof pins, by a source walk of src:
//    (a) NO direct static `import … from '@modelcontextprotocol/sdk/…'` (nor a
//        side-effect import, an `export … from`, or a require) anywhere under
//        src outside the doorway — a planted one reds;
//    (b) dynamic `import('@modelcontextprotocol/sdk/…')` sites are EXACTLY
//        the recorded lazy set (coordinationServer.ts → server/mcp.js, lazy
//        by design: a static re-export would make the server SDK an eager
//        edge of every process) — an extra site reds, and so does a vanished
//        one (the exemption row is removed deliberately, with the site);
//    (c) the doorway is re-export lines ONLY — every statement is an
//        `export { … } from` / `export type { … } from` of an SDK subpath;
//        a wrapper function, a const, a class, an import, an `export *`, a
//        rename (`as`) reds;
//    (d) the doorway's surface == THE CENSUS below (subpath · name · kind),
//        exactly — an extra or a missing name reds; a change to the surface
//        is a deliberate edit to the census in the same commit;
//    (e) every doorway name is consumed by at least one src file THROUGH the
//        doorway (no dead re-export) and every name a consumer takes from
//        the doorway exists in it; consumers address the doorway by name
//        only (no default / namespace import).
//
//  Run:  ~/.bun/bin/bun run scripts/mcp/prove-sdk-doorway.ts
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const DOORWAY = 'src/services/mcp/sdk.ts'
const PKG = '@modelcontextprotocol/sdk'

// THE CENSUS — the doorway's surface at the doorway's landing (the
// import inventory: 38 static statements over 11 subpaths, 59
// names). Adding or removing an SDK dependency is a DELIBERATE change:
// update this table in the same commit.
const CENSUS: Record<string, { values: string[]; types: string[] }> = {
  'client/index.js': { values: ['Client'], types: [] },
  'client/auth.js': {
    values: [
      'auth',
      'discoverAuthorizationServerMetadata',
      'discoverOAuthProtectedResourceMetadata',
      'discoverOAuthServerInfo',
      'exchangeAuthorization',
      'refreshAuthorization',
      'startAuthorization',
      'UnauthorizedError',
    ],
    types: ['AuthResult', 'OAuthClientProvider'],
  },
  'client/sse.js': { values: ['SSEClientTransport'], types: [] },
  'client/stdio.js': { values: ['StdioClientTransport'], types: [] },
  'client/streamableHttp.js': { values: ['StreamableHTTPClientTransport'], types: [] },
  'server/index.js': { values: ['Server'], types: [] },
  'server/stdio.js': { values: ['StdioServerTransport'], types: [] },
  'server/auth/errors.js': {
    values: [
      'InvalidClientError',
      'InvalidGrantError',
      'OAuthError',
      'ServerError',
      'TemporarilyUnavailableError',
      'TooManyRequestsError',
    ],
    types: [],
  },
  'shared/auth.js': {
    values: ['OAuthErrorResponseSchema', 'OAuthMetadataSchema', 'OAuthTokensSchema', 'OpenIdProviderMetadataSchema'],
    types: ['AuthorizationServerMetadata', 'OAuthClientInformationMixed', 'OAuthClientMetadata', 'OAuthTokens'],
  },
  'shared/transport.js': { values: [], types: ['Transport'] },
  'types.js': {
    values: [
      'CallToolRequestSchema',
      'CallToolResultSchema',
      'ElicitationCompleteNotificationSchema',
      'ElicitRequestSchema',
      'ErrorCode',
      'GetPromptResultSchema',
      'LATEST_PROTOCOL_VERSION',
      'ListPromptsResultSchema',
      'ListResourcesResultSchema',
      'ListRootsRequestSchema',
      'ListToolsRequestSchema',
      'ListToolsResultSchema',
      'McpError',
      'ProgressNotificationSchema',
      'PromptListChangedNotificationSchema',
      'ReadResourceResultSchema',
      'ResourceListChangedNotificationSchema',
      'ToolListChangedNotificationSchema',
    ],
    types: [
      'CallToolResult',
      'ElicitResult',
      'Implementation',
      'JSONRPCMessage',
      'PrimitiveSchemaDefinition',
      'ReadResourceResult',
      'Resource',
      'ServerCapabilities',
      'Tool',
      'ToolAnnotations',
    ],
  },
}

// The recorded lazy sites: direct DYNAMIC imports of the SDK that stay
// outside the doorway on purpose. Exactly this set may exist.
const LAZY_SITES: ReadonlyArray<{ file: string; subpath: string; reason: string }> = [
  {
    file: 'src/services/mcp/coordinationServer.ts',
    subpath: 'server/mcp.js',
    reason: 'the coordination server SDK loads only when the server is enabled+connected',
  },
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const rel = (abs: string): string => relative(ROOT, abs).split(sep).join('/')

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/[.]tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}
const files = walk(SRC).sort()
const texts = new Map<string, string>(files.map(f => [rel(f), readFileSync(f, 'utf8')]))
const doorwayText = texts.get(DOORWAY)

console.log('============================================================')
console.log(' SDK doorway — one static door · pinned surface · no wrappers')
console.log('============================================================')
console.log(`  src files walked: ${files.length}`)

// ---------------------------------------------------------------------------
section('(a) no direct static SDK import outside the doorway')
{
  const STATIC = new RegExp(
    '(?:\\b(?:import|export)\\b[^;\'"]*?\\bfrom\\s*|\\bimport\\s*|\\brequire\\s*[(]\\s*)[\'"]' +
      PKG.replace('/', '[/]') +
      '(?:[/][^\'"]*)?[\'"]',
    'g',
  )
  const offenders: string[] = []
  for (const [file, text] of texts) {
    if (file === DOORWAY) continue
    for (const m of text.matchAll(STATIC)) {
      const line = text.slice(0, m.index).split('\n').length
      offenders.push(`${file}:${line} ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  check('the doorway exists', doorwayText !== undefined, DOORWAY)
  check('zero direct static SDK imports outside the doorway', offenders.length === 0, offenders.join(' · '))
}

// ---------------------------------------------------------------------------
section('(b) dynamic SDK imports are exactly the recorded lazy sites')
{
  const DYNAMIC = new RegExp('\\bimport\\s*[(]\\s*[\'"]' + PKG.replace('/', '[/]') + '[/]([^\'"]+)[\'"]\\s*[)]', 'g')
  const found = new Set<string>()
  for (const [file, text] of texts) {
    if (file === DOORWAY) continue
    for (const m of text.matchAll(DYNAMIC)) found.add(`${file} → ${m[1]}`)
  }
  const recorded = new Set(LAZY_SITES.map(s => `${s.file} → ${s.subpath}`))
  const extra = [...found].filter(k => !recorded.has(k))
  const vanished = [...recorded].filter(k => !found.has(k))
  check('no unrecorded dynamic SDK import site', extra.length === 0, extra.join(' · '))
  check('every recorded lazy site still exists (retire the row with the site)', vanished.length === 0, vanished.join(' · '))
  for (const s of LAZY_SITES) console.log(`    lazy: ${s.file} → ${s.subpath} (${s.reason})`)
}

// ---------------------------------------------------------------------------
section('(c) the doorway is re-export lines only')
const surface = new Map<string, { values: Set<string>; types: Set<string> }>()
{
  const stripped = (doorwayText ?? '')
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .replace(/^[ \t]*[/][/].*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const STMT = new RegExp(
    '^export (type )?[{] ?([^}]*?) ?[}] from \'' + PKG.replace('/', '[/]') + '[/]([^\']+)\'( ;)? ?',
  )
  let rest = stripped
  let statements = 0
  const badNames: string[] = []
  while (rest.length > 0) {
    const m = STMT.exec(rest)
    if (!m) break
    statements++
    const kind = m[1] ? 'types' : 'values'
    const subpath = m[3]
    const entry = surface.get(subpath) ?? { values: new Set<string>(), types: new Set<string>() }
    for (const raw of m[2].split(',')) {
      const name = raw.trim()
      if (!name) continue
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) badNames.push(`${subpath}: ${name}`)
      else entry[kind].add(name)
    }
    surface.set(subpath, entry)
    rest = rest.slice(m[0].length)
  }
  check(`every statement is an export-from of an SDK subpath (${statements} statements)`, rest.length === 0, `residue: ${rest.slice(0, 120)}`)
  check('no rename / inline type modifier inside a re-export list', badNames.length === 0, badNames.join(' · '))
  check('the doorway has no import, no function, no const, no class', statements > 0 && rest.length === 0)
}

// ---------------------------------------------------------------------------
section('(d) the doorway surface == the census')
const surfaceKeys = new Set<string>()
{
  const key = (sub: string, kind: string, name: string): string => `${sub} ${kind} ${name}`
  const censusKeys = new Set<string>()
  for (const [sub, e] of Object.entries(CENSUS)) {
    for (const n of e.values) censusKeys.add(key(sub, 'value', n))
    for (const n of e.types) censusKeys.add(key(sub, 'type', n))
  }
  for (const [sub, e] of surface) {
    for (const n of e.values) surfaceKeys.add(key(sub, 'value', n))
    for (const n of e.types) surfaceKeys.add(key(sub, 'type', n))
  }
  const extra = [...surfaceKeys].filter(k => !censusKeys.has(k))
  const missing = [...censusKeys].filter(k => !surfaceKeys.has(k))
  check(`the doorway exports nothing the census lacks (${surfaceKeys.size} names)`, extra.length === 0, extra.join(' · '))
  check(`the doorway exports everything the census records (${censusKeys.size} names)`, missing.length === 0, missing.join(' · '))
  const subpaths = [...surface.keys()].sort()
  check(`exactly the census subpaths (${subpaths.length})`, subpaths.join(',') === Object.keys(CENSUS).sort().join(','), subpaths.join(','))
  const dup = subpaths.filter(s => [...(surface.get(s)?.values ?? [])].some(n => surface.get(s)?.types.has(n)))
  check('no name is exported both as a value and as a type', dup.length === 0, dup.join(','))
}

// ---------------------------------------------------------------------------
section('(e) every doorway name is consumed through the doorway; consumers take only names it has')
{
  const doorwayAbs = resolve(ROOT, DOORWAY)
  const resolvesToDoorway = (fromFile: string, spec: string): boolean =>
    spec.startsWith('.') && resolve(ROOT, dirname(fromFile), spec).replace(/[.]js$/, '.ts') === doorwayAbs
  const consumed = new Map<string, Set<string>>()
  const take = (name: string, file: string): void => {
    const bare = name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()
    if (!bare) return
    const set = consumed.get(bare) ?? new Set<string>()
    set.add(file)
    consumed.set(bare, set)
  }
  // Brace captures exclude BOTH braces: `[^}]*` would run back from a
  // destructuring's `{` to an enclosing block's `{` and take `const {` as a name.
  const IMPORT = /\bimport\s+(type\s+)?[{]([^{}]*)[}]\s*from\s*['"]([^'"]+)['"]/g
  const DESTRUCTURE = /[{]([^{}]*)[}]\s*=\s*await\s+import\s*[(]\s*['"]([^'"]+)['"]\s*[)]/g
  const INLINE = /\bimport\s*[(]\s*['"]([^'"]+)['"]\s*[)]\s*[.]\s*([A-Za-z_$][\w$]*)/g
  const NONNAMED = /\bimport\s+(?:[*]\s+as\s+\w+|[A-Za-z_$][\w$]*)\s*(?:,\s*[{][^{}]*[}]\s*)?from\s*['"]([^'"]+)['"]/g
  const nonNamed: string[] = []
  for (const [file, text] of texts) {
    if (file === DOORWAY) continue
    for (const m of text.matchAll(IMPORT)) if (resolvesToDoorway(file, m[3]!)) for (const n of m[2]!.split(',')) take(n, file)
    for (const m of text.matchAll(DESTRUCTURE)) if (resolvesToDoorway(file, m[2]!)) for (const n of m[1]!.split(',')) take(n, file)
    for (const m of text.matchAll(INLINE)) if (resolvesToDoorway(file, m[1]!)) take(m[2]!, file)
    for (const m of text.matchAll(NONNAMED)) if (resolvesToDoorway(file, m[1]!)) nonNamed.push(file)
  }
  const surfaceNames = new Set([...surfaceKeys].map(k => k.split(' ')[2]!))
  const dead = [...surfaceNames].filter(n => !consumed.has(n))
  const unknown = [...consumed.keys()].filter(n => !surfaceNames.has(n))
  const consumerFiles = new Set([...consumed.values()].flatMap(s => [...s]))
  console.log(`  consumers: ${consumerFiles.size} files · ${consumed.size} distinct names taken`)
  check('at least one consumer takes each doorway name (no dead re-export)', dead.length === 0, dead.join(','))
  check('consumers take only names the doorway has', unknown.length === 0, unknown.join(','))
  check('consumers address the doorway by name (no default / namespace import)', nonNamed.length === 0, nonNamed.join(','))
  check('the doorway has consumers', consumerFiles.size > 0)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SDK DOORWAY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SDK DOORWAY FAILURE(S)`)
process.exit(1)

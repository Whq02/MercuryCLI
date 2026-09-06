#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const DOORWAY = 'src/services/mcp/sdk.ts'
const SCOPE = '@modelcontextprotocol'
const PACKAGES = ['client', 'core', 'server'] as const
const RETIRED = `${SCOPE}/sdk`

const CENSUS: Record<string, { values: string[]; types: string[] }> = {
  client: {
    values: [
      'Client',
      'LATEST_PROTOCOL_VERSION',
      'OAuthError',
      'OAuthErrorCode',
      'ProtocolError',
      'ProtocolErrorCode',
      'SSEClientTransport',
      'SdkError',
      'SdkErrorCode',
      'StreamableHTTPClientTransport',
      'UnauthorizedError',
      'auth',
      'discoverAuthorizationServerMetadata',
      'discoverOAuthServerInfo',
      'refreshAuthorization',
    ],
    types: [
      'AuthResult',
      'AuthorizationServerMetadata',
      'CallToolResult',
      'ElicitResult',
      'Implementation',
      'JSONRPCMessage',
      'ListToolsResult',
      'OAuthClientInformationMixed',
      'OAuthClientMetadata',
      'OAuthClientProvider',
      'OAuthTokens',
      'PrimitiveSchemaDefinition',
      'ProtocolEra',
      'ReadResourceResult',
      'Resource',
      'ServerCapabilities',
      'Tool',
      'ToolAnnotations',
      'Transport',
    ],
  },
  'client/stdio': { values: ['StdioClientTransport'], types: [] },
  core: {
    values: ['OAuthErrorResponseSchema', 'OAuthMetadataSchema', 'OAuthTokensSchema'],
    types: [],
  },
  server: { values: ['Server'], types: [] },
  'server/stdio': { values: ['serveStdio'], types: [] },
}

const LAZY_SITES: ReadonlyArray<{ file: string; specifier: string; reason: string }> = [
  {
    file: 'src/services/mcp/coordinationServer.ts',
    specifier: 'server',
    reason: 'the coordination server builds its SDK layer only when it is enabled and connected',
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

section('(a) no direct static SDK import outside the doorway; the retired name is gone')
{
  const STATIC = new RegExp(
    '(?:\\b(?:import|export)\\b[^;\'"]*?\\bfrom\\s*|\\bimport\\s*|\\brequire\\s*[(]\\s*)[\'"]' + SCOPE + '[/][^\'"]*[\'"]',
    'g',
  )
  const offenders: string[] = []
  const retired: string[] = []
  for (const [file, text] of texts) {
    if (text.includes(RETIRED)) retired.push(file)
    if (file === DOORWAY) continue
    for (const m of text.matchAll(STATIC)) {
      const line = text.slice(0, m.index).split('\n').length
      offenders.push(`${file}:${line} ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  check('the doorway exists', doorwayText !== undefined, DOORWAY)
  check('zero direct static SDK imports outside the doorway', offenders.length === 0, offenders.join(' · '))
  check(`the retired package name (${RETIRED}) appears nowhere under src`, retired.length === 0, retired.join(' · '))
}

section('(b) dynamic SDK imports are exactly the recorded lazy sites')
{
  const DYNAMIC = new RegExp('\\bimport\\s*[(]\\s*[\'"]' + SCOPE + '[/]([^\'"]+)[\'"]\\s*[)]', 'g')
  const found = new Set<string>()
  for (const [file, text] of texts) {
    if (file === DOORWAY) continue
    for (const m of text.matchAll(DYNAMIC)) found.add(`${file} → ${m[1]}`)
  }
  const recorded = new Set(LAZY_SITES.map(s => `${s.file} → ${s.specifier}`))
  const extra = [...found].filter(k => !recorded.has(k))
  const vanished = [...recorded].filter(k => !found.has(k))
  check('no unrecorded dynamic SDK import site', extra.length === 0, extra.join(' · '))
  check('every recorded lazy site still exists (retire the row with the site)', vanished.length === 0, vanished.join(' · '))
  for (const s of LAZY_SITES) console.log(`    lazy: ${s.file} → ${s.specifier} (${s.reason})`)
}

section('(c) the doorway is re-export lines only')
const surface = new Map<string, { values: Set<string>; types: Set<string> }>()
{
  const stripped = (doorwayText ?? '')
    .replace(/[/][*][\s\S]*?[*][/]/g, ' ')
    .replace(/^[ \t]*[/][/].*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const STMT = new RegExp('^export (type )?[{] ?([^}]*?) ?[}] from \'' + SCOPE + '[/]([^\']+)\'( ;)? ?')
  let rest = stripped
  let statements = 0
  const badNames: string[] = []
  const badSpecifiers: string[] = []
  while (rest.length > 0) {
    const m = STMT.exec(rest)
    if (!m) break
    statements++
    const kind = m[1] ? 'types' : 'values'
    const specifier = m[3]!
    const root = specifier.split('/')[0]!
    if (!(PACKAGES as readonly string[]).includes(root)) badSpecifiers.push(specifier)
    const entry = surface.get(specifier) ?? { values: new Set<string>(), types: new Set<string>() }
    for (const raw of m[2]!.split(',')) {
      const name = raw.trim()
      if (!name) continue
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) badNames.push(`${specifier}: ${name}`)
      else entry[kind].add(name)
    }
    surface.set(specifier, entry)
    rest = rest.slice(m[0].length)
  }
  check(`every statement is an export-from of an SDK package (${statements} statements)`, rest.length === 0, `residue: ${rest.slice(0, 120)}`)
  check('no rename / inline type modifier inside a re-export list', badNames.length === 0, badNames.join(' · '))
  check(`every specifier names one of the three packages (${PACKAGES.join(', ')})`, badSpecifiers.length === 0, badSpecifiers.join(' · '))
  check('the doorway has no import, no function, no const, no class', statements > 0 && rest.length === 0)
}

section('(d) the doorway surface == the census')
const surfaceKeys = new Set<string>()
{
  const key = (spec: string, kind: string, name: string): string => `${spec} ${kind} ${name}`
  const censusKeys = new Set<string>()
  for (const [spec, e] of Object.entries(CENSUS)) {
    for (const n of e.values) censusKeys.add(key(spec, 'value', n))
    for (const n of e.types) censusKeys.add(key(spec, 'type', n))
  }
  for (const [spec, e] of surface) {
    for (const n of e.values) surfaceKeys.add(key(spec, 'value', n))
    for (const n of e.types) surfaceKeys.add(key(spec, 'type', n))
  }
  const extra = [...surfaceKeys].filter(k => !censusKeys.has(k))
  const missing = [...censusKeys].filter(k => !surfaceKeys.has(k))
  check(`the doorway exports nothing the census lacks (${surfaceKeys.size} names)`, extra.length === 0, extra.join(' · '))
  check(`the doorway exports everything the census records (${censusKeys.size} names)`, missing.length === 0, missing.join(' · '))
  const specifiers = [...surface.keys()].sort()
  check(`exactly the census specifiers (${specifiers.length})`, specifiers.join(',') === Object.keys(CENSUS).sort().join(','), specifiers.join(','))
  const dup = specifiers.filter(s => [...(surface.get(s)?.values ?? [])].some(n => surface.get(s)?.types.has(n)))
  check('no name is exported both as a value and as a type', dup.length === 0, dup.join(','))
}

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

section('(f) the manifest names the three packages at one pinned version, not the retired one')
{
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}
  const versions = PACKAGES.map(p => deps[`${SCOPE}/${p}`])
  check(`every package is a dependency (${PACKAGES.join(', ')})`, versions.every(v => typeof v === 'string' && v.length > 0), versions.join(','))
  check('the three packages share one exact version (no range)', new Set(versions).size === 1 && /^\d+[.]\d+[.]\d+(-[\w.]+)?$/.test(versions[0] ?? ''), versions.join(','))
  check(`the retired package (${RETIRED}) is not a dependency`, deps[RETIRED] === undefined)
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SDK DOORWAY GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} SDK DOORWAY FAILURE(S)`)
process.exit(1)

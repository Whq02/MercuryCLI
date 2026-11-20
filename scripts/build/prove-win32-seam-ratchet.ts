#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { flowShellAsk } from '../../src/utils/permissions/flowLaw.ts'
import { refusalOfShellCommand } from '../../src/utils/wards/wardsRefusals.ts'
import { VastClient } from '../../src/services/host/vendors/vast.ts'
import { normalizePatternsToPath } from '../../src/utils/permissions/filesystem.ts'
import { parseRemotePath } from '../../src/services/remoteFiles/target.ts'
import { posixRelative } from '../../src/services/structure/scanPaths.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(import.meta.dir, 'win32-seam-baseline.json')

const TELLS: Array<[string, RegExp]> = [
  ['split-slash', /\.split\((?:'\/'|"\/")\)/g],
  ['kill-signal', /process\.kill\([^)]+,\s*['"]SIG/g],
]

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if ((p.endsWith('.ts') || p.endsWith('.tsx')) && e !== 'content.generated.ts') {
      out.push(p)
    }
  }
}

function measure(): Record<string, number> {
  const counts: Record<string, number> = {}
  const files: string[] = []
  walk(SRC, files)
  for (const abs of files) {
    const rel = relative(ROOT, abs).split('\\').join('/')
    const text = readFileSync(abs, 'utf8')
    for (const [tell, re] of TELLS) {
      const n = (text.match(re) ?? []).length
      if (n > 0) counts[`${rel} :: ${tell}`] = n
    }
  }
  return counts
}

const current = measure()

if (process.argv.includes('--relock')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + '\n')
  console.log(`relocked ${Object.keys(sorted).length} entries → ${BASELINE}`)
  process.exit(0)
}

let baseline: Record<string, number>
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>
} catch {
  console.log('  [FAIL] baseline missing — generate it: bun run prove-win32-seam-ratchet.ts --relock')
  process.exit(1)
}

console.log('============================================================')
console.log(' win32-seam ratchet — POSIX tells frozen per-file')
console.log('============================================================')

let failures = 0
const grew: string[] = []
let shrank = 0
for (const [key, n] of Object.entries(current)) {
  const base = baseline[key] ?? 0
  if (n > base) grew.push(`${key}  ${base} → ${n}`)
  else if (n < base) shrank++
}
for (const key of Object.keys(baseline)) {
  if (!(key in current) && baseline[key]! > 0) shrank++
}

if (grew.length > 0) {
  failures++
  console.log(`  [FAIL] POSIX tells INCREASED (branch on process.platform or use a normalized helper):`)
  for (const g of grew) console.log(`      - ${g}`)
} else {
  console.log(`  [PASS] no file gained a POSIX tell (${Object.keys(current).length} tracked)`)
}
if (shrank > 0) {
  console.log(`  [INFO] ${shrank} entr${shrank === 1 ? 'y' : 'ies'} improved — relock to ratchet down:`)
  console.log('         ~/.bun/bin/bun run scripts/build/prove-win32-seam-ratchet.ts --relock')
}

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const flowAsk = await flowShellAsk('npx @scope/vercel deploy', '/tmp/proj')
check('flowLaw splits scoped package names on slash grammar on every host', flowAsk?.item === 3 && flowAsk.subject === 'vercel deploy', JSON.stringify(flowAsk))

const wardVerdict = await refusalOfShellCommand({ toolName: 'Bash', input: { command: 'rm -rf /etc' }, shellCommand: 'rm -rf /etc' }, '/tmp/proj')
check('wardsRefusals splits POSIX shell paths on slash grammar on every host', wardVerdict.allow === false && wardVerdict.rule.name === 'no-root-recursive-delete', JSON.stringify(wardVerdict))

const origFetch = globalThis.fetch
let vastError = ''
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ success: true, result_url: 'https://evil.example/vast.ai/secret-token/out.log' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as never
try {
  await new VastClient('k').logs('42', new AbortController().signal)
} catch (error) {
  vastError = error instanceof Error ? error.message : String(error)
} finally {
  globalThis.fetch = origFetch
}
check('vast redacts unexpected log URL pathnames by slash segments on every host', vastError === 'unexpected log URL · https://evil.example/vast.ai/:segment/:file.log', vastError)

const belowGlobs = normalizePatternsToPath(new Map([['/repo/sub/dir', ['file.ts']]]), '/repo')
const aboveGlobs = normalizePatternsToPath(new Map([['/repo', ['sub/dir/file.ts']]]), '/repo/sub/dir')
check('filesystem permission rules normalize below and above roots using slash grammar', belowGlobs.includes('/sub/dir/file.ts') && aboveGlobs.includes('/file.ts'), JSON.stringify({ belowGlobs, aboveGlobs }))

const remote = parseRemotePath('ssh://host/a/./b//c')
check('remoteFiles parses remote paths on slash grammar on every host', remote?.path === '/a/b/c', JSON.stringify(remote))

const winRel = posixRelative('C:\\repo', 'C:\\repo\\src\\util.ts', 'win32')
check('scanPaths flips separators by the requested platform, never host path.sep', winRel === 'src/util.ts', winRel)

console.log(failures === 0 ? '\nALL WIN32-SEAM CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

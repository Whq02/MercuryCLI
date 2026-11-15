#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('signature notices — third-party inventory coverage')

const noticesPath = join(ROOT, 'THIRD_PARTY_NOTICES.md')
check('THIRD_PARTY_NOTICES.md exists', existsSync(noticesPath))
const notices = readFileSync(noticesPath, 'utf8')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  patchedDependencies?: Record<string, string>
}
const deps = new Set(Object.keys(pkg.dependencies ?? {}))

const listed = new Map<string, string>()
const section = notices.split('## Vendored tool payloads')[0]
for (const m of section.matchAll(/^- \*\*(.+?)\*\* (\S+)/gm)) listed.set(m[1], m[2])

const missing = [...deps].filter(d => !listed.has(d))
const extra = [...listed.keys()].filter(d => !deps.has(d))
check(`every runtime dependency listed (${deps.size})`, missing.length === 0, missing.join(', '))
check('no stale packages listed', extra.length === 0, extra.join(', '))

const versionDrift: string[] = []
for (const [name, version] of listed) {
  const p = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(p)) continue
  const installed = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version
  if (installed && installed !== version) versionDrift.push(`${name}: listed ${version}, installed ${installed}`)
}
check('no version drift vs installed metadata', versionDrift.length === 0, versionDrift.slice(0, 5).join('; '))

const patches = Object.entries(pkg.patchedDependencies ?? {})
const unsaid = patches.filter(([target, file]) => {
  const at = target.lastIndexOf('@')
  const line = section.split('\n').find(l => l.startsWith(`- **${target.slice(0, at)}** ${target.slice(at + 1)} `)) ?? ''
  if (!existsSync(join(ROOT, file)) || !line.includes(`modified from the published package by \`${file}\``)) return true
  const changed = [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]!)
  return changed.length === 0 || changed.some(name => !line.includes(`\`${name}\``))
})
check(`every package the manifest patches says so on its own line, naming the patch file and each file it changes (${patches.length})`, unsaid.length === 0, unsaid.map(([target, file]) => `${target} by ${file}`).join(', '))
const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
const adrift = patches.filter(([target, file]) => {
  const at = target.lastIndexOf('@')
  return pkg.dependencies?.[target.slice(0, at)] !== target.slice(at + 1) || !lock.includes(`"${target}": "${file}"`)
})
check('each patch is for the version the manifest pins, and the lockfile names the same file', adrift.length === 0, adrift.map(([target, file]) => `${target} by ${file}`).join(', '))
const strays = patches.flatMap(([, file]) =>
  existsSync(join(ROOT, file))
    ? [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].filter(m => m[1] !== m[2] || /(^|\/)\.bun-tag-/.test(m[2]!)).map(m => `${file}: ${m[1]}`)
    : [],
)
check('each patch changes files of its own package and holds no marker of the installer’s', strays.length === 0, strays.join(', '))

for (const vendor of ['ripgrep', 'debugpy', 'pyright', 'js-debug', 'TypeScript compiler', 'tree-sitter', 'tree-sitter-wasms', 'Node.js runtime', 'voice capture pack', 'shell engine pack', 'on-device transcriber pack', 'Whisper speech models']) {
  check(`vendor payload named: ${vendor}`, notices.includes(vendor))
}
{
  const glPath = join(ROOT, 'vendor', 'grammars.lock.json')
  if (existsSync(glPath)) {
    const gl = JSON.parse(readFileSync(glPath, 'utf8')) as {
      grammars?: Array<{ wasm: string; upstream?: { package?: string } }>
    }
    for (const g of gl.grammars ?? []) {
      const pkg = g.upstream?.package ?? ''
      check(`grammar upstream named: ${pkg || g.wasm}`, pkg !== '' && notices.includes(pkg))
    }
  }
}
check('Ink attribution recorded', /Ink.*project.*MIT|vadimdemedes\/ink/s.test(notices))
check('bundled-skills section present', notices.includes('src/skills/bundled'))

const gen = join(ROOT, 'scripts/distribution/generate-third-party-notices.ts')
check('generator present + names output', existsSync(gen) && readFileSync(gen, 'utf8').includes('THIRD_PARTY_NOTICES.md'))

const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
check('release packager copies the canonical notices', packager.includes('THIRD_PARTY_NOTICES.md'))
check('release packager writes the dry-run record', packager.includes('.dryrun.json'))

if (failures > 0) {
  console.log(`\nsignature notices: RED (${failures})`)
  process.exit(1)
}
console.log('\nsignature notices: green')

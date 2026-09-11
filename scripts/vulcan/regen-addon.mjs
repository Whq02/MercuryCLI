#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const addonRoot = join(repo, 'assets', 'vulcan', 'addon')
const outPath = join(repo, 'src', 'services', 'vulcan', 'addonFiles.generated.ts')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const KEEP_HASH = /^\s*#\s*(!|-\*-|gate-(class|watch|env|inputs):|shellcheck|type:|noqa|pragma|pylint|fmt:|ruff:|mypy:|flake8:)/
const LEADING_WHITESPACE = /^[ \t\r\n\x0b\x0c\x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

function withoutHashComments(text) {
  const lines = text.split('\n')
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const s = line.replace(LEADING_WHITESPACE, '')
    if (s.startsWith('#') && !(i === 0 && s.startsWith('#!')) && !KEEP_HASH.test(line)) continue
    kept.push(line)
  }
  let out = kept.join('\n').replace(/\n{4,}/g, '\n\n\n')
  if (out.endsWith('\n')) out = out.replace(/\n+$/, '\n')
  return out
}

function embeddedContent(p) {
  const text = readFileSync(p, 'utf8')
  return p.endsWith('.gd') ? withoutHashComments(text) : text
}

let files
try {
  files = walk(addonRoot)
    .map(p => ({ path: relative(addonRoot, p).split('\\').join('/'), content: embeddedContent(p) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
} catch {
  console.error(`regen-addon: no addon sources at ${addonRoot}`)
  process.exit(1)
}
if (files.length === 0) {
  console.error('regen-addon: addon dir is empty — nothing to embed')
  process.exit(1)
}

const h = createHash('sha256')
for (const f of files) h.update(f.path).update('\0').update(f.content).update('\0')
const digest = h.digest('hex')

const generated = `export interface VulcanAddonFile {
  path: string
  content: string
}

export const VULCAN_ADDON_DIGEST = '${digest}'

export const VULCAN_ADDON_FILES: readonly VulcanAddonFile[] = ${JSON.stringify(files, null, 2)}
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(outPath, 'utf8')
  } catch {
    console.error('regen-addon --check: generated module missing — run the regen')
    process.exit(1)
  }
  if (current !== generated) {
    console.error('regen-addon --check: DRIFT between assets/vulcan/addon/ and addonFiles.generated.ts — run: node scripts/vulcan/regen-addon.mjs')
    process.exit(1)
  }
  console.log(`regen-addon --check: clean (${files.length} files, digest ${digest.slice(0, 12)}…)`)
  process.exit(0)
}

writeFileSync(outPath, generated)
console.log(`regen-addon: wrote ${outPath} (${files.length} files, digest ${digest.slice(0, 12)}…)`)

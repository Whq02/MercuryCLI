#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const bridgeRoot = join(repo, 'assets', 'unity', 'bridge')
const outPath = join(repo, 'src', 'services', 'unity', 'bridgeFiles.generated.ts')

const KEEP_SLASH = /^\s*\/\/\s*(gate-(class|watch|env|inputs):|@ts-|eslint|prettier|#|<reference)/
function publishedSource(path, text) {
  if (!/\.cs$/.test(path)) return text
  const kept = text.split('\n').filter(line => !(line.trimStart().startsWith('//') && !KEEP_SLASH.test(line)))
  const tidy = kept.join('\n').replace(/\n{4,}/g, '\n\n\n')
  return tidy.endsWith('\n') ? tidy.replace(/\n+$/, '\n') : tidy
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let files
try {
  files = walk(bridgeRoot)
    .map(p => {
      const path = relative(bridgeRoot, p).split('\\').join('/')
      return { path, content: readFileSync(p, 'utf8') }
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1))
} catch {
  console.error(`regen-bridge: no package sources at ${bridgeRoot}`)
  process.exit(1)
}
if (files.length === 0) {
  console.error('regen-bridge: package dir is empty — nothing to embed')
  process.exit(1)
}

const h = createHash('sha256')
for (const f of files) h.update(f.path).update('\0').update(f.content).update('\0')
const digest = h.digest('hex')

const generated = `export interface UnityBridgeFile {
  path: string
  content: string
}

export const UNITY_BRIDGE_DIGEST = '${digest}'

export const UNITY_BRIDGE_FILES: readonly UnityBridgeFile[] = ${JSON.stringify(files, null, 2)}
`

function embeddedFilesOf(moduleText) {
  const marker = 'export const UNITY_BRIDGE_FILES: readonly UnityBridgeFile[] = '
  const at = moduleText.indexOf(marker)
  if (at === -1) return null
  try {
    return JSON.parse(moduleText.slice(at + marker.length))
  } catch {
    return null
  }
}

function embeddedMatchesPublishedProjection(moduleText) {
  const embedded = embeddedFilesOf(moduleText)
  if (!Array.isArray(embedded) || embedded.length !== files.length) return false
  return files.every((onDisk, i) => {
    const e = embedded[i]
    if (!e || e.path !== onDisk.path) return false
    if (!(/\.cs$/.test(onDisk.path))) return e.content === onDisk.content
    return publishedSource(onDisk.path, onDisk.content) === onDisk.content && publishedSource(e.path, e.content) === onDisk.content
  })
}

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(outPath, 'utf8')
  } catch {
    console.error('regen-bridge --check: generated module missing — run the regen')
    process.exit(1)
  }
  if (current !== generated && !embeddedMatchesPublishedProjection(current)) {
    console.error('regen-bridge --check: DRIFT between assets/unity/bridge/ and bridgeFiles.generated.ts — run: node scripts/unity-bridge/regen-bridge.mjs')
    process.exit(1)
  }
  console.log(`regen-bridge --check: clean (${files.length} files, digest ${digest.slice(0, 12)}…)`)
  process.exit(0)
}

writeFileSync(outPath, generated)
console.log(`regen-bridge: wrote ${outPath} (${files.length} files, digest ${digest.slice(0, 12)}…)`)

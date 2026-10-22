#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const path = process.argv[2] ?? resolve(import.meta.dirname, '../../dist/manifest.json')
const refuse = words => {
  console.error(`REFUSED readings: ${words}`)
  process.exit(78)
}
let manifest
try {
  manifest = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  refuse(`cannot read bundle manifest ${path}: ${error.message}; build the bundle before running readings`)
}
const degraded = manifest?.degraded
if (!Array.isArray(degraded) || degraded.some(pack => typeof pack !== 'string' || pack.trim() === '')) {
  refuse(`bundle manifest ${path} has no valid degraded list; rebuild before running readings`)
}
const builtPackAbsent = record => record !== null && typeof record === 'object' && record.vendored === false
const allowedAbsences = new Set([
  'voice-input',
  'on-device-transcriber',
  ...(builtPackAbsent(manifest.desktopDriver) ? ['desktop-driver'] : []),
  ...(builtPackAbsent(manifest.semanticEmbedder) ? ['semantic-embedder'] : []),
])
const missing = degraded.filter(pack => !allowedAbsences.has(pack))
if (missing.length > 0) {
  refuse(`bundle is degraded: ${missing.join(', ')}; restore the named vendor packs and rebuild before running readings`)
}
if (new Set(degraded).size !== degraded.length) {
  refuse(`bundle manifest ${path} lists a degraded pack twice; rebuild before running readings`)
}
console.log(degraded.length === 0 ? 'bundle ready — degraded: []' : `bundle ready — degraded only by the built packs this runner cannot carry: ${degraded.join(', ')}`)

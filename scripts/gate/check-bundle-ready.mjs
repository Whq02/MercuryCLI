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
if (degraded.length > 0) {
  refuse(`bundle is degraded: ${degraded.join(', ')}; restore the named vendor packs and rebuild before running readings`)
}
console.log('bundle ready — degraded: []')

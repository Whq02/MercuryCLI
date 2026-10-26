import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { proofHome } from './fixture.ts'

const repo = resolve(import.meta.dir, '../..')
const hostWord = ['host', 'name'].join('')
const needles = [['Dock', 'er'], ['Orb', 'Stack'], ['wh', 'q'], ['on this', ' machine'], ['block', 'ed'], ['/Us', 'ers/'], ['mercury', '-handbook']].map(parts => parts.join(''))
const surfaces = ['src/services/media', 'src/commands/imagesetup', 'src/components/Settings/Media.tsx', 'src/components/permissions/MediaPermissionRequest.tsx', 'scripts/media', 'docs/MEDIA.md', 'docs/README.md', 'src/extensions/bundled/mercury-media']
const vendorIdentifiers = new Set(['src/extensions/bundled/mercury-media/server/config.js', 'src/extensions/bundled/mercury-media/server/server.js'])
function files(path: string): string[] {
  try { return readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`]) } catch { return [path] }
}
try {
  let count = 0
  for (const file of surfaces.flatMap(files)) {
    const text = readFileSync(join(repo, file), 'utf8')
    for (const needle of needles) assert.equal(text.includes(needle), false, `${file}: ${needle}`)
    let remaining = text
    if (vendorIdentifiers.has(file)) {
      remaining = remaining.replace(new RegExp(`\\b${hostWord}(?:\\d+|Const)?\\b`, 'g'), '')
    }
    assert.equal(remaining.includes(hostWord), false, `${file}: ${hostWord}`)
    count++
  }
  console.log(`media privacy: ${count} files; library URL/schema identifiers allowed only in the two bundled dependency modules`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }

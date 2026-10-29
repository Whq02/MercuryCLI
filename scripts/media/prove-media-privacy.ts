import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { proofHome } from './fixture.ts'
import ts from 'typescript'

const repo = resolve(import.meta.dir, '../..')
const hostWord = ['host', 'name'].join('')
const needles = [['Dock', 'er'], ['Orb', 'Stack'], ['wh', 'q'], ['on this', ' machine'], ['block', 'ed'], ['/Us', 'ers/'], ['mercury', '-handbook']].map(parts => parts.join(''))
const surfaces = ['src/services/media', 'src/commands/imagesetup', 'src/components/Settings/Media.tsx', 'src/components/permissions/MediaPermissionRequest.tsx', 'scripts/media', 'docs/MEDIA.md', 'docs/README.md', 'src/extensions/bundled/mercury-media']
const vendorIdentifiers = new Set(['src/extensions/bundled/mercury-media/server/config.js', 'src/extensions/bundled/mercury-media/server/server.js', 'src/extensions/bundled/mercury-media/server/remote-client.js', 'src/extensions/bundled/mercury-media/server/remote-server.js'])
function files(path: string): string[] {
  try { return readdirSync(join(repo, path), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${path}/${entry.name}`) : [`${path}/${entry.name}`]) } catch { return [path] }
}
function withoutUrlProperties(text: string, kind: ts.ScriptKind = ts.ScriptKind.JS): string {
  const source = ts.createSourceFile(kind === ts.ScriptKind.JS ? 'setup.js' : 'surface.ts', text, ts.ScriptTarget.Latest, true, kind)
  const ranges: Array<[number, number]> = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === hostWord) ranges.push([node.name.getStart(source), node.name.end])
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + text.slice(end)
  return text
}
try {
  assert.equal(withoutUrlProperties(`url.${hostWord} === 'huggingface.co'`).includes(hostWord), false)
  assert.equal(withoutUrlProperties(`const value = '${hostWord}: private-computer'`).includes(hostWord), true)
  let count = 0
  for (const file of surfaces.flatMap(files)) {
    const text = readFileSync(join(repo, file), 'utf8')
    for (const needle of needles) assert.equal(text.includes(needle), false, `${file}: ${needle}`)
    let remaining = text
    if (vendorIdentifiers.has(file)) {
      remaining = remaining.replace(new RegExp(`\\b${hostWord}(?:\\d+|Const)?\\b`, 'g'), '')
    }
    if (file === 'src/extensions/bundled/mercury-media/server/setup.js') remaining = withoutUrlProperties(remaining)
    if (file.endsWith('.ts')) remaining = withoutUrlProperties(remaining, ts.ScriptKind.TS)
    assert.equal(remaining.includes(hostWord), false, `${file}: ${hostWord}`)
    count++
  }
  console.log(`media privacy: ${count} files; library identifiers confined to bundled modules; setup URL properties excluded without excluding string content`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }

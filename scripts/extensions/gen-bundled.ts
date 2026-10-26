import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ROW = {
  assets: 'src/extensions/bundled/content.generated.ts',
  generator: 'bun scripts/extensions/gen-bundled.ts',
  check: 'bun scripts/extensions/gen-bundled.ts --check',
  sources: 'src/extensions/bundled/*/mercury-extension.json src/extensions/bundled/*/server/** src/extensions/bundled/shared/**',
}
if (registerOnlyRequested(ROW)) process.exit(0)
const root = resolve(import.meta.dir, '../../src/extensions/bundled')
type Payload = string | { base64: string; executable: boolean }
function textTree(dir: string): Record<string, Payload> {
  const out: Record<string, Payload> = {}
  function walk(path: string): void {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, item.name)
      if (item.isSymbolicLink()) throw new Error(`Bundled sources must not contain links: ${full}`)
      if (item.isDirectory()) walk(full)
      else {
        const bytes = readFileSync(full)
        out[relative(dir, full).replaceAll('\\', '/')] = bytes.includes(0) ? { base64: bytes.toString('base64'), executable: (statSync(full).mode & 0o111) !== 0 } : bytes.toString('utf8')
      }
    }
  }
  walk(dir)
  return out
}
const shared = textTree(join(root, 'shared'))
const payloads: Record<string, Record<string, Payload>> = {}
for (const name of ['filmcraft', 'photocraft', 'lightcraft']) {
  if (!existsSync(join(root, name, 'mercury-extension.json'))) continue
  payloads[name] = { ...textTree(join(root, name)), ...Object.fromEntries(Object.entries(shared).map(([path, text]) => [`shared/${path}`, text])) }
}
payloads['mercury-media'] = textTree(join(root, 'mercury-media'))
const content = 'export const bundledPayloads: Record<string, Record<string, string | { base64: string; executable: boolean }>> = ' + JSON.stringify(payloads, null, 2) + '\n'
const target = join(root, 'content.generated.ts')
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) throw new Error('Bundled extensions changed; run bun scripts/extensions/gen-bundled.ts')
} else writeFileSync(target, content)
console.log(`Bundled extension payloads: ${Object.keys(payloads).join(', ')}`)

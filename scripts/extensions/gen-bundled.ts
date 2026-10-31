import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { canonicalJson } from '../../src/extensions/manifest.js'
import { bootstrapManifest } from '../../src/extensions/bundled/shared/bootstrap.mjs'

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
  const lock = JSON.parse(readFileSync(join(root, name, 'server', `${name}.lock.json`), 'utf8'))
  const bootstrap = bootstrapManifest({ id: name, title: name[0]!.toUpperCase() + name.slice(1).replace('craft', 'Craft'), version: lock.version })
  payloads[name] = { ...textTree(join(root, name)), ...Object.fromEntries(Object.entries(shared).map(([path, text]) => [`shared/${path}`, text])), 'server/bootstrap.json': JSON.stringify(bootstrap, null, 2) + '\n' }
}
payloads['mercury-media'] = textTree(join(root, 'mercury-media'))
const metadata = Object.fromEntries(Object.entries(payloads).map(([name, files]) => {
  const manifest = JSON.parse(files['mercury-extension.json'] as string)
  const digests: Record<string, string> = {}
  const tree = createHash('sha256')
  for (const path of Object.keys(files).sort()) {
    const value = files[path]!
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.base64, 'base64')
    tree.update(path).update('\0').update(bytes).update('\0')
    if (path !== 'mercury-extension.json') digests[path] = createHash('sha256').update(bytes).digest('hex')
  }
  return [name, {
    digest: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16),
    contentHash: `sha256:${tree.digest('hex')}`,
    contributionsHash: `sha256:${createHash('sha256').update(canonicalJson({ contributes: manifest.contributes ?? {}, needs: manifest.needs ?? {}, files: digests })).digest('hex')}`,
    manifest,
    ...(files['server/bootstrap.json'] ? { bootstrap: JSON.parse(files['server/bootstrap.json'] as string) } : {}),
  }]
}))
const content = 'import type { ExtensionManifest } from "../manifest.js"\nimport type { McpBootstrapManifest } from "../../services/mcp/lazyStdio.js"\n\nexport const bundledMetadata: Record<string, { digest: string; contentHash: string; contributionsHash: string; manifest: ExtensionManifest; bootstrap?: McpBootstrapManifest }> = ' + JSON.stringify(metadata, null, 2) + '\n\nexport const bundledPayloads: Record<string, Record<string, string | { base64: string; executable: boolean }>> = ' + JSON.stringify(payloads, null, 2) + '\n'
const target = join(root, 'content.generated.ts')
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) throw new Error('Bundled extensions changed; run bun scripts/extensions/gen-bundled.ts')
} else writeFileSync(target, content)
console.log(`Bundled extension payloads: ${Object.keys(payloads).join(', ')}`)

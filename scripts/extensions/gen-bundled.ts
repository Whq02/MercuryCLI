import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { executableBit, indexedExecutables, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { canonicalJson } from '../../src/integrations/extensions/manifest.js'
import { bootstrapManifest } from '../../src/integrations/extensions/bundled/shared/bootstrap.mjs'

const ROW = {
  assets: 'src/integrations/extensions/bundled/content.generated.ts',
  generator: 'bun scripts/extensions/gen-bundled.ts',
  check: 'bun scripts/extensions/gen-bundled.ts --check',
  sources: 'src/integrations/extensions/bundled/*/mercury-extension.json src/integrations/extensions/bundled/*/server/** src/integrations/extensions/bundled/shared/**',
  build: true,
}
if (registerOnlyRequested(ROW)) process.exit(0)
const rootFlag = process.argv.indexOf('--root')
const root = rootFlag === -1 ? resolve(import.meta.dir, '../../src/integrations/extensions/bundled') : resolve(process.argv[rootFlag + 1]!)
const target = join(root, 'content.generated.ts')
const PAYLOADS = 'export const bundledPayloads: Record<string, Record<string, string | { base64: string; executable: boolean }>> = '
type Payload = string | { base64: string; executable: boolean }
const current = existsSync(target) ? readFileSync(target, 'utf8') : null
function committedExecutables(): Set<string> {
  const out = new Set<string>()
  const at = current === null ? -1 : current.indexOf(PAYLOADS)
  if (current === null || at === -1) return out
  let recorded: Record<string, Record<string, Payload>>
  try {
    recorded = JSON.parse(current.slice(at + PAYLOADS.length))
  } catch {
    return out
  }
  for (const [name, files] of Object.entries(recorded)) {
    for (const [path, value] of Object.entries(files)) if (typeof value !== 'string' && value.executable) out.add(path.startsWith('shared/') ? path : `${name}/${path}`)
  }
  return out
}
const indexed: Map<string, boolean> = indexedExecutables(root)
const committed = committedExecutables()
function textTree(dir: string): Record<string, Payload> {
  const out: Record<string, Payload> = {}
  function walk(path: string): void {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = join(path, item.name)
      if (item.isSymbolicLink()) throw new Error(`Bundled sources must not contain links: ${full}`)
      if (item.isDirectory()) walk(full)
      else {
        const bytes = readFileSync(full)
        const tracked = relative(root, full).replaceAll('\\', '/')
        out[relative(dir, full).replaceAll('\\', '/')] = bytes.includes(0) ? { base64: bytes.toString('base64'), executable: executableBit({ indexed: indexed.get(tracked), onDisk: (statSync(full).mode & 0o111) !== 0, committed: committed.has(tracked) }) } : bytes.toString('utf8')
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
  const manifestVersion = JSON.parse(readFileSync(join(root, name, 'mercury-extension.json'), 'utf8')).version
  if (manifestVersion !== lock.version) throw new Error(`${name}: mercury-extension.json says ${manifestVersion} but ${name}.lock.json pins ${lock.version}; the bundled row shows the pinned app release, so the two must agree`)
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
const content = 'import type { ExtensionManifest } from "../manifest.js"\nimport type { McpBootstrapManifest } from "../../mcp-shapes/mcpServerRecords.js"\n\nexport const bundledMetadata: Record<string, { digest: string; contentHash: string; contributionsHash: string; manifest: ExtensionManifest; bootstrap?: McpBootstrapManifest }> = ' + JSON.stringify(metadata, null, 2) + '\n\n' + PAYLOADS + JSON.stringify(payloads, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (current !== content) throw new Error('Bundled extensions changed; run bun scripts/extensions/gen-bundled.ts')
} else writeFileSync(target, content)
console.log(`Bundled extension payloads: ${Object.keys(payloads).join(', ')}`)

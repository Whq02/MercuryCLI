// ============================================================================
//  scripts/field-tasks/gen-field-packet.ts — the §7 Windows field packet
//  GENERATOR. The kit's canonical sources live in scripts/field-tasks/field-kit/
//  (setup guide · checklist · issue template · PS7 launcher + collector ·
//  the ONE self-contained practice task); this script materializes a
//  shippable packet from the covered tree: kit copy + packet-manifest.json
//  (mercury version, artifact digest, task id, timestamps, sha256 per file)
//  and, where a zip tool exists, mercury-field-kit.zip.
//
//  Identity comes from the BUILT artifact (dist/manifest.json). CI proof
//  legs on runners that never build pass --allow-unbuilt: the manifest then
//  names the git tree and marks the digest unbuilt — never a guessed value.
//
//  Usage:
//    bun scripts/field-tasks/gen-field-packet.ts --out <dir> [--zip] [--allow-unbuilt]
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const kitSource = join(repoRoot, 'scripts/field-tasks/field-kit')

const args = process.argv.slice(2)
const get = (flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}
const outRoot = get('--out')
if (!outRoot) {
  console.error('usage: gen-field-packet.ts --out <dir> [--zip] [--allow-unbuilt]')
  process.exit(2)
}
const wantZip = args.includes('--zip')
const allowUnbuilt = args.includes('--allow-unbuilt')

// ── artifact identity (the covered tree, never a guess) ─────────────────────
let mercuryVersion: string
let artifactDigest: string
const distManifest = join(repoRoot, 'dist/manifest.json')
if (existsSync(distManifest)) {
  const manifest = JSON.parse(readFileSync(distManifest, 'utf8')) as { version?: string; buildTree?: string }
  mercuryVersion = String(manifest.version ?? 'unknown')
  artifactDigest = String(manifest.buildTree ?? 'unknown')
} else if (allowUnbuilt) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }
  mercuryVersion = String(pkg.version ?? 'unknown') + '+unbuilt'
  artifactDigest = 'unbuilt-proof-run:' + execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
} else {
  console.error('dist/manifest.json missing — build first (bun run build.ts) or pass --allow-unbuilt for a proof run')
  process.exit(2)
}

// ── materialize ─────────────────────────────────────────────────────────────
const kitOut = join(resolve(outRoot), 'mercury-field-kit')
mkdirSync(kitOut, { recursive: true })
cpSync(kitSource, kitOut, { recursive: true })

const files: { path: string; bytes: number; sha256: string }[] = []
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else {
      const body = readFileSync(full)
      files.push({
        path: relative(kitOut, full).replaceAll('\\', '/'),
        bytes: statSync(full).size,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
    }
  }
}
walk(kitOut)

const packetManifest = {
  schema: 1,
  kind: 'mercury-field-kit',
  generatedAtUtc: new Date().toISOString(),
  mercuryVersion,
  artifactDigest,
  taskId: 'FK1',
  files,
}
writeFileSync(join(kitOut, 'packet-manifest.json'), JSON.stringify(packetManifest, null, 2) + '\n', 'utf8')

console.log(`field kit: ${kitOut}`)
console.log(`identity: mercury ${mercuryVersion} · artifact ${artifactDigest}`)
console.log(`files: ${files.length} (sha256 in packet-manifest.json)`)

if (wantZip) {
  const zip = spawnSync('zip', ['-qr', 'mercury-field-kit.zip', 'mercury-field-kit'], {
    cwd: resolve(outRoot),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (zip.status === 0) console.log(`zip: ${join(resolve(outRoot), 'mercury-field-kit.zip')}`)
  else console.log('zip tool unavailable on this platform — ship the folder or Compress-Archive it (named, not silent)')
}

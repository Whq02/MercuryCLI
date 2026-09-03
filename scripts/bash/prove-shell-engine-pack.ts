#!/usr/bin/env bun
import '../lib/hermetic.ts'

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const pack = await import(join(ROOT, 'src/utils/shell/brushPack.ts'))

section('§1 the lock, the manifest decoder, and the pack checks')
{
  const lock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'brush.lock.json'), 'utf8'))
  check('the lock names brush and a version', lock.name === 'brush' && typeof lock.version === 'string', JSON.stringify(lock.version))
  check('the lock pins a tag that is an upstream release', typeof lock.tag === 'string' && lock.tag.length > 0)
  const platformKeys = Object.keys(lock.platforms ?? {})
  check('the lock pins at least darwin + linux platforms', platformKeys.includes('darwin-arm64') && platformKeys.some(k => k.startsWith('linux')), platformKeys.join(','))
  for (const [key, p] of Object.entries<Record<string, string>>(lock.platforms ?? {})) {
    check(`${key}: sha256 is a 64-hex digest and the url is an asset of the pinned tag`,
      /^[0-9a-f]{64}$/.test(p.sha256) && p.url.includes(`/download/${lock.tag}/`), p.url)
  }
  check('brushPackPlatform maps this host or returns null honestly',
    pack.brushPackPlatform('darwin', 'arm64') === 'darwin-arm64' && pack.brushPackPlatform('sunos', 'sparc') === null)
  check('brushBinaryFor names brush / brush.exe by platform',
    pack.brushBinaryFor('linux-x64') === 'brush' && pack.brushBinaryFor('win-x64') === 'brush.exe')

  const dir = mkdtempSync(join(tmpdir(), 'brush-pack-'))
  check('checkBrushPackDir reports an empty dir as absent', pack.checkBrushPackDir(dir, { platform: 'linux-x64' }).state === 'absent')
  const binPath = join(dir, 'brush')
  writeFileSync(binPath, 'not a real binary')
  writeFileSync(join(dir, 'LICENSE'), 'MIT')
  writeFileSync(join(dir, 'THIRD_PARTY_LICENSES.html'), '<html></html>')
  const digest = createHash('sha256').update(readFileSync(binPath)).digest('hex')
  const tree = pack.brushPackTreeDigest(dir)
  const manifest = {
    name: 'brush', version: '0.4.0', platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu',
    archive: 'brush-x86_64-unknown-linux-gnu.tar.gz', archiveSha256: 'a'.repeat(64),
    binary: 'brush', binarySha256: digest, license: 'MIT',
    licenseFiles: ['LICENSE', 'THIRD_PARTY_LICENSES.html'], fileCount: tree.fileCount, treeDigest: tree.treeDigest,
  }
  writeFileSync(join(dir, '.vendor-manifest.json'), JSON.stringify(manifest))
  check('a well-formed pack decodes and checks ok (digest verified)', pack.checkBrushPackDir(dir, { digest: true, platform: 'linux-x64' }).state === 'ok')
  writeFileSync(binPath, 'tampered')
  check('a digest mismatch is caught', pack.checkBrushPackDir(dir, { digest: true, platform: 'linux-x64' }).state === 'mismatch')
  check('a wrong-platform pack is caught', pack.checkBrushPackDir(dir, { platform: 'darwin-arm64' }).state === 'mismatch')
}

section('§2 engine resolution, the env pin, and the honest degrade')
{
  const { resolveShellEngine } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const vendored = pack.resolveBrushPackDir()

  delete process.env.MERCURY_SHELL_ENGINE
  check('default (no pin, no setting) is the system shell', resolveShellEngine().engine === 'system')
  check('the system setting stays system', resolveShellEngine('system').engine === 'system')

  if (vendored.state === 'ok') {
    check('brush arms when the pack is present', resolveShellEngine('brush').engine === 'brush')
    process.env.MERCURY_SHELL_ENGINE = 'system'
    check('the env pin system OUTRANKS the brush setting', resolveShellEngine('brush').engine === 'system')
    process.env.MERCURY_SHELL_ENGINE = 'brush'
    check('the env pin brush arms even with the system setting', resolveShellEngine('system').engine === 'brush')
    delete process.env.MERCURY_SHELL_ENGINE
  } else {
    const r = resolveShellEngine('brush')
    check('an unavailable pack degrades to system with a named reason',
      r.engine === 'system' && r.requested === 'brush' && r.reason.length > 10, JSON.stringify(r))
  }
}

section('§3 the flag registry row and the settings key')
{
  const { FLAG_REGISTRY } = await import(join(ROOT, 'src/substrate/flagRegistry.ts'))
  const row = (FLAG_REGISTRY as Array<{ env: string; kind: string; consumer: string }>).find(r => r.env === 'MERCURY_SHELL_ENGINE')
  check('MERCURY_SHELL_ENGINE is registered', row !== undefined)
  check('it is a value knob consumed by the engine session', row?.kind === 'value' && row?.consumer.includes('engineSession'), JSON.stringify(row))

  const typesSrc = readFileSync(join(ROOT, 'src/utils/settings/types.ts'), 'utf8')
  check("the settings schema carries shellEngine: 'system' | 'brush'", /shellEngine:\s*z\.enum\(\['system',\s*'brush'\]\)/.test(typesSrc))
}

section('§4 the built bundle: manifest record, doctor row, prompt sentence')
{
  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (!existsSync(dist) || !existsSync(manifestPath)) {
    console.log('  (dist absent — the pooled gate prebuilds it; bundle pins skipped)')
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check('the manifest carries a shellEngine record', manifest.shellEngine !== undefined)
    check('with a pack present, the manifest is not degraded on shell-engine',
      manifest.shellEngine?.vendored !== true || !(manifest.degraded ?? []).includes('shell-engine'))
    const bundle = readFileSync(dist, 'utf8')
    check('the bundle carries the shell-engine doctor row', bundle.includes('iface-shell-engine'))
    check('the bundle carries the engine-aware Bash prompt sentence', bundle.includes('One shell session serves the whole conversation'))
    check('the bundle carries the system-shell reset sentence too', bundle.includes('every other piece of shell state (variables, functions, options) resets between calls'))
  }
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '✅ ALL SHELL-ENGINE PACK PROOFS PASS' : `❌ ${failures} SHELL-ENGINE PACK PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

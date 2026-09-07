#!/usr/bin/env bun
import '../lib/hermetic.ts'

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  for (const [key, p] of Object.entries<Record<string, string | null>>(lock.platforms ?? {})) {
    if (p.kind === 'build') {
      check(`${key}: a build entry names the crate, its version at the pin and a Rust target (the crate digest is null until a build records it, else 64-hex)`,
        typeof p.crate === 'string' && p.crateVersion === lock.version && typeof p.target === 'string' && (p.crateSha256 === null || /^[0-9a-f]{64}$/.test(p.crateSha256 ?? '')), JSON.stringify(p))
      continue
    }
    check(`${key}: sha256 is a 64-hex digest and the url is an asset of the pinned tag`,
      /^[0-9a-f]{64}$/.test(p.sha256 ?? '') && (p.url ?? '').includes(`/download/${lock.tag}/`), String(p.url))
  }
  check('the lock BUILDS win-x64 (upstream publishes no Windows release binary)', lock.platforms?.['win-x64']?.kind === 'build')
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
    name: 'brush', source: 'release-archive', version: '0.4.0', platform: 'linux-x64', target: 'x86_64-unknown-linux-gnu',
    archive: 'brush-x86_64-unknown-linux-gnu.tar.gz', archiveSha256: 'a'.repeat(64),
    binary: 'brush', binarySha256: digest, license: 'MIT',
    licenseFiles: ['LICENSE', 'THIRD_PARTY_LICENSES.html'], fileCount: tree.fileCount, treeDigest: tree.treeDigest,
  }
  writeFileSync(join(dir, '.vendor-manifest.json'), JSON.stringify(manifest))
  check('a well-formed pack decodes and checks ok (digest verified)', pack.checkBrushPackDir(dir, { digest: true, platform: 'linux-x64' }).state === 'ok')
  writeFileSync(binPath, 'tampered')
  check('a digest mismatch is caught', pack.checkBrushPackDir(dir, { digest: true, platform: 'linux-x64' }).state === 'mismatch')
  check('a wrong-platform pack is caught', pack.checkBrushPackDir(dir, { platform: 'darwin-arm64' }).state === 'mismatch')

  const built = mkdtempSync(join(tmpdir(), 'brush-built-'))
  writeFileSync(join(built, 'brush.exe'), 'not a real binary either')
  mkdirSync(join(built, 'licenses', 'brush-shell-0.4.0'), { recursive: true })
  writeFileSync(join(built, 'licenses', 'brush-shell-0.4.0', 'LICENSE'), 'MIT')
  writeFileSync(join(built, 'NOTICES.json'), '{}')
  const builtTree = pack.brushPackTreeDigest(built)
  const builtManifest = {
    name: 'brush', source: 'cargo-build', version: '0.4.0', platform: 'win-x64', target: 'x86_64-pc-windows-msvc',
    crate: 'brush-shell', crateVersion: '0.4.0', crateSha256: null, cargo: 'cargo 1.90.0',
    binary: 'brush.exe', binarySha256: createHash('sha256').update(readFileSync(join(built, 'brush.exe'))).digest('hex'), license: 'MIT',
    licenseFiles: ['NOTICES.json', 'licenses/brush-shell-0.4.0/LICENSE'], fileCount: builtTree.fileCount, treeDigest: builtTree.treeDigest,
  }
  writeFileSync(join(built, '.vendor-manifest.json'), JSON.stringify(builtManifest))
  const builtCheck = pack.checkBrushPackDir(built, { digest: true, platform: 'win-x64' })
  check('a cargo-built pack (source cargo-build, no archive) decodes and checks ok', builtCheck.state === 'ok' && builtCheck.manifest?.source === 'cargo-build', JSON.stringify(builtCheck))
  writeFileSync(join(built, '.vendor-manifest.json'), JSON.stringify({ ...builtManifest, source: undefined }))
  check('a manifest that names no source is half a claim and decodes null', pack.readBrushPackManifest(built) === null)
  writeFileSync(join(built, '.vendor-manifest.json'), JSON.stringify({ ...builtManifest, crateSha256: 'zz' }))
  check('a cargo-build manifest with a malformed crate digest decodes null', pack.readBrushPackManifest(built) === null)
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
    const { resetShellEngineResolution } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
    const manifestPath = join(vendored.dir, '.vendor-manifest.json')
    const hidden = `${manifestPath}.hidden`
    renameSync(manifestPath, hidden)
    try {
      check('the resolution is memoised per process: with the manifest hidden, brush still arms (no disk read)', resolveShellEngine('brush').engine === 'brush')
      resetShellEngineResolution()
      const r = resolveShellEngine('brush')
      check('a reset re-reads the disk: the hidden manifest degrades to the system shell with the reason', r.engine === 'system' && r.requested === 'brush' && r.reason.length > 10, JSON.stringify(r))
    } finally {
      renameSync(hidden, manifestPath)
      resetShellEngineResolution()
    }
    check('after the restore and a reset, brush arms again', resolveShellEngine('brush').engine === 'brush')
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
    check('the bundle carries the per-agent sentence (a sub-agent has a shell session of its own)', bundle.includes('Each sub-agent has a shell session of its own'))
    check("the bundle carries the doctor row's per-owner words", bundle.includes('one persistent process per conversation and one per sub-agent'))
    check('the bundle tells the model a message while a command runs stops it under the engine', bundle.includes('A message from the operator while a command runs stops that command and resets the session'))
    check("the bundle carries the doctor row's word on the stop", bundle.includes('a message sent while a command runs stops that command'))
    check('the bundle carries the system-shell reset sentence too', bundle.includes('every other piece of shell state (variables, functions, options) resets between calls'))
    check('the bundle carries the Windows arm of the engine sentence — the two known holes at this version', bundle.includes('os error 193') && bundle.includes('relative program path after a `cd`'))
  }
}

section('§5 the loop script uses only builtins the Windows engine build has')
{
  const { loopScript } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const script: string = loopScript()
  check('the loop names no exec', !/(^|[\s;|&(])exec(\s|$)/m.test(script))
  check('the loop opens no numbered descriptor beyond 0-2', !/[<>]&[3-9]/.test(script) && !/(^|\s)[3-9][<>]/.test(script))
  check('the loop never names /dev/null', !script.includes('/dev/null'))
  check("the loop reads newline-delimited frames (no NUL delimiter)", !/read\s[^\n]*-d\s*''/.test(script))
  const ALLOWED = new Set(['read', 'eval', 'printf', 'pwd', 'cd', ':', '__brush_run'])
  const words: string[] = []
  const visit = (text: string): void => {
    const fn = /^\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{\s*([\s\S]*)\}\s*$/.exec(text)
    if (fn) {
      visit(fn[2] ?? '')
      return
    }
    for (const piece of text.split(/\|\||&&|;|\|/)) {
      let seg = piece.trim()
      if (seg === '' || seg === '__BRUSH_STDIN__') continue
      for (const inner of seg.matchAll(/\$\(([^()]*)\)/g)) visit(inner[1] ?? '')
      for (;;) {
        const assignment = /^[A-Za-z_][A-Za-z0-9_]*=(\$\([^)]*\)|'[^']*'|"[^"]*"|[^\s]*)\s*/.exec(seg)
        if (assignment) {
          seg = seg.slice(assignment[0].length)
          continue
        }
        const keyword = /^(while|do|done|if|then|else|fi|!)(\s+|$)/.exec(seg)
        if (keyword) {
          seg = seg.slice(keyword[0].length)
          continue
        }
        break
      }
      if (seg === '') continue
      words.push(seg.split(/\s+/)[0] ?? '')
    }
  }
  for (const line of script.split('\n')) visit(line)
  const foreign = words.filter(w => !ALLOWED.has(w))
  check(`every command word is one of ${[...ALLOWED].join(' · ')} (${words.length} words read)`, words.length > 0 && foreign.length === 0, foreign.join(', '))
}

section('§6 the directory a frame reports reaches the session in its native form')
{
  const { recordedCwdToNative } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const { stripExtendedLengthPrefix, nativeCwdFromShellRecord } = await import(join(ROOT, 'src/utils/windowsPaths.ts'))
  const ext = '\\\\?\\C:\\Users\\x\\AppData\\Local\\Temp\\brush-cwd-1'
  check('the extended-length prefix is stripped to the plain drive path', stripExtendedLengthPrefix(ext) === 'C:\\Users\\x\\AppData\\Local\\Temp\\brush-cwd-1', stripExtendedLengthPrefix(ext))
  check('…and the UNC form to the plain UNC path', stripExtendedLengthPrefix('\\\\?\\UNC\\server\\share\\dir') === '\\\\server\\share\\dir', stripExtendedLengthPrefix('\\\\?\\UNC\\server\\share\\dir'))
  check('a plain drive path and a POSIX path pass through untouched', stripExtendedLengthPrefix('C:\\dir') === 'C:\\dir' && stripExtendedLengthPrefix('/private/tmp/x') === '/private/tmp/x')
  const viaRecord = nativeCwdFromShellRecord(ext)
  check("the classic road's converter hands back the plain drive path for the shell's extended answer", 'path' in viaRecord && viaRecord.path === 'C:\\Users\\x\\AppData\\Local\\Temp\\brush-cwd-1', JSON.stringify(viaRecord))
  check('the engine records the plain drive path on Windows', recordedCwdToNative(ext, 'windows') === 'C:\\Users\\x\\AppData\\Local\\Temp\\brush-cwd-1', String(recordedCwdToNative(ext, 'windows')))
  check('a POSIX temp path is the record untouched off Windows', recordedCwdToNative('/private/tmp/brush-cwd-2', 'macos') === '/private/tmp/brush-cwd-2' && recordedCwdToNative('/private/tmp/brush-cwd-2', 'linux') === '/private/tmp/brush-cwd-2')
  check("an MSYS virtual root the converter cannot place is refused: the session keeps its own directory (null)", recordedCwdToNative('/tmp', 'windows') === null)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '✅ ALL SHELL-ENGINE PACK PROOFS PASS' : `❌ ${failures} SHELL-ENGINE PACK PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

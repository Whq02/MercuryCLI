import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseMediaCatalogue } from '../../src/services/media/catalogue.js'
import { mediaPullPlan, mediaRuntimeChoice, mediaRuntimeInstalled, mediaRuntimeRowWords, mediaSizeWords, type MediaSnapshot } from '../../src/services/media/setup.js'
import { catalogue as fixtureCatalogue, proofHome, root } from './fixture.ts'

const MAC = { asset: 'sd-master-e41fbcf-bin-Darwin-macOS-26.6.2-arm64.zip', bytes: 37584335, sha256: '933fb5b622b578df7a0d22c41f39bc83791d40b876648a084fe1c4cbff2ef36c' }
const savedPath = process.env.PATH
const savedModulePath = process.env.PSModulePath
try {
  const bundledPath = resolve(import.meta.dir, '../../src/extensions/bundled/mercury-media/server/catalog.json')
  const bundled = parseMediaCatalogue(JSON.parse(readFileSync(bundledPath, 'utf8')))
  assert.equal(bundled.runtime.tag, 'master-1015-e41fbcf')
  assert.deepEqual(Object.keys(bundled.runtime.platforms), ['darwin-arm64', 'win32-x64', 'linux-x64'])
  assert.deepEqual(bundled.runtime.platforms['darwin-arm64'], [{ variant: 'metal', binary: 'sd-server', files: [MAC] }])
  assert.deepEqual(bundled.runtime.platforms['win32-x64']!.map(row => [row.variant, row.binary, row.files.map(file => [file.asset, file.bytes, file.sha256])]), [
    ['vulkan', 'sd-server.exe', [['sd-master-e41fbcf-bin-win-vulkan-x64.zip', 29744345, '259ceeb62f1069190d24c85ea1c4549d2d61deb0ef712510dbe98d79ce93a38b']]],
    ['cuda12', 'sd-server.exe', [['sd-master-e41fbcf-bin-win-cuda12-x64.zip', 343503038, '56141f67eb8c2b3b3b295d54a56be29040abc2efdf81584dbd94725fce5d474d'], ['cudart-sd-bin-win-cu12-x64.zip', 563452046, 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d']]],
    ['cpu', 'sd-server.exe', [['sd-master-e41fbcf-bin-win-cpu-x64.zip', 18080790, 'bfc02f16df7744296ecc7720503a2b633575490dd7d8b448aee035c1fc836bec']]],
  ])
  assert.deepEqual(bundled.runtime.platforms['linux-x64']!.map(row => [row.variant, row.binary, row.files.map(file => [file.asset, file.bytes, file.sha256])]), [
    ['vulkan', 'sd-server', [['sd-master-e41fbcf-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip', 37644143, '0ae9ef34eea1ff6a229b892144a65ed8c00b6438c5ba783cdeca77024b2fc697']]],
    ['cpu', 'sd-server', [['sd-master-e41fbcf-bin-Linux-Ubuntu-24.04-x86_64.zip', 27320021, '422bc495ca647d95e9bd88b04d3eaae52e641d89497ea0dda7335f44c46e9109']]],
  ])
  const old = parseMediaCatalogue({ runtime: { tag: 'master-1015-e41fbcf', ...MAC }, models: [], files: [] })
  assert.deepEqual(old.runtime, { tag: 'master-1015-e41fbcf', families: [], componentFamilies: [], platforms: { 'darwin-arm64': [{ variant: 'metal', binary: 'sd-server', files: [MAC] }] } })
  assert.deepEqual(parseMediaCatalogue(fixtureCatalogue).runtime.platforms['darwin-arm64']![0]!.files[0], { asset: 'fixture.zip', bytes: 64, sha256: 'a'.repeat(64) })
  assert.throws(() => parseMediaCatalogue({ runtime: { tag: 't', platforms: { 'win32-x64': [] } }, models: [], files: [] }))
  assert.throws(() => parseMediaCatalogue({ runtime: { tag: 't', platforms: { 'win32-x64': [{ variant: 'vulkan', binary: 'sd-server.exe', files: [{ asset: 'x.tar', bytes: 1, sha256: 'a'.repeat(64) }] }] } }, models: [], files: [] }))

  const choice = (platform: string, arch: string, gpu?: 'nvidia' | 'amd') => { const row = mediaRuntimeChoice(bundled, platform, arch, gpu); return row ? [row.variant, row.words, row.bytes, row.args] : undefined }
  assert.deepEqual(choice('darwin', 'arm64'), ['metal', 'Metal', 37584335, ['pull-runtime', '--variant', 'metal']])
  assert.deepEqual(choice('win32', 'x64'), ['vulkan', 'Vulkan', 29744345, ['pull-runtime', '--variant', 'vulkan']])
  assert.deepEqual(choice('win32', 'x64', 'amd'), ['vulkan', 'Vulkan', 29744345, ['pull-runtime', '--variant', 'vulkan']])
  assert.deepEqual(choice('win32', 'x64', 'nvidia'), ['cuda12', 'CUDA 12', 343503038 + 563452046, ['pull-runtime', '--variant', 'cuda12']])
  assert.deepEqual(choice('linux', 'x64'), ['vulkan', 'Vulkan', 37644143, ['pull-runtime', '--variant', 'vulkan']])
  assert.deepEqual(choice('linux', 'x64', 'nvidia'), ['vulkan', 'Vulkan', 37644143, ['pull-runtime', '--variant', 'vulkan']])
  assert.deepEqual(choice('linux', 'x64', 'amd'), ['vulkan', 'Vulkan', 37644143, ['pull-runtime', '--variant', 'vulkan']])
  assert.equal(choice('win32', 'arm64', 'nvidia'), undefined)
  assert.equal(choice('linux', 'arm64'), undefined)
  assert.equal(choice('darwin', 'x64'), undefined)

  const snapshot = (runtime: MediaSnapshot['runtime'], runtimeInstalled: boolean): MediaSnapshot => ({ root, runtimeInstalled, ...(runtime ? { runtime } : {}), catalogue: bundled, config: {}, totalMemoryBytes: 32 * 1024 ** 3, usableMemoryBytes: 24 * 1024 ** 3, freeBytes: 100, rows: [] })
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'darwin', 'arm64'), false)), 'stable-diffusion.cpp (Metal) · pull 37.6 MB · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'darwin', 'arm64'), true)), 'stable-diffusion.cpp (Metal) · installed · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'win32', 'x64'), false)), 'stable-diffusion.cpp (Vulkan) · pull 29.7 MB · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'win32', 'x64', 'nvidia'), false)), 'stable-diffusion.cpp (CUDA 12) · pull 907.0 MB · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'win32', 'x64', 'nvidia'), true)), 'stable-diffusion.cpp (CUDA 12) · installed · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(mediaRuntimeChoice(bundled, 'linux', 'x64'), false)), 'stable-diffusion.cpp (Vulkan) · pull 37.6 MB · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot({ variant: 'cpu', binary: 'sd-server.exe', words: 'CPU', bytes: 18080790, args: ['pull-runtime', '--variant', 'cpu'] }, false)), 'stable-diffusion.cpp (CPU) · pull 18.1 MB · MIT')
  assert.equal(mediaRuntimeRowWords(snapshot(undefined, false)), 'stable-diffusion.cpp · MIT')
  const plan = mediaPullPlan(snapshot(mediaRuntimeChoice(bundled, 'win32', 'x64', 'nvidia'), false))
  assert.deepEqual(plan.args, ['pull-runtime', '--variant', 'cuda12'])
  assert.equal(plan.bytes, 906955084)
  assert.equal(mediaSizeWords(plan.bytes), '907.0 MB')
  assert.equal(plan.title, 'stable-diffusion.cpp')
  assert.deepEqual(mediaPullPlan(snapshot(undefined, false)).args, ['pull-runtime'])
  const docs = readFileSync(resolve(import.meta.dir, '../../docs/MEDIA.md'), 'utf8').replace(/\n {0,3}/g, ' ')
  for (const words of ['37.6 MB on macOS', '29.7 MB for Vulkan on Windows', '907.0 MB for CUDA 12', '37.6 MB for Vulkan on Linux', 'Apple Silicon gets the Metal build; Windows gets the Vulkan build, or the CUDA 12 build when an NVIDIA card is present; Linux gets the Vulkan build.', 'There is no build for arm64 Windows or arm64 Linux yet.', 'Windows needs nothing beyond PowerShell 5.1.']) assert.ok(docs.includes(words), words)

  const cuda = mediaRuntimeChoice(bundled, 'win32', 'x64', 'nvidia')!
  const vulkan = mediaRuntimeChoice(bundled, 'win32', 'x64')!
  const metal = mediaRuntimeChoice(bundled, 'darwin', 'arm64')!
  assert.equal(mediaRuntimeInstalled(bundled, root, cuda, { tag: bundled.runtime.tag, variant: 'cuda12' }, 'ok'), true)
  assert.equal(mediaRuntimeInstalled(bundled, root, cuda, { tag: bundled.runtime.tag, variant: 'vulkan' }, 'ok'), false, 'a Vulkan install on an NVIDIA machine still offers the CUDA 12 pull')
  assert.equal(mediaRuntimeInstalled(bundled, root, vulkan, { tag: bundled.runtime.tag, variant: 'vulkan' }, 'ok'), true)
  assert.equal(mediaRuntimeInstalled(bundled, root, metal, { tag: bundled.runtime.tag }, 'ok'), process.platform === 'darwin' && process.arch === 'arm64', 'an older Mac record without a variant is the platform default')
  assert.equal(mediaRuntimeInstalled(bundled, root, metal, { tag: 'other' }, 'ok'), false)
  assert.equal(mediaRuntimeInstalled(bundled, root, metal, { tag: bundled.runtime.tag, variant: 'metal' }, 'warn'), false)


  const dir = join(proofHome, 'windows-road')
  const windows = process.platform === 'win32'
  process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules'
  const REFUSAL = "The 'Expand-Archive' command was found in the module 'Microsoft.PowerShell.Archive', but the module could not be loaded. For more information, run 'Import-Module Microsoft.PowerShell.Archive'."
  const EXPAND = "^try { Expand-Archive -LiteralPath '\\(.*\\)' -DestinationPath '\\(.*\\)' -Force } catch .*$"
  const powershellCalls = join(dir, 'powershell-calls.txt')
  const tarCalls = join(dir, 'tar-calls.txt')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  mkdirSync(join(dir, 'tar'), { recursive: true })
  if (!windows) {
    const stub = join(dir, 'bin', 'powershell.exe')
    writeFileSync(stub, `#!/bin/sh\n[ "$1" = "-NoProfile" ] && [ "$2" = "-NonInteractive" ] && [ "$3" = "-EncodedCommand" ] || exit 9\nif [ -n "$PSModulePath" ]; then printf '%s\\n' "${REFUSAL}" >&2; exit 1; fi\nscript="$(printf %s "$4" | base64 -d | iconv -f UTF-16LE -t UTF-8)"\nprintf '%s\\n\\n' "$script" >> "${powershellCalls}"\narchive="$(printf '%s\\n' "$script" | sed -n "s/${EXPAND}/\\1/p")"\ndest="$(printf '%s\\n' "$script" | sed -n "s/${EXPAND}/\\2/p")"\n[ -n "$archive" ] && [ -n "$dest" ] || exit 8\nmkdir -p "$dest" && unzip -q -o "$archive" -d "$dest"\n`)
    chmodSync(stub, 0o755)
    const tar = join(dir, 'tar', 'tar.exe')
    writeFileSync(tar, `#!/bin/sh\n[ "$1" = "-xf" ] && [ "$3" = "-C" ] || exit 9\nprintf '%s\\n' "$*" >> "${tarCalls}"\nunzip -q -o "$2" -d "$4" >/dev/null 2>&1 || { printf '%s\\n' "tar: Error opening archive: Unrecognized archive format" >&2; exit 1; }\n`)
    chmodSync(tar, 0o755)
    const refused = spawnSync(stub, ['-NoProfile', '-NonInteractive', '-EncodedCommand', 'AA=='], { encoding: 'utf8', env: process.env })
    assert.equal(refused.status, 1)
    assert.equal(refused.stderr.trim(), REFUSAL, "the stub is the box: with PowerShell 7's PSModulePath inherited, 5.1's Expand-Archive refuses")
  }
  const zip = (name: string, members: Record<string, string>): string => {
    const archive = join(dir, name)
    writeFileSync(archive, zipSync(Object.fromEntries(Object.entries(members).map(([file, text]) => [file, new TextEncoder().encode(text)]))))
    return archive
  }
  const engineZip = zip('engine.zip', { 'sd-server.exe': 'engine', 'ggml-cuda.dll': 'backend', 'stable-diffusion.cpp.txt': 'MIT' })
  const cudartZip = zip('cudart.zip', { 'cudart64_12.dll': 'runtime', 'cublas64_12.dll': 'blas', 'cublasLt64_12.dll': 'lt' })
  const table = { tag: 'fixture-tag', platforms: { 'win32-x64': [
    { variant: 'vulkan', binary: 'sd-server.exe', files: [{ asset: 'engine.zip', bytes: statSync(engineZip).size, sha256: 'a'.repeat(64) }] },
    { variant: 'cuda12', binary: 'sd-server.exe', files: [{ asset: 'engine.zip', bytes: statSync(engineZip).size, sha256: 'a'.repeat(64) }, { asset: 'cudart.zip', bytes: statSync(cudartZip).size, sha256: 'b'.repeat(64) }] },
  ] } }
  process.env.MEDIA_ROOT = root
  type Unpack = { command: string; args: string[]; env?: NodeJS.ProcessEnv }
  const engine = await import(pathToFileURL(resolve(import.meta.dir, '../../src/extensions/bundled/mercury-media/server/setup.js')).href) as {
    setup: (...args: unknown[]) => Promise<{ ok: boolean; runtime?: { installed: boolean; variant: string | null } }>
    unpackCommand: (archive: string, dir: string, platform?: string, env?: NodeJS.ProcessEnv) => Unpack
    unpack: (archive: string, dir: string, signal?: AbortSignal, platform?: string, env?: NodeJS.ProcessEnv) => Promise<void>
  }
  const pulled: string[] = []
  const pull = async (url: string, target: string, spec: { bytes: number }, emit: (event: Record<string, unknown>) => void) => { pulled.push(basename(url)); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, readFileSync(join(dir, basename(target)))); emit({ event: 'done', file: target, bytes: spec.bytes, total: spec.bytes }); return 'downloaded' }
  const runtimeDir = join(root, 'runtime', 'fixture-tag', 'cuda12')

  if (!windows) process.env.PATH = [join(dir, 'tar'), join(dir, 'bin'), savedPath ?? ''].join(delimiter)
  const viaTar = engine.unpackCommand(join(root, 'runtime', 'engine.zip'), runtimeDir, 'win32')
  assert.equal(basename(viaTar.command), 'tar.exe')
  if (windows) assert.match(viaTar.command, /\\System32\\tar\.exe$/i, 'the tar.exe Windows ships, found through SystemRoot before PATH')
  else assert.equal(viaTar.command, join(dir, 'tar', 'tar.exe'))
  assert.deepEqual(viaTar.args, ['-xf', join(root, 'runtime', 'engine.zip'), '-C', runtimeDir])
  const events: Record<string, unknown>[] = []
  assert.equal((await engine.setup('pull-runtime', undefined, root, (event: Record<string, unknown>) => events.push(event), { ...fixtureCatalogue, runtime: table }, undefined, pull, { platform: 'win32', arch: 'x64', variant: 'cuda12' })).ok, true)
  assert.deepEqual(pulled, ['engine.zip', 'cudart.zip'])
  assert.deepEqual(events.at(-1), { event: 'done', command: 'pull-runtime', tag: 'fixture-tag', variant: 'cuda12' })
  const record = JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')) as { tag: string; variant: string; binary: string; archives: string[] }
  assert.equal(record.variant, 'cuda12')
  assert.equal(record.binary, join(runtimeDir, 'sd-server.exe'))
  assert.deepEqual(record.archives, ['engine.zip', 'cudart.zip'])
  for (const file of ['sd-server.exe', 'ggml-cuda.dll', 'cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']) assert.ok(existsSync(join(runtimeDir, file)), file)
  if (!windows) {
    assert.deepEqual(readFileSync(tarCalls, 'utf8').trim().split('\n'), [`-xf ${join(root, 'runtime', 'engine.zip')} -C ${runtimeDir}`, `-xf ${join(root, 'runtime', 'cudart.zip')} -C ${runtimeDir}`])
    assert.equal(existsSync(powershellCalls), false, 'powershell.exe is never asked while tar.exe exists')
  }
  const status = await engine.setup('status', undefined, root, () => {}, { ...fixtureCatalogue, runtime: table }, undefined, pull, { platform: 'win32', arch: 'x64' })
  assert.deepEqual(status.runtime, { installed: true, tag: 'fixture-tag', variant: 'cuda12' })
  assert.equal(mediaRuntimeInstalled(parseMediaCatalogue({ ...fixtureCatalogue, runtime: table }), root, { variant: 'cuda12', binary: 'sd-server.exe', words: 'CUDA 12', bytes: 1, args: [] }, undefined, 'ok'), true, 'the product reads the variant the engine recorded')
  await assert.rejects(engine.setup('pull-runtime', undefined, root, () => {}, { ...fixtureCatalogue, runtime: table }, undefined, pull, { platform: 'win32', arch: 'arm64' }), { message: 'There is no runtime variant for this platform (win32-arm64). Install a compatible local runtime for this platform.' })

  const fallbackDir = join(dir, 'fallback')
  const script = `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\ntry { Expand-Archive -LiteralPath '${engineZip}' -DestinationPath '${fallbackDir}' -Force } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\n`
  const noTar = windows ? { ...process.env, PATH: '', SystemRoot: '', windir: '' } : { ...process.env, PATH: [join(dir, 'bin'), savedPath ?? ''].join(delimiter) }
  const fallback = engine.unpackCommand(engineZip, fallbackDir, 'win32', noTar)
  assert.equal(fallback.command, 'powershell.exe')
  assert.deepEqual(fallback.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.equal(Buffer.from(fallback.args[3]!, 'base64').toString('utf16le'), script)
  assert.equal(Object.keys(fallback.env ?? {}).some(key => key.toLowerCase() === 'psmodulepath'), false, "the child never inherits the launching shell's PSModulePath")
  mkdirSync(fallbackDir, { recursive: true })
  if (windows) {
    const real = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
    const ran = spawnSync(fallback.command, fallback.args, { env: real, encoding: 'utf8', windowsHide: true })
    assert.equal(ran.status, 0, `the real powershell.exe without PSModulePath: ${ran.stderr}`)
  } else {
    await engine.unpack(engineZip, fallbackDir, undefined, 'win32', noTar)
    const calls = readFileSync(powershellCalls, 'utf8').split('\n\n').filter(Boolean)
    assert.deepEqual(calls, [script.trimEnd()])
  }
  assert.ok(existsSync(join(fallbackDir, 'sd-server.exe')), 'the fallback unpacked the fixture archive')

  const bogus = join(dir, 'bogus.zip')
  writeFileSync(bogus, 'not an archive\n')
  mkdirSync(join(dir, 'bogus'), { recursive: true })
  await assert.rejects(engine.unpack(bogus, join(dir, 'bogus'), undefined, 'win32'), (error: Error) => { assert.match(error.message, /^tar\.exe exited \d+: tar: /, error.message); return true })
  console.log('media runtime variants: table and old row parse; variant per platform, arch and GPU; row words per variant; pull plan with --variant; docs sizes; the vendored Windows unpack road through tar.exe with fixture archives, the powershell.exe fallback without PSModulePath, and a failed unpack naming the child\'s last stderr line; runtime.json carries the variant')
} finally {
  process.env.PATH = savedPath
  if (savedModulePath === undefined) delete process.env.PSModulePath
  else process.env.PSModulePath = savedModulePath
  rmSync(proofHome, { recursive: true, force: true })
}

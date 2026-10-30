#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'python-pack '))
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home', '.mercury')
process.env.MERCURY_VERSIONS_DIR = join(scratch, 'home', '.mercury', 'versions')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_PYTHON_VENDOR_DIR

const {
  PYTHON_PACK_PATH,
  PYTHON_PACK_PLATFORMS,
  checkVendoredPython,
  payloadVendoredPython,
  pythonBinaryFor,
  pythonMinorOf,
  pythonPackKeeps,
  pythonPackPlatform,
  pythonPackSelectionFor,
  pythonStdlibFor,
  readPythonRecord,
} = await import('../../src/services/privateChannel/vendoredPython.js')
const { validatePayloadDir } = await import('../../src/services/privateChannel/installLayout.js')
const { verifyPayloadDir } = await import('../../src/services/privateChannel/artifactVerify.js')

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const BUN = process.execPath
const IS_WIN = process.platform === 'win32'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

interface Lock {
  name: string
  version: string
  release: string
  repository: string
  license: string
  licenseFiles: string[]
  licenceTexts: Record<string, string>
  checksums: string
  platforms: Record<string, { target: string; archive: string; url: string; sha256: string; sizeBytes: number }>
}
const lock = JSON.parse(read('vendor/python.lock.json')) as Lock

section('§1 the lock — one python-build-standalone archive + sha256 per platform, the licence texts pinned')
{
  check('the lock names python', lock.name === 'python')
  check('the lock pins one CPython patch version', /^3\.\d+\.\d+$/.test(lock.version), lock.version)
  check('the lock names the upstream release tag', /^\d{8}$/.test(lock.release), lock.release)
  check('the repository is python-build-standalone', lock.repository === 'https://github.com/astral-sh/python-build-standalone')
  check('the licence is Python-2.0 with LICENSE.txt at the pack root', lock.license === 'Python-2.0' && lock.licenseFiles[0] === 'LICENSE.txt')
  check('the checksum source is that release\'s SHA256SUMS asset', lock.checksums === `${lock.repository}/releases/download/${lock.release}/SHA256SUMS`, lock.checksums)
  const platforms = Object.keys(lock.platforms).sort()
  check('the lock pins exactly the six pack platforms', JSON.stringify(platforms) === JSON.stringify([...PYTHON_PACK_PLATFORMS].sort()), platforms.join(','))
  const digests = new Set<string>()
  for (const platform of PYTHON_PACK_PLATFORMS) {
    const p = lock.platforms[platform]!
    const archive = `cpython-${lock.version}+${lock.release}-${p.target}-install_only_stripped.tar.gz`
    check(`${platform}: archive is the install_only_stripped tarball for ${p.target}`, p.archive === archive, p.archive)
    check(`${platform}: url is that release's asset`, p.url === `${lock.repository}/releases/download/${lock.release}/${archive.replace('+', '%2B')}`, p.url)
    check(`${platform}: sha256 is a 64-hex digest and sizeBytes a byte count`, /^[0-9a-f]{64}$/.test(p.sha256) && Number.isInteger(p.sizeBytes) && p.sizeBytes > 0)
    digests.add(p.sha256)
  }
  check('the six digests are distinct', digests.size === PYTHON_PACK_PLATFORMS.length)
  const texts = Object.entries(lock.licenceTexts)
  check('every licence text the lock lists is tracked under vendor/python-licences with its digest', texts.length >= 10 && texts.every(([name, digest]) => existsSync(join(ROOT, 'vendor', 'python-licences', name)) && sha256(readFileSync(join(ROOT, 'vendor', 'python-licences', name))) === digest))
  check('every licenses/ member of licenseFiles has a pinned text', lock.licenseFiles.filter(f => f !== 'LICENSE.txt').every(f => f.startsWith('licenses/') && lock.licenceTexts[f.slice('licenses/'.length)] !== undefined))
}

section('§2 the owner — platform keys, the binary, the stdlib, the selection law, the record, the check')
{
  check('darwin/arm64 → darwin-arm64 · win32/x64 → win-x64 · linux/arm64 → linux-arm64', pythonPackPlatform('darwin', 'arm64') === 'darwin-arm64' && pythonPackPlatform('win32', 'x64') === 'win-x64' && pythonPackPlatform('linux', 'arm64') === 'linux-arm64')
  check('unpublished pairs answer null', pythonPackPlatform('freebsd', 'x64') === null && pythonPackPlatform('linux', 'ia32') === null)
  check('the pack path is the fixed vendor/python', PYTHON_PACK_PATH === 'vendor/python')
  check('the binary is bin/python3 on every POSIX pack and python.exe on both Windows packs', PYTHON_PACK_PLATFORMS.every(p => pythonBinaryFor(p) === (p.startsWith('win-') ? 'python.exe' : 'bin/python3')))
  check('the minor of the pinned version drives the stdlib directory', pythonMinorOf('3.14.10') === '3.14' && pythonStdlibFor('linux-x64', '3.14.10') === 'lib/python3.14' && pythonStdlibFor('win-x64', '3.14.10') === 'Lib')
  const posix = pythonPackSelectionFor('darwin-arm64', '3.14.10')
  check('POSIX: the interpreter member is bin/python3.14, the one root is the stdlib, the licence is the stdlib LICENSE.txt', posix.interpreter === 'bin/python3.14' && JSON.stringify(posix.roots) === JSON.stringify(['lib/python3.14']) && posix.licence === 'lib/python3.14/LICENSE.txt')
  const win = pythonPackSelectionFor('win-x64', '3.14.10')
  check('Windows: python.exe, the two python DLLs, both vcruntime DLLs, DLLs and Lib; the root LICENSE.txt', win.interpreter === 'python.exe' && JSON.stringify(win.roots) === JSON.stringify(['python314.dll', 'python3.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'DLLs', 'Lib']) && win.licence === 'LICENSE.txt')
  const kept = ['lib/python3.14/os.py', 'lib/python3.14/LICENSE.txt', 'lib/python3.14/lib-dynload/_dbm.cpython-314-darwin.so', 'lib/python3.14/asyncio/__init__.py', 'lib/python3.14/venv/__init__.py', 'lib/python3.14/unittest/mock.py']
  const dropped = ['lib/python3.14/__pycache__/os.cpython-314.pyc', 'lib/python3.14/site-packages/pip/__init__.py', 'lib/python3.14/ensurepip/__init__.py', 'lib/python3.14/idlelib/idle.py', 'lib/python3.14/tkinter/__init__.py', 'lib/python3.14/turtledemo/clock.py', 'lib/python3.14/turtle.py', 'lib/python3.14/test/test_os.py', 'lib/python3.14/config-3.14-darwin/libpython3.14.a', 'lib/python3.14/lib-dynload/_tkinter.cpython-314-darwin.so', 'lib/python3.14/encodings/__pycache__/utf_8.cpython-314.pyc']
  check('POSIX law keeps the standard library, its licence, the dbm extension, asyncio, venv and unittest', kept.every(rel => pythonPackKeeps(posix, rel)))
  check('POSIX law drops bytecode caches, pip, ensurepip, IDLE, tkinter, turtle, the test suite, the config dir and the tk extension', dropped.every(rel => !pythonPackKeeps(posix, rel)))
  const winKept = ['Lib/os.py', 'DLLs/_ssl.pyd', 'DLLs/libcrypto-3-x64.dll', 'DLLs/sqlite3.dll', 'DLLs/_ctypes.pyd', 'Lib/venv/__init__.py']
  const winDropped = ['Lib/__pycache__/os.cpython-314.pyc', 'Lib/site-packages/pip/__init__.py', 'Lib/ensurepip/__init__.py', 'Lib/idlelib/idle.py', 'Lib/tkinter/__init__.py', 'Lib/test/test_os.py', 'DLLs/_tkinter.pyd', 'DLLs/tcl90.dll', 'DLLs/tcl9tk90.dll', 'DLLs/_testcapi.pyd', 'DLLs/_testinternalcapi.pyd', 'DLLs/_ctypes_test.pyd']
  check('Windows law keeps the standard library, the ssl, sqlite and ctypes extensions and their DLLs', winKept.every(rel => pythonPackKeeps(win, rel)))
  check('Windows law drops bytecode caches, pip, ensurepip, IDLE, tkinter, the test suite, the tk DLLs and the test extensions', winDropped.every(rel => !pythonPackKeeps(win, rel)))

  const good = {
    vendored: true as const,
    path: 'vendor/python',
    binary: 'bin/python3',
    name: 'python' as const,
    version: '3.14.10',
    release: '20261026',
    platform: 'linux-x64' as const,
    license: 'Python-2.0',
    archiveSha256: 'a'.repeat(64),
    binarySha256: 'b'.repeat(64),
  }
  check('a vendored record decodes whole', JSON.stringify(readPythonRecord({ pythonRuntime: good })) === JSON.stringify(good))
  check('an absent-pack record decodes as vendored:false with its remedy', (() => { const r = readPythonRecord({ pythonRuntime: { vendored: false, path: 'vendor/python', remedy: 'fetch it' } }); return r !== null && r.vendored === false && r.remedy === 'fetch it' })())
  check('a manifest without a record answers null (an older build)', readPythonRecord({ schema: 2, version: '1.0.0', runtime: { vendored: true } }) === null)
  check('a vendored record with a bad digest, an unknown platform or a foreign name answers null', readPythonRecord({ pythonRuntime: { ...good, binarySha256: 'zz' } }) === null && readPythonRecord({ pythonRuntime: { ...good, platform: 'plan9-mips' } }) === null && readPythonRecord({ pythonRuntime: { ...good, name: 'pypy' } }) === null)
  check('garbage answers null', readPythonRecord(null) === null && readPythonRecord('x') === null && readPythonRecord({ pythonRuntime: 7 }) === null)

  const payload = join(scratch, 'owner-payload')
  const bytes = '#!/bin/sh\necho fixture\n'
  mkdirSync(join(payload, 'vendor', 'python', 'bin'), { recursive: true })
  writeFileSync(join(payload, 'vendor', 'python', 'bin', 'python3'), bytes)
  const record = { ...good, binarySha256: sha256(bytes) }
  check('presence check: ok when the interpreter is on disk', checkVendoredPython(payload, record).state === 'ok')
  check('digest check: ok when the bytes match the record', checkVendoredPython(payload, record, { digest: true }).state === 'ok')
  const drifted = checkVendoredPython(payload, { ...record, binarySha256: 'c'.repeat(64) }, { digest: true })
  check('digest check: mismatch names the pack and both digests', drifted.state === 'mismatch' && drifted.note.includes('vendor/python/bin/python3') && drifted.note.includes('cccccccccccc'))
  check('presence check alone never reads the bytes', checkVendoredPython(payload, { ...record, binarySha256: 'c'.repeat(64) }).state === 'ok')
  const absent = checkVendoredPython(join(scratch, 'nowhere'), record)
  check('presence check: absent names the declared path', absent.state === 'absent' && absent.note.includes('vendor/python/bin/python3'))
  writeFileSync(join(payload, 'manifest.json'), JSON.stringify({ version: '9.9.0', pythonRuntime: record }) + '\n')
  const carried = payloadVendoredPython(payload)
  check('payloadVendoredPython reads the manifest and resolves the interpreter', carried !== null && carried.binaryPath === join(payload, 'vendor', 'python', 'bin', 'python3'))
  check('payloadVendoredPython answers null for a payload without a manifest', payloadVendoredPython(join(scratch, 'nowhere')) === null)
}

section('§3 the fetch — the owner imported, one tar invocation, --check, the setup chain')
{
  const fetcher = read('scripts/vendor/fetch-python.ts')
  check('the fetch extracts through the shared dialect-proof helper', fetcher.includes("from './tarExtract.ts'") && !fetcher.includes("spawnSync('tar'"))
  check('the fetch imports the law from the owner (never a second spelling)', fetcher.includes("from '../../src/services/privateChannel/vendoredPython.ts'") && fetcher.includes('pythonBinaryFor(') && fetcher.includes('pythonPackSelectionFor(') && fetcher.includes('pythonPackKeeps(') && fetcher.includes('pythonPackPlatform('))
  check('the fetch carries --check · --force · --platform · --all', ['--check', '--force', '--platform', '--all'].every(f => fetcher.includes(`'${f}'`)))
  check('the fetch refuses a lock url off the pinned release', fetcher.includes('is not the pinned release\'s asset'))
  check('the fetch verifies size and sha256 BEFORE writing the archive', fetcher.indexOf('digest !== pinned.sha256') !== -1 && fetcher.indexOf('digest !== pinned.sha256') < fetcher.indexOf('writeFileSync(archivePath, buf)') && fetcher.includes('buf.byteLength !== pinned.sizeBytes'))
  check('the fetch verifies every tracked licence text against the lock before it ships', fetcher.includes("does not match the lock's digest"))
  check('an unpublished host is an honest exit 0, never a silent success', fetcher.includes('publishes no interpreter archive') && fetcher.includes('process.exit(0)'))
  check('the cache layout: archive/ + extracted/<platform>/ + the vendor manifest', fetcher.includes("join(CACHE_DIR, 'archive')") && fetcher.includes("join(CACHE_DIR, 'extracted')") && fetcher.includes('.vendor-manifest.json'))
  check('the fetch is chained into `bun run setup` beside the node fetch', (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts.setup.includes('bun run scripts/vendor/fetch-node.ts && bun run scripts/vendor/fetch-python.ts'))
  check('the vendor cache is ignored like the other packs', read('.gitignore').split('\n').includes('vendor/python/'))
  const host = pythonPackPlatform(process.platform, process.arch)
  const extracted = host ? join(ROOT, 'vendor', 'python', 'extracted', host) : null
  const r = spawnSync(BUN, ['run', join(ROOT, 'scripts', 'vendor', 'fetch-python.ts'), '--check'], { encoding: 'utf8', timeout: 120_000, env: { ...process.env } })
  if (extracted && existsSync(join(extracted, '.vendor-manifest.json'))) {
    check('--check exits 0 for a present cache', r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}`)
    const vman = JSON.parse(readFileSync(join(extracted, '.vendor-manifest.json'), 'utf8')) as { version: string; release: string; platform: string; binary: string; archiveSha256: string }
    check('the vendor manifest agrees with the lock', vman.version === lock.version && vman.release === lock.release && vman.platform === host && vman.binary === pythonBinaryFor(host!) && vman.archiveSha256 === lock.platforms[host!]!.sha256)
    for (const lf of lock.licenseFiles) check(`licence preserved in the cache: ${lf}`, existsSync(join(extracted, ...lf.split('/'))))
    const dropped = [`${pythonStdlibFor(host!, lock.version)}/site-packages`, `${pythonStdlibFor(host!, lock.version)}/ensurepip`, `${pythonStdlibFor(host!, lock.version)}/idlelib`, `${pythonStdlibFor(host!, lock.version)}/tkinter`, `${pythonStdlibFor(host!, lock.version)}/__pycache__`, 'include', 'share']
    check('the cache carries none of the dropped members', dropped.every(rel => !existsSync(join(extracted, ...rel.split('/')))))
    const py = spawnSync(join(extracted, ...pythonBinaryFor(host!).split('/')), ['-c', 'import sys, ssl, sqlite3, ctypes, decimal, lzma, bz2, json, asyncio; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    check('the cached interpreter runs its standard library (ssl · sqlite3 · ctypes · decimal · lzma · bz2 · json · asyncio) and reports the pinned version', py.status === 0 && py.stdout.trim() === lock.version, `exit ${py.status}: ${(py.stderr || py.stdout).slice(0, 200)}`)
  } else {
    check('--check exits 2 for an absent cache', r.status === 2, `exit ${r.status}`)
    check('--check names the remedy', (r.stderr ?? '').includes('fetch-python.ts'), (r.stderr ?? '').slice(0, 200))
  }
}

section('§4 the build row — fixed path, staleness guard, manifest record, degraded label, the shipped tree')
{
  const build = read('build.ts')
  check('build.ts imports the owner for the path + platform + binary', build.includes("await import('./src/services/privateChannel/vendoredPython.ts')"))
  check('build.ts reads vendor/python.lock.json and the shipped platform\'s cache', build.includes("'vendor', 'python.lock.json'") && build.includes("'vendor', 'python', 'extracted', packPlatform"))
  check('a PRESENT-but-stale cache fails the build naming the fetch', build.includes('vendor/python cache does not match vendor/python.lock.json') && build.includes('remedy: bun run scripts/vendor/fetch-python.ts'))
  check('the manifest carries the pythonRuntime record (version · release · platform · both digests)', build.includes('pythonRuntime: pythonVendored && pythonMeta') && build.includes('release: lock.release,') && build.includes("archiveSha256: pinned.sha256"))
  check("absence degrades as 'python-runtime'", build.includes("...(pythonVendored ? [] : ['python-runtime'])"))
  check('the proof seam MERCURY_BUILD_NO_VENDOR_PYTHON forces the degraded arm', build.includes("process.env.MERCURY_BUILD_NO_VENDOR_PYTHON === '1'"))
  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { degraded: string[] }
    const record = readPythonRecord(m)
    check('dist/manifest.json carries a pythonRuntime record', record !== null)
    if (record?.vendored) {
      const shipped = join(ROOT, 'dist', ...record.path.split('/'), ...record.binary.split('/'))
      check('the vendored claim ⇒ the interpreter ships and its bytes match the record', existsSync(shipped) && sha256(readFileSync(shipped)) === record.binarySha256)
      check('the record names the lock\'s version, release and platform', record.version === lock.version && record.release === lock.release && record.platform === pythonPackPlatform(process.platform, process.arch))
      check("degraded[] carries no 'python-runtime'", !m.degraded.includes('python-runtime'))
      for (const lf of lock.licenseFiles) check(`the shipped pack carries ${lf}`, existsSync(join(ROOT, 'dist', ...record.path.split('/'), ...lf.split('/'))))
      const py = spawnSync(shipped, ['-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
      check('the shipped interpreter runs from dist and reports the pinned version', py.status === 0 && py.stdout.trim() === lock.version, `exit ${py.status}: ${(py.stderr || py.stdout).slice(0, 200)}`)
    } else {
      check("the not-vendored claim ⇒ degraded[] carries 'python-runtime'", m.degraded.includes('python-runtime'))
    }
  } else {
    console.log('  [SKIP — LOUD] no dist/manifest.json; build first (the pooled gate prebuilds dist)')
    failures++
  }
  const out = join(scratch, 'degraded-dist')
  const r = spawnSync(BUN, ['run', join(ROOT, 'build.ts')], {
    encoding: 'utf8',
    timeout: 300_000,
    cwd: ROOT,
    env: { ...process.env, MERCURY_BUILD_OUTDIR: out, MERCURY_BUILD_NO_VENDOR_PYTHON: '1', MERCURY_BUILD_TIME: '2026-01-01T00:00:00.000Z' },
  })
  check('a build without the pack succeeds (the pack is optional for a source checkout)', r.status === 0, (r.stderr || r.stdout).slice(-300))
  if (r.status === 0) {
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { degraded: string[] }
    const record = readPythonRecord(m)
    check('scratch manifest: vendored:false with the fetch named as the remedy', record !== null && !record.vendored && record.remedy.includes('fetch-python'))
    check("scratch manifest: degraded includes 'python-runtime'", m.degraded.includes('python-runtime'))
    check('scratch dist ships NO python pack', !existsSync(join(out, 'vendor', 'python')))
  }
}

section('§5 the install layout and the verifier — carried, declared-but-missing, older payloads')
if (IS_WIN) {
  console.log('  [SKIP] sh fixture interpreters — POSIX hosts only')
} else {
  const fixtureBinary = '#!/bin/sh\nprintf "fixture python\\n"\n'
  const makePayload = (dir: string, version: string, mode: 'carried' | 'declared-but-missing' | 'none'): void => {
    mkdirSync(join(dir, 'vendor', 'ripgrep', 'stub'), { recursive: true })
    writeFileSync(join(dir, 'vendor', 'ripgrep', 'stub', 'rg'), 'stub\n')
    writeFileSync(join(dir, 'mercury.mjs'), 'console.log("fixture")\n')
    writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexec node "$(dirname "$0")/mercury.mjs" "$@"\n')
    chmodSync(join(dir, 'mercury'), 0o755)
    const manifest: Record<string, unknown> = { schema: 2, version, bundle: 'mercury.mjs' }
    if (mode !== 'none') {
      manifest.pythonRuntime = {
        vendored: true,
        path: 'vendor/python',
        binary: 'bin/python3',
        name: 'python',
        version: '3.14.10',
        release: '20261026',
        platform: 'linux-x64',
        license: 'Python-2.0',
        archiveSha256: 'a'.repeat(64),
        binarySha256: sha256(fixtureBinary),
      }
    }
    if (mode === 'carried') {
      mkdirSync(join(dir, 'vendor', 'python', 'bin'), { recursive: true })
      writeFileSync(join(dir, 'vendor', 'python', 'bin', 'python3'), fixtureBinary)
      chmodSync(join(dir, 'vendor', 'python', 'bin', 'python3'), 0o755)
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  }
  const carried = join(scratch, 'payload-carried')
  makePayload(carried, '9.9.0', 'carried')
  check('a payload that declares AND carries its python validates', validatePayloadDir(carried).state === 'ok')
  const missing = join(scratch, 'payload-declared-missing')
  makePayload(missing, '9.9.0', 'declared-but-missing')
  const refused = validatePayloadDir(missing)
  check('a payload that declares a python it does not carry is refused by name', refused.state === 'invalid' && refused.note.includes('vendored python missing') && refused.note.includes('vendor/python/bin/python3'), refused.state === 'invalid' ? refused.note : refused.state)
  const older = join(scratch, 'payload-older')
  makePayload(older, '9.9.0', 'none')
  check('a payload without a python record still validates (an older release installs and rolls back)', validatePayloadDir(older).state === 'ok')
  const fast = verifyPayloadDir(carried, { depth: 'fast' })
  check('intact + unsigned at fast: unsigned, with the python digest named unevaluated', fast.verdict.state === 'unsigned' && fast.unevaluated.some(u => u.includes('vendored python')))
  const deep = verifyPayloadDir(carried, { depth: 'deep' })
  check('intact + unsigned at deep: unsigned, nothing left unevaluated', deep.verdict.state === 'unsigned' && deep.unevaluated.length === 0)
  const corrupt = join(scratch, 'payload-corrupt')
  makePayload(corrupt, '9.9.0', 'carried')
  writeFileSync(join(corrupt, 'vendor', 'python', 'bin', 'python3'), fixtureBinary + '# a flipped byte\n')
  const corruptDeep = verifyPayloadDir(corrupt, { depth: 'deep' })
  check('an interpreter whose bytes drift from the record is TAMPERED at deep, naming the pack', corruptDeep.verdict.state === 'tampered' && corruptDeep.verdict.note.includes('vendor/python/bin/python3'))
  check('the same drift passes fast (presence only)', verifyPayloadDir(corrupt, { depth: 'fast' }).verdict.state === 'unsigned')
  const gone = verifyPayloadDir(missing, { depth: 'fast' })
  check('a declared python that is absent is TAMPERED at fast (presence is bound at every depth)', gone.verdict.state === 'tampered' && gone.verdict.note.includes('absent'))
}

section('§6 the packager, the release road and the notices')
{
  const packager = read('scripts/release/package.mjs')
  check('the packager refuses a dist whose python platform is not the target\'s', packager.includes('pythonRuntime.platform !== TARGET_NODE_PACK'))
  check('the packager requires the declared interpreter on disk', packager.includes('declares the vendored python at'))
  check('the smoke runs the extracted archive\'s own interpreter', packager.includes('the vendored python did not run from the archive'))
  check('the smoke asserts the shipped manifest carries the python record', packager.includes('does not carry the vendored python record'))
  check('the packager never publishes an archive degraded by the pack (python-runtime is not a publishable degradation)', !/PUBLISHABLE_DEGRADATIONS = new Set\(\[[^\]]*python-runtime/.test(packager))
  const local = read('scripts/release/release-local.sh')
  check('the local release road fetches the python pack for the target', local.includes('bun run scripts/vendor/fetch-python.ts --platform "$1"'))
  const notices = read('THIRD_PARTY_NOTICES.md')
  check('THIRD_PARTY_NOTICES names the Python runtime with its receipt', notices.includes('**Python runtime**') && notices.includes('vendor/python.lock.json'))
  check('the notices generator reads the python lock', read('scripts/distribution/generate-third-party-notices.ts').includes("vendorLock('python.lock.json')"))
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
if (failures === 0) {
  console.log('PASS prove-python-pack')
  process.exit(0)
}
console.log(`FAIL prove-python-pack (${failures})`)
process.exit(1)

#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title} ──`)

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('hex')

function tarGz(members: Array<[name: string, bytes: Buffer]>): Buffer {
  const blocks: Buffer[] = []
  for (const [name, bytes] of members) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${bytes.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.byteLength % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const PACK_WASM = Buffer.from('bytes of the grammar the pack carries')
const MEMBER_WASM = Buffer.from('bytes of the grammar that is a member of its own tarball')
const DIRECT_WASM = Buffer.from('bytes of the grammar published as a file of its own')
const PACK_TGZ = tarGz([
  ['package/LICENSE', Buffer.from('the pack licence\n')],
  ['package/out/tree-sitter-packed.wasm', PACK_WASM],
])
const MEMBER_TGZ = tarGz([
  ['package/package.json', Buffer.from('{"name":"member"}\n')],
  ['package/tree-sitter-member.wasm', MEMBER_WASM],
])
const UNREACHABLE = 'https://127.0.0.1:27039'
const MEMBER_URL = `${UNREACHABLE}/member/-/member-1.0.0.tgz`

interface FixtureGrammar {
  wasm: string
  sha256: string
  bytes: number
  sourceUrl?: string
  sourceMember?: string
  sourceSha512?: string
  sourceProvenance?: string
  upstream: Record<string, string>
}

function baseGrammars(): FixtureGrammar[] {
  const upstream = { package: 'fixture', builtFromRange: '1.0.0', license: 'MIT', repository: 'https://example.invalid/fixture' }
  return [
    { wasm: 'tree-sitter-packed.wasm', sha256: sha256(PACK_WASM), bytes: PACK_WASM.byteLength, upstream },
    {
      wasm: 'tree-sitter-member.wasm',
      sha256: sha256(MEMBER_WASM),
      bytes: MEMBER_WASM.byteLength,
      sourceUrl: MEMBER_URL,
      sourceMember: 'package/tree-sitter-member.wasm',
      sourceSha512: sha512(MEMBER_TGZ),
      sourceProvenance: 'fixture: a member of a tarball of its own',
      upstream,
    },
    {
      wasm: 'tree-sitter-direct.wasm',
      sha256: sha256(DIRECT_WASM),
      bytes: DIRECT_WASM.byteLength,
      sourceUrl: `${UNREACHABLE}/direct/tree-sitter-direct.wasm`,
      sourceProvenance: 'fixture: a file of its own',
      upstream,
    },
  ]
}

function stage(grammars: FixtureGrammar[], opts: { memberTarball?: Buffer | null } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grammar-fetch-')))
  mkdirSync(join(root, 'scripts', 'vendor'), { recursive: true })
  for (const f of ['fetch-grammars.ts', 'tarExtract.ts']) copyFileSync(join(REPO, 'scripts', 'vendor', f), join(root, 'scripts', 'vendor', f))
  mkdirSync(join(root, 'vendor', 'grammars', 'tarball'), { recursive: true })
  writeFileSync(
    join(root, 'vendor', 'grammars.lock.json'),
    JSON.stringify({ name: 'fixture-pack', version: '0.0.1', tarball: 'fixture-pack-0.0.1.tgz', url: `${UNREACHABLE}/fixture-pack-0.0.1.tgz`, sha512: sha512(PACK_TGZ), licenseFiles: ['LICENSE'], grammars }, null, 2),
  )
  writeFileSync(join(root, 'vendor', 'grammars', 'tarball', 'fixture-pack-0.0.1.tgz'), PACK_TGZ)
  writeFileSync(join(root, 'vendor', 'grammars', 'tarball', 'tree-sitter-direct.wasm'), DIRECT_WASM)
  const memberTarball = opts.memberTarball === undefined ? MEMBER_TGZ : opts.memberTarball
  const member = grammars.find(g => g.sourceMember !== undefined && g.sourceSha512 !== undefined)
  if (memberTarball !== null && member) {
    writeFileSync(join(root, 'vendor', 'grammars', 'tarball', `${member.sourceSha512!.slice(0, 16)}-${basename(new URL(member.sourceUrl!).pathname)}`), memberTarball)
  }
  return root
}

function fetchRun(root: string, args: string[] = []): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'vendor', 'fetch-grammars.ts'), ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env: process.env })
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

const listed = (dir: string): string => (existsSync(dir) ? readdirSync(dir).sort().join(',') : '(absent)')

const extracted = (root: string, name: string): Buffer | null => {
  const p = join(root, 'vendor', 'grammars', 'extracted', name)
  return existsSync(p) ? readFileSync(p) : null
}

section('§1 — a grammar that is a member of a pinned tarball of its own is installed from it')
{
  const root = stage(baseGrammars())
  const run = fetchRun(root)
  check('the fetch settles from the verified local artifacts alone', run.status === 0, run.out.slice(-400))
  check('the member bytes are installed under the grammar name', extracted(root, 'tree-sitter-member.wasm')?.equals(MEMBER_WASM) === true, run.out.slice(-300))
  check('the pack grammar beside it is still taken from the pack', extracted(root, 'tree-sitter-packed.wasm')?.equals(PACK_WASM) === true)
  check('the grammar published as a file of its own is still taken as before', extracted(root, 'tree-sitter-direct.wasm')?.equals(DIRECT_WASM) === true)
  check('the source tarball was reused, not downloaded', run.out.includes('reusing verified source tarball'), run.out.slice(-400))
  check('nothing but the locked files, the licence and the manifest is installed', listed(join(root, 'vendor', 'grammars', 'extracted')) === '.vendor-manifest.json,LICENSE,tree-sitter-direct.wasm,tree-sitter-member.wasm,tree-sitter-packed.wasm', listed(join(root, 'vendor', 'grammars', 'extracted')))
  check('no extraction folder is left beside the cache', listed(join(root, 'vendor', 'grammars')) === 'extracted,tarball', listed(join(root, 'vendor', 'grammars')))
  const again = fetchRun(root, ['--check'])
  check('--check then reads the cache valid, offline', again.status === 0 && again.out.includes('cache valid against the lock'), again.out.slice(-200))
  rmSync(root, { recursive: true, force: true })
}

section('§2 — the member is held to its own digest, the tarball to its own')
{
  const wrongMember = baseGrammars()
  wrongMember[1]!.sha256 = sha256(Buffer.from('other bytes'))
  const a = stage(wrongMember)
  const runA = fetchRun(a)
  check('a member whose bytes are not the pinned ones is refused by name', runA.status === 1 && runA.out.includes('member sha256 mismatch for tree-sitter-member.wasm'), runA.out.slice(-300))
  check('and nothing is installed', extracted(a, 'tree-sitter-member.wasm') === null && extracted(a, 'tree-sitter-packed.wasm') === null)
  rmSync(a, { recursive: true, force: true })

  const b = stage(baseGrammars(), { memberTarball: tarGz([['package/tree-sitter-member.wasm', Buffer.from('a tarball that is not the pinned one')]]) })
  const runB = fetchRun(b)
  check('a cached tarball that is not the pinned one is not used', runB.status !== 0 && runB.out.includes('does not match the lock') && extracted(b, 'tree-sitter-member.wasm') === null, runB.out.slice(-300))
  rmSync(b, { recursive: true, force: true })

  const absent = baseGrammars()
  absent[1]!.sourceMember = 'package/tree-sitter-absent.wasm'
  const c = stage(absent)
  const runC = fetchRun(c)
  check('a member the tarball does not hold is refused by name', runC.status === 1 && runC.out.includes('has no package/tree-sitter-absent.wasm'), runC.out.slice(-300))
  rmSync(c, { recursive: true, force: true })
}

section('§3 — the lock is read strictly')
{
  const noDigest = baseGrammars()
  delete noDigest[1]!.sourceSha512
  const a = stage(noDigest)
  const runA = fetchRun(a)
  check('a member source with no digest for its tarball is refused before any fetch', runA.status === 1 && runA.out.includes('pins no sourceSha512 for that tarball') && !runA.out.includes('downloading'), runA.out.slice(-300))
  rmSync(a, { recursive: true, force: true })

  const escaping = baseGrammars()
  escaping[1]!.sourceMember = '../outside.wasm'
  const b = stage(escaping)
  const runB = fetchRun(b)
  check('a member path that leaves the tarball is refused', runB.status === 1 && runB.out.includes('leaves the tarball'), runB.out.slice(-300))
  rmSync(b, { recursive: true, force: true })

  const stray = baseGrammars()
  stray[2]!.sourceSha512 = sha512(MEMBER_TGZ)
  const c = stage(stray)
  const runC = fetchRun(c)
  check('a tarball digest on a grammar that names no member is refused', runC.status === 1 && runC.out.includes('names no sourceMember'), runC.out.slice(-300))
  rmSync(c, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\ngrammar fetch sources: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\ngrammar fetch sources: green')

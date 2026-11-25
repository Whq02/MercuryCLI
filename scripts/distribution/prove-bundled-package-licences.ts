#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'bundled-package-licences-'))
const HINT = 'regenerate THIRD_PARTY_NOTICES.md with bun scripts/distribution/generate-third-party-notices.ts so every bundled runtime package has its copyright notice and full licence text in NOTICES.md staged by scripts/release/package.mjs'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}${ok ? '' : ` — ${HINT}`}`)
}

const LICENSE_FILE_RE = /^(?:LICEN[CS]E|COPYING|COPYRIGHT)(?:[.-].*)?$/i
const README_FILE_RE = /^README(?:\..+)?$/i

function findFile(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null
  const matches = readdirSync(dir)
    .filter(name => pattern.test(name) && statSync(join(dir, name)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return matches[0] ?? null
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/`{3}/g, '` ` `').trimEnd()
}

function extractCopyrightLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^#?\s*(?:Copyright\s+(?:\(c\)\s*)?(?:\d{4}|[A-Z])|©)/.test(line)) return line
  }
  return null
}

function expectedHolder(pkgDir: string): string | null {
  const readme = findFile(pkgDir, README_FILE_RE)
  if (readme !== null) {
    const fromReadme = extractCopyrightLine(readFileSync(join(pkgDir, readme), 'utf8'))
    if (fromReadme !== null) return fromReadme
  }
  const metaPath = join(pkgDir, 'package.json')
  if (!existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { author?: string | { name?: string } }
  const author = typeof meta.author === 'string' ? meta.author.trim() : (meta.author?.name?.trim() ?? '')
  return author === '' ? null : `Copyright ${author}`
}

console.log('bundled package licences — every runtime package bundled into mercury.mjs has its copyright and licence text in packaged NOTICES.md')

try {
  const stageDir = join(SCRATCH, 'staged')
  const stageRun = spawnSync('node', [join(ROOT, 'scripts', 'release', 'package.mjs'), '--stage-notices', stageDir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const noticesPath = join(stageDir, 'NOTICES.md')
  check('package.mjs --stage-notices exits 0 and writes NOTICES.md', stageRun.status === 0 && existsSync(noticesPath), stageRun.stderr.trim())
  const notices = existsSync(noticesPath) ? readFileSync(noticesPath, 'utf8') : ''

  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const deps = Object.keys(rootPkg.dependencies ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const apacheText = normalizeText(readFileSync(join(ROOT, 'sdk', 'LICENSE'), 'utf8'))

  check(
    'NOTICES.md no longer claims licence texts stay only in node_modules',
    !notices.includes("Full licence texts are retained in each package's"),
  )

  const missingCopyright: string[] = []
  const missingLicenceText: string[] = []
  for (const name of deps) {
    const pkgDir = join(ROOT, 'node_modules', name)
    const meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      version?: string
      license?: string | { type?: string }
    }
    const version = meta.version ?? '?'
    const license = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNKNOWN')
    const licenseFile = findFile(pkgDir, LICENSE_FILE_RE)
    if (licenseFile !== null) {
      const content = normalizeText(readFileSync(join(pkgDir, licenseFile), 'utf8'))
      const copyrightLine = extractCopyrightLine(content) ?? expectedHolder(pkgDir)
      if (copyrightLine === null || !notices.includes(copyrightLine)) {
        missingCopyright.push(`${name}@${version} (${copyrightLine ?? 'unresolved holder'})`)
      }
      if (!notices.includes(content)) {
        missingLicenceText.push(`${name}@${version} (${licenseFile})`)
      }
    } else {
      const holder = expectedHolder(pkgDir)
      const holderLine = holder !== null && notices.split('\n').some(line => line.includes(name) && line.includes(holder))
      if (!holderLine) {
        missingCopyright.push(`${name}@${version} (${holder ?? 'unresolved holder'}, no licence file)`)
      }
      if (license !== 'Apache-2.0' || !notices.includes(apacheText)) {
        missingLicenceText.push(`${name}@${version} (${license}, no licence file)`)
      }
    }
  }

  check(
    `every bundled runtime package (${deps.length}) has its copyright notice in packaged NOTICES.md`,
    missingCopyright.length === 0,
    `${missingCopyright.length} missing: ${missingCopyright.slice(0, 10).join(', ')}${missingCopyright.length > 10 ? ` … (+${missingCopyright.length - 10} more)` : ''}`,
  )
  check(
    `every bundled runtime package (${deps.length}) has its full licence text in packaged NOTICES.md`,
    missingLicenceText.length === 0,
    `${missingLicenceText.length} missing: ${missingLicenceText.slice(0, 10).join(', ')}${missingLicenceText.length > 10 ? ` … (+${missingLicenceText.length - 10} more)` : ''}`,
  )

  const genOut = join(SCRATCH, 'generated-notices.md')
  const genRun = spawnSync(process.execPath, [join(ROOT, 'scripts', 'distribution', 'generate-third-party-notices.ts'), '--out', genOut], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  check(
    'packaged NOTICES.md matches generate-third-party-notices.ts output byte for byte',
    genRun.status === 0 && existsSync(genOut) && readFileSync(genOut, 'utf8') === notices,
    genRun.status !== 0 ? `rc=${genRun.status} ${genRun.stderr.trim()}` : !existsSync(genOut) ? 'generator did not write --out path' : 'packaged NOTICES.md differs from regenerated notices',
  )

  const contract = (await import('../release/payloadContract.mjs')) as {
    DOC_SET: string[]
    memberRole: (name: string) => string
    readCompatFloor: () => unknown
    releaseLayoutSection: (dir: string, target: string, floor: unknown) => { members: Array<{ path: string; role: string; bytes?: number }> }
    topAllowlist: (target: string, floor: unknown) => string[]
  }
  const layoutDir = join(SCRATCH, 'layout')
  mkdirSync(layoutDir, { recursive: true })
  writeFileSync(join(layoutDir, 'mercury.mjs'), 'export {}\n')
  writeFileSync(join(layoutDir, 'NOTICES.md'), notices)
  const floor = contract.readCompatFloor()
  const layout = contract.releaseLayoutSection(layoutDir, 'macos-arm64', floor)
  const noticeMember = layout.members.find(m => m.path === 'NOTICES.md')
  check(
    'payload contract accepts the staged NOTICES.md with role doc and unchanged allowlist',
    contract.DOC_SET.includes('NOTICES.md') &&
      contract.memberRole('NOTICES.md') === 'doc' &&
      ['macos-arm64', 'windows-x64'].every(target => contract.topAllowlist(target, floor).includes('NOTICES.md')) &&
      noticeMember?.role === 'doc' &&
      noticeMember.bytes === Buffer.byteLength(notices, 'utf8'),
  )
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? `\nbundled package licences: green (${checks} checks)` : `\nbundled package licences: RED (${failures}/${checks} failed)`)
process.exit(failures === 0 ? 0 : 1)

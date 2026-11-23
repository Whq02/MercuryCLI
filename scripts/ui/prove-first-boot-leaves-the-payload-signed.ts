#!/usr/bin/env bun
// gate-watch: src/platform/shell/ripgrep.ts src/boot/main.tsx src/screen/composer/MercuryContentSearch.tsx src/platform/update-channel/artifactVerify.ts src/platform/update-channel/installLayout.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { firstOutputTs, firstPtyVisibility, grabScreens, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import {
  FIXTURE_VERSION,
  buildSignedPayloadWithLinkerSignedRg,
  codesignFlags,
  flipOneByte,
  isLinkerSigned,
  sha256Of,
} from '../lib/signedRipgrepPayload.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const COLS = 120
const ROWS = 40
const COMPOSER_READY = 'Type a prompt'
const SEARCH_READY = 'grep'
const QUERY = 'small folder'
const README = '# a small folder for the first boot\n'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 700) : ''}${!cond && hint ? ' — to fix: ' + hint : ''}`)
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const arg = (key: string): string | undefined => (process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : undefined)
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

if (process.platform !== 'darwin') {
  console.log('prove-first-boot-leaves-the-payload-signed: SKIPPED — the ad-hoc re-sign of the vendored search binary exists on macOS only')
  process.exit(0)
}
requireDist()

const squash = (s: string): string => s.replace(/\s+/g, '')
const painted = (run: ArenaRun, words: string, notBefore = 0): { ts: number; text: string } | undefined => firstPtyVisibility(run.ptyReads, squash(words), notBefore)
const steady = (row: string): string => row.replace(/flux-arena-cwd-[A-Za-z0-9]+/g, 'the-project').replace(/\b\d\d:\d\d:\d\d\b/g, 'hh:mm:ss').replace(/\s+$/, '')
const saveFrame = (name: string, rows: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), rows.map(steady).join('\n') + '\n')
}
const unfired = (run: ArenaRun): string => `${run.outcome.reason ?? 'complete'} · unfired ${JSON.stringify(run.outcome.report?.unfired ?? [])}`

const scratch = mkdtempSync(join(tmpdir(), 'first-boot-payload-'))
const versionsDir = join(scratch, 'versions')
process.env.MERCURY_VERSIONS_DIR = versionsDir
delete process.env.MERCURY_HOME

const { installPayload, resolveLayoutRoots } = await import('../../src/platform/update-channel/installLayout.ts')
const { verifyPayloadDir } = await import('../../src/platform/update-channel/artifactVerify.ts')

try {
  section('§1 install a signed release payload whose vendored rg is linker-signed, the way the archive ships it')
  const fixture = buildSignedPayloadWithLinkerSignedRg(join(scratch, 'archive', 'mercury'), { primary: DIST })
  check('the archive rg is linker-signed', isLinkerSigned(fixture.rgPath), codesignFlags(fixture.rgPath))
  const binDir = join(scratch, 'bin')
  const shimPath = join(binDir, 'mercury')
  const roots = { ...resolveLayoutRoots(), versionsDir, binDir, shimPath, shimSetPaths: [shimPath] }
  const scratchBase = resolve(scratch)
  for (const p of [roots.versionsDir, roots.binDir, roots.shimPath, ...(roots.shimSetPaths ?? [])]) {
    const rel = relative(scratchBase, resolve(p))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      console.log(`  [FAIL] SAFETY: layout root escapes scratch: ${p}`)
      process.exit(1)
    }
  }
  check('every layout root lies under scratch', true)
  const installed = installPayload(roots, fixture.dir, FIXTURE_VERSION)
  check('the payload installs through the updater\'s own install road', installed.state === 'installed', JSON.stringify(installed), 'read installPayload in src/platform/update-channel/installLayout.ts to see why the fixture payload was not accepted')
  const versionDir = join(versionsDir, FIXTURE_VERSION)
  const installedRg = join(versionDir, 'vendor', 'ripgrep', `${process.arch}-${process.platform}`, 'rg')
  const shippedSha = sha256Of(installedRg)
  check('the installed rg is the shipped one, still linker-signed', shippedSha === fixture.rgSha256 && isLinkerSigned(installedRg), codesignFlags(installedRg), 'installPayload in src/platform/update-channel/installLayout.ts must copy vendor/ripgrep/<arch>-<platform>/rg byte for byte and leave its signature alone')
  const control = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
  check('deep verification before any boot reads signed', control.verdict.state === 'signed', JSON.stringify(control.verdict), 'verifyPayloadDir in src/platform/update-channel/artifactVerify.ts reads this freshly installed payload as not signed; fix it there before looking at the boot')

  section('§2 boot the installed payload once, as a stranger would, and search the folder\'s contents (the road that re-signed the binary)')
  let configDir = ''
  const run = await runArtifactArena({
    turns: [],
    sends: [`after:${COMPOSER_READY}:1500:\\x18`, `after:${COMPOSER_READY}:1800:g`, `after:${SEARCH_READY}:800:${QUERY}`],
    seconds: 40,
    cols: COLS,
    rows: ROWS,
    keep: true,
    anchor: null,
    distPath: join(versionDir, 'mercury.mjs'),
    seedCwd: { 'README.md': README, 'notes.txt': 'one line\n' },
    seedHome: dir => {
      configDir = dir
    },
    extraEnv: { BROWSER: '/usr/bin/true', MERCURY_UPDATE_NOTICE: '0', MERCURY_VERSIONS_DIR: versionsDir },
  })
  try {
    const chatPaint = painted(run, COMPOSER_READY)
    const searchPaint = painted(run, SEARCH_READY, chatPaint?.ts ?? 0)
    const hitPaint = painted(run, 'README.md', searchPaint?.ts ?? 0)
    check('the installed payload booted to the chat', chatPaint !== undefined, unfired(run), 'the installed payload did not reach the chat composer; boot it by hand with node <versions dir>/mercury.mjs and read the first error')
    check('the content search opened (ctrl+x g)', searchPaint !== undefined, unfired(run), 'ctrl+x g should open the content search; look at src/screen/composer/MercuryContentSearch.tsx and the ctrl+x key binding')
    check('the search found the folder\'s file — the search binary ran through the product\'s own road', hitPaint !== undefined, unfired(run), 'the search did not list README.md; look at the ripgrep run in src/platform/shell/ripgrep.ts (resolveRipgrep, maybeRepairCodesign) and src/screen/composer/MercuryContentSearch.tsx')
    if (hitPaint !== undefined) {
      const [frame] = grabScreens(run, COLS, ROWS, [Math.max(0, hitPaint.ts - firstOutputTs(run) + 700)])
      const rows = frame ? frame.rows : []
      saveFrame(`first-boot-search-hit-${COLS}x${ROWS}`, rows)
      check('the hit row names the file and the matched words', rows.some(l => l.includes('README.md') && l.includes(QUERY)), rows.filter(l => l.includes('README')).join(' | '), 'the hit row in src/screen/composer/MercuryContentSearch.tsx must show the file name and the matched words')
    }

    section('§3 the payload is exactly what was signed; the re-signed copy lives under the config home')
    check('the installed rg bytes are unchanged by the boot', sha256Of(installedRg) === shippedSha, `${sha256Of(installedRg).slice(0, 12)} vs shipped ${shippedSha.slice(0, 12)} · ${codesignFlags(installedRg)}`, 'the boot rewrote the shipped rg; src/platform/shell/ripgrep.ts prepareSignedCopy must sign a copy under <home>/cache/ripgrep and never the installed file')
    check('…and still linker-signed, as shipped', isLinkerSigned(installedRg), codesignFlags(installedRg), 'the boot re-signed the installed rg; src/platform/shell/ripgrep.ts maybeRepairCodesign must re-sign only the cached copy')
    const after = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
    check('deep verification after the first boot reads signed — a clean install never reads TAMPERED', after.verdict.state === 'signed', JSON.stringify(after.verdict), 'the first boot changed the installed tree; src/platform/shell/ripgrep.ts must not write under the version dir, and verifyPayloadDir in src/platform/update-channel/artifactVerify.ts is what reads it')
    const cacheDir = join(configDir, 'cache', 'ripgrep')
    const copy = join(cacheDir, shippedSha.slice(0, 16), 'rg')
    check('the re-signed copy sits under <home>/cache/ripgrep/<digest>/rg, keyed by the shipped file\'s digest', existsSync(copy), existsSync(cacheDir) ? readdirSync(cacheDir).join(' · ') : `no cache dir under ${configDir}`, 'preparedRipgrepPath and prepareSignedCopy in src/platform/shell/ripgrep.ts decide this path')
    check('the copy carries a full ad-hoc signature, no longer linker-signed', existsSync(copy) && !isLinkerSigned(copy) && codesignFlags(copy).includes('adhoc'), existsSync(copy) ? codesignFlags(copy) : '', 'prepareSignedCopy in src/platform/shell/ripgrep.ts must run codesign --sign - on the copy so it is no longer linker-signed')
    check('nothing under the installed version dir was written by the boot (no new member)', readdirSync(versionDir).sort().join(',') === readdirSync(fixture.dir).sort().join(','), readdirSync(versionDir).join(','), 'something wrote into the installed version dir during boot; find the writer, the signed copy belongs under <home>/cache/ripgrep in src/platform/shell/ripgrep.ts')

    section('§4 a real change to the installed payload still reads TAMPERED')
    flipOneByte(installedRg)
    const tampered = verifyPayloadDir(versionDir, { depth: 'deep', roster: fixture.roster })
    check('one flipped byte in the installed rg: deep verification reads tampered', tampered.verdict.state === 'tampered' && tampered.verdict.note.includes('payload tree differs'), JSON.stringify(tampered.verdict), 'verifyPayloadDir in src/platform/update-channel/artifactVerify.ts must still read a changed file in the payload as tampered with a note naming payload tree differs')
  } finally {
    run.cleanup()
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-first-boot-leaves-the-payload-signed — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-first-boot-leaves-the-payload-signed — all checks pass')
process.exit(0)

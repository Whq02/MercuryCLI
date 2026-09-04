#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'estate-caps-home-')))
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'estate-caps-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const { walkMarkdownEstate, loadMarkdownFilesForSubdir, ESTATE_WALK_MAX_ENTRIES, ESTATE_WALK_MAX_DEPTH } = await import('../../src/utils/markdownConfigLoader.js')
const { bootNotes, _resetBootNotesForTesting } = await import('../../src/substrate/bootNotes.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 a small estate is complete, case-folded, sorted, through a symlinked directory')
{
  const estate = join(SCRATCH, 'small')
  const aside = join(SCRATCH, 'aside')
  mkdirSync(join(estate, 'nested'), { recursive: true })
  mkdirSync(aside)
  writeFileSync(join(estate, 'b.md'), '# b\n')
  writeFileSync(join(estate, 'A.MD'), '# a\n')
  writeFileSync(join(estate, 'nested', 'c.md'), '# c\n')
  writeFileSync(join(estate, 'notes.txt'), 'not markdown\n')
  writeFileSync(join(aside, 'd.md'), '# d\n')
  symlinkSync(aside, join(estate, 'linked'))
  const walk = await walkMarkdownEstate(estate)
  const names = walk.files.map(f => f.slice(estate.length + 1))
  check('the walk is complete with no reason', walk.complete && walk.reason === undefined, JSON.stringify(walk))
  check('both spellings, the nested file and the linked file are found', JSON.stringify(names) === JSON.stringify(['A.MD', 'b.md', 'linked/d.md', 'nested/c.md']), names.join(', '))
  check('the entries examined are counted (five at the root, one nested, one through the link)', walk.entries === 7, String(walk.entries))
  const missing = await walkMarkdownEstate(join(SCRATCH, 'absent'))
  check('a missing directory is an empty, complete estate', missing.complete && missing.files.length === 0 && missing.entries === 0, JSON.stringify(missing))
}

section('§2 a symlink loop ends')
{
  const estate = join(SCRATCH, 'loop')
  mkdirSync(join(estate, 'inner'), { recursive: true })
  writeFileSync(join(estate, 'inner', 'x.md'), '# x\n')
  symlinkSync(estate, join(estate, 'inner', 'back'))
  const t0 = Date.now()
  const walk = await walkMarkdownEstate(estate)
  check('the loop is complete (the cycle guard) within a second', walk.complete && Date.now() - t0 < 1_000, JSON.stringify(walk))
  check('the looped file is listed once', walk.files.length === 1 && walk.files[0]!.endsWith('inner/x.md'), walk.files.join(', '))
}

section('§3 an estate of 50,000 entries stops at the entry cap and says so')
const BIG = join(SCRATCH, 'big-project', '.mercury', 'skills')
{
  mkdirSync(BIG, { recursive: true })
  for (let d = 0; d < 100; d++) {
    const dir = join(BIG, `skill-${String(d).padStart(3, '0')}`)
    mkdirSync(dir)
    for (let f = 0; f < 500; f++) writeFileSync(join(dir, `note-${String(f).padStart(3, '0')}.md`), '')
  }
  const t0 = Date.now()
  const walk = await walkMarkdownEstate(BIG)
  const took = Date.now() - t0
  check('the walk stopped (complete: false)', walk.complete === false, JSON.stringify({ complete: walk.complete, reason: walk.reason }))
  check('the reason names the entry cap', (walk.reason ?? '').includes(`${ESTATE_WALK_MAX_ENTRIES} entries`), walk.reason)
  check('the entries examined stop at the cap', walk.entries === ESTATE_WALK_MAX_ENTRIES + 1, String(walk.entries))
  check('the files kept never exceed the cap', walk.files.length > 0 && walk.files.length <= ESTATE_WALK_MAX_ENTRIES, String(walk.files.length))
  check('the stopped walk took under three seconds', took < 3_000, `${took} ms`)
}

section('§4 a chain deeper than the depth cap stops at the depth cap')
{
  const estate = join(SCRATCH, 'deep')
  let dir = estate
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= ESTATE_WALK_MAX_DEPTH + 6; i++) {
    dir = join(dir, `level-${i}`)
    mkdirSync(dir)
    if (i === 3) writeFileSync(join(dir, 'shallow.md'), '')
    if (i === ESTATE_WALK_MAX_DEPTH + 6) writeFileSync(join(dir, 'buried.md'), '')
  }
  const walk = await walkMarkdownEstate(estate)
  check('the walk stopped at the depth cap and says so', walk.complete === false && (walk.reason ?? '').includes(`depth ${ESTATE_WALK_MAX_DEPTH}`), walk.reason)
  check('the file above the cap is kept, the buried one is not', walk.files.some(f => f.endsWith('shallow.md')) && !walk.files.some(f => f.endsWith('buried.md')), walk.files.join(', '))
}

section('§5 through the loader: the partial roster loads AND a boot note names the walk')
{
  _resetBootNotesForTesting()
  const files = await loadMarkdownFilesForSubdir('skills', join(SCRATCH, 'big-project'))
  const project = files.filter(f => f.source === 'projectSettings')
  check('the partial roster is served (never hidden)', project.length > 0 && project.length <= ESTATE_WALK_MAX_ENTRIES, String(project.length))
  const notes = bootNotes()
  const note = notes.find(n => n.text.includes('configuration walk') && n.text.includes('stopped early'))
  check('a warn boot note names the stopped walk', note !== undefined && note.kind === 'warn', JSON.stringify(notes))
}

section('§6 the owner never spawns a search process (source pins)')
{
  const loader = readFileSync(join(ROOT, 'src', 'utils', 'markdownConfigLoader.ts'), 'utf-8')
  check('no search-engine import in the loader', !loader.includes("from './ripgrep.js'"))
  check('the caps are named constants the loader exports', /export const ESTATE_WALK_MAX_ENTRIES = \d/.test(loader) && /export const ESTATE_WALK_MAX_DEPTH = \d/.test(loader))
}

rmSync(SCRATCH, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-estate-walk-caps: all green' : `\nprove-estate-walk-caps: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

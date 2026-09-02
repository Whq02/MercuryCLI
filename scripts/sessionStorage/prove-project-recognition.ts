#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-project-recognition.ts — ONE recognition law
//  on every surface (frontier smart-recognition, operator-ruled).
//
//  The split this retires: the resume picker classed sessions by a raw
//  subtree prefix join (sessionFilter.isProjectSession) while the concourse
//  board classed them by exact store-key equality (bootCardFacts.inProject)
//  — a subfolder session counted as the parent's work on one surface and as
//  a foreign project on the other. THE ONE LAW: a session belongs to a
//  project iff its workspace resolves to the project's own key (the exact
//  arm — aliases and config-home spellings heal there), OR it lives INSIDE
//  the project's tree with NO cataloged ground strictly nearer to it (the
//  walk-up arm; the pre-ruled carve: a subfolder that is ITSELF a cataloged
//  ground is its own project — nearest root wins). Recognition only:
//  stores and keys never move.
//
//  §1 agreement — the same session classes IDENTICALLY on picker and board
//  §2 the carve — a cataloged subfolder stays its own project, both surfaces
//  §3 foreign stays foreign — sibling · same-leaf twin · prefix-cousin
//  §4 spelling heal — symlink and trailing-slash spellings recognize
//  §5 no freeze — an answer over a failed canonicalization is never frozen
//  §6 the one door — sessionFilter derives through the recognition owner
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'project-recognition-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
delete process.env.MERCURY_HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { inProject, projectIdentity, catalogFirstChat, _resetProjectCatalogForTesting } = await import(
  '../../src/utils/bootCardFacts.ts'
)
const { isProjectSession } = await import('../../src/utils/sessionFilter.ts')
const log = (p: string): { projectPath: string } => ({ projectPath: p }) as never

// The estate under test: a cataloged parent project, an ordinary (never
// cataloged) subfolder tree, a subfolder that IS its own cataloged ground,
// a sibling, and a same-leaf-name twin in a different tree.
const P = join(SCRATCH, 'atlas')
const SUB = join(P, 'src', 'utils')
const CARVED = join(P, 'carved-ground')
const CARVED_DEEP = join(CARVED, 'nested')
const SIB = join(SCRATCH, 'other')
const TWIN_HOME = join(SCRATCH, 'twin-tree')
const TWIN = join(TWIN_HOME, 'atlas')
const COUSIN = P + '-orchard'
for (const d of [SUB, CARVED_DEEP, SIB, TWIN, COUSIN]) mkdirSync(d, { recursive: true })
catalogFirstChat(P, 'aaaaaaaa-0000-4000-8000-000000000001')
catalogFirstChat(CARVED, 'aaaaaaaa-0000-4000-8000-000000000002')
_resetProjectCatalogForTesting()
const pid = projectIdentity(P)

console.log('§1 — agreement: the same session classes IDENTICALLY on picker and board')
{
  check('BOARD: a subfolder session belongs to the project (the walk-up arm)', inProject(pid, SUB))
  check('PICKER: the same subfolder session is in-project', isProjectSession(log(SUB), P))
  check('BOARD: the root workspace belongs (the exact arm untouched)', inProject(pid, P))
  check('PICKER: the root workspace is in-project', isProjectSession(log(P), P))
  const agree = (ws: string): boolean => inProject(pid, ws) === isProjectSession(log(ws), P)
  check('the two surfaces answer AS ONE across the estate', [P, SUB, CARVED, CARVED_DEEP, SIB, TWIN, COUSIN].every(agree))
}

console.log('§2 — the carve: a cataloged subfolder stays its own project (nearest root wins)')
{
  check('BOARD: the cataloged subfolder is NOT the parent\'s row', !inProject(pid, CARVED))
  check('PICKER: the cataloged subfolder is NOT the parent\'s session', !isProjectSession(log(CARVED), P))
  check('the carved ground claims ITSELF', inProject(projectIdentity(CARVED), CARVED))
  check('a session DEEPER under the carved ground belongs to IT', inProject(projectIdentity(CARVED), CARVED_DEEP))
  check('…and not to the parent (the nearer ground intervenes)', !inProject(pid, CARVED_DEEP))
  check('PICKER agrees on the deep row too', !isProjectSession(log(CARVED_DEEP), P) && isProjectSession(log(CARVED_DEEP), CARVED))
}

console.log('§3 — foreign stays foreign')
{
  check('a sibling folder is foreign on both surfaces', !inProject(pid, SIB) && !isProjectSession(log(SIB), P))
  check('a same-leaf-name twin in another tree is foreign on both surfaces', !inProject(pid, TWIN) && !isProjectSession(log(TWIN), P))
  check('the prefix-cousin (atlas vs atlas-orchard) is foreign — the join is separator-anchored', !inProject(pid, COUSIN) && !isProjectSession(log(COUSIN), P))
}

console.log('§4 — living spellings heal at the recognition')
{
  const LINK = join(SCRATCH, 'sub-link')
  symlinkSync(SUB, LINK)
  check('a symlink spelling of the subfolder recognizes into the project (both surfaces)', inProject(pid, LINK) && isProjectSession(log(LINK), P))
  check('a trailing-slash spelling recognizes (both surfaces)', inProject(pid, SUB + '/') && isProjectSession(log(SUB + '/'), P))
}

console.log('§5 — no freeze: an answer over a failed canonicalization is never frozen')
{
  const LATER = join(P, 'not-yet-made')
  check('a not-yet-existing subfolder path still recognizes by its raw spelling (inside the tree, nothing nearer)', inProject(pid, LATER))
  mkdirSync(LATER, { recursive: true })
  catalogFirstChat(LATER, 'aaaaaaaa-0000-4000-8000-000000000003')
  check('once the folder exists AS ITS OWN CATALOGED GROUND the answer follows — nothing froze the earlier miss', !inProject(pid, LATER))
}

console.log('§6 — the one door: every surface derives through the recognition owner')
{
  const filter = readFileSync(join(process.cwd(), 'src/utils/sessionFilter.ts'), 'utf8')
  check('sessionFilter derives through the ONE recognition door (workspaceRecognizedByGround)', filter.includes('workspaceRecognizedByGround('))
  check('the raw prefix join is RETIRED from the picker\'s matcher', !filter.includes('p.startsWith(`${r}/`)'))
  const facts = readFileSync(join(process.cwd(), 'src/utils/bootCardFacts.ts'), 'utf8')
  check('inProject delegates to the same door (one law, one spelling)', facts.includes('return workspaceRecognizedByGround(project.dir, workspaceDir)'))
  check('the docblock carries the ruling\'s provenance (frontier-over-fossil: the WHY recorded)', facts.includes('frontier smart-recognition, operator-ruled'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-project-recognition: ONE LAW EVERYWHERE' : `\nprove-project-recognition: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-folder-project.ts — THE FOLDER IS THE PROJECT
//  (the operator's word): the five laws at their seams, executed in a
//  scratch config home. The real-boot halves — a bare boot's byte-identical
//  folder and the first birth on the built bundle — live in
//  prove-folder-project-drive.ts (the pool runs both).
//
//   F1  THE FOLDER IS NAMED FROM BOOT: a folder with no history is the
//       current project by its basename (currentProject / projectIdentity);
//       the Boot face's card and Dir chip and the concourse's project label
//       ride the ONE naming seam;
//   F2  NOTHING IS WRITTEN BEFORE THE FIRST CHAT: every read door of the
//       catalog (identity, current, the scan, the face facts) leaves a fresh
//       folder and a fresh store byte-identical; the one birth door is the
//       ONLY caller of the stamp, and stamps AFTER the daemon's admission;
//       the estate verb has ONE caller — the catalog owner;
//   F3  THE FIRST CHAT INITIALIZES THE CATALOG: the stamp creates
//       `<folder>/.mercury/` (an empty directory — nothing speculative) and
//       the project card; the folder then lists in workedInProjects — the
//       Boot face's Projects rows and the REPO picker render that one list
//       — and reads catalogued, with NO transcript yet; the Continue doors
//       never offer the wordless chat; the stamp is idempotent; once a
//       transcript exists the same row carries it;
//   F4  THE .mercury-PARENT NAMING: a `.mercury` folder wears its parent's
//       name at the identity door and in the scan rows; its estate is
//       itself (never a nested `.mercury/.mercury`); the home directory is
//       never initialized;
//   F5  PROJECT SCOPING: a second folder's chats never appear under the
//       first — inProject separates siblings and unifies a symlinked
//       spelling with its target; the beat fires on a ground move and on
//       the stamp, and stops after the unsubscribe;
//   F6  A PRE-CATALOG PROJECT READS CATALOGUED WITHOUT A WRITE (the lead's
//       ruling on law 2 — reads never write): a folder whose chats predate
//       the card lists, reads catalogued with a null stamp and its newest
//       chat, and no card appears on any read.
// ============================================================================
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'folder-project-')))
const HOME = join(SCRATCH, 'home')
const FOO = join(SCRATCH, 'foo')
const BAR = join(SCRATCH, 'bar')
const DELTA = join(SCRATCH, 'delta')
const EPSILON = join(SCRATCH, 'epsilon')
const GAMMA = join(SCRATCH, 'gamma')
const GAMMA_MERC = join(GAMMA, '.mercury')
const FOO_LINK = join(SCRATCH, 'foo-link')
for (const d of [HOME, FOO, BAR, DELTA, EPSILON, GAMMA_MERC]) mkdirSync(d, { recursive: true })
writeFileSync(join(FOO, 'README.md'), '# foo\n')
mkdirSync(join(FOO, 'src'))
writeFileSync(join(FOO, 'src', 'app.txt'), 'hello\n')
let linkOk = false
try {
  symlinkSync(FOO, FOO_LINK, 'dir')
  linkOk = true
} catch {
  /* a platform without symlinks skips the alias leg */
}
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(rel, 'utf8')

/** A content hash of a directory tree — names + bytes, every depth. */
function treeHash(root: string): string {
  const rows: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        rows.push(`d ${relative(root, p)}`)
        walk(p)
      } else {
        rows.push(`f ${relative(root, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
      }
    }
  }
  walk(root)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/** Every src file's text (for the one-caller needles). */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) srcFiles(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const facts = await import('../../src/utils/bootCardFacts.ts')
const paths = await import('../../src/services/projectLocal/paths.ts')
const state = await import('../../src/bootstrap/state.ts')
const portable = await import('../../src/utils/sessionStoragePortable.ts')
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

try {
  // ── F1: named from boot, no history ─────────────────────────────────────
  console.log('F1 — the folder is the project, by its name, from boot')
  {
    state.setCwdState(FOO)
    const current = facts.currentProject()
    check('F1 the launched folder is the current project by its basename', current.dir === FOO && current.name === 'foo', JSON.stringify(current))
    check('F1 with no history it is not yet catalogued (no stamp, no chat)', current.catalogued === false && current.firstChatAt === null && current.newestChat === null)
    check('F1 the identity key is the folder\'s own session-store dir', current.key === portable.getProjectDir(FOO))
    check('F1 the same ground answers the same identity within the window', facts.currentProject() === current)
    const face = read('src/components/BootSplashScreen.tsx')
    check('F1 the Boot face\'s card names the cwd through the ONE naming seam', face.includes('cwdBase: projectDisplayName(process.cwd())'))
    check('F1 the Boot face\'s Dir chip names the cwd through the ONE naming seam', face.includes('dir: projectDisplayName(process.cwd())') && !face.includes('basename(process.cwd())'))
    const snapshot = read('src/services/concourse/concourseSnapshot.ts')
    // The board is per-project (the control plane shows the
    // CURRENT project's chats): the label derives per projectDir through the
    // same ONE naming seam currentProject().name rode (projectDisplayName —
    // the catalog owner's door, config-home fold and naming guard inside).
    check('F1 the concourse\'s project label reads the ONE catalog owner', snapshot.includes('const projectLabel = sanitizeLabel(projectDisplayName(projectDir))') && !snapshot.includes('basename(seedOverrides.projectDir ?? getCwd())'))
    const launcher = read('assets/splash/mercury-splash.mjs')
    check('F1 the launcher\'s frame-0 sites ride the mirrored seam (byte-equal across the hand-off)', (launcher.match(/projectDisplayName\(process\.cwd\(\)\)/g) ?? []).length === 3)
  }

  // ── F2: nothing is written before the first chat ────────────────────────
  console.log('F2 — nothing is written before the first chat')
  {
    const folderBefore = treeHash(FOO)
    const homeBefore = treeHash(HOME)
    facts.projectIdentity(FOO)
    facts.currentProject()
    facts.workedInProjects()
    facts.scanBootCardFacts(FOO)
    facts.inProject(facts.projectIdentity(FOO), BAR)
    check('F2 the read doors leave the folder byte-identical', treeHash(FOO) === folderBefore)
    check('F2 the read doors leave the config home byte-identical (no store dir, no card)', treeHash(HOME) === homeBefore && !existsSync(join(HOME, 'projects')))
    check('F2 no `.mercury/` appeared in the folder', !existsSync(join(FOO, '.mercury')))
    check('F2 the list is empty — a folder with no chat is not a listed project (it is still the current one, by name)', facts.workedInProjects().length === 0)
    const born = read('src/services/switchboard/bornSession.ts')
    const refusal = born.indexOf("reason: String(reply.error ?? 'the session could not start')")
    const stamp = born.indexOf('catalogFirstChat(req.workspaceDir, sessionId)')
    const hop = born.indexOf('await hopIntoBoardSession(sessionId')
    check('F2 the birth door stamps AFTER the admission is accepted and before the hop (never on a refusal)', refusal > 0 && stamp > refusal && hop > stamp)
    const callers = srcFiles('src').filter(f => read(f).includes('catalogFirstChat(') && !f.endsWith('bootCardFacts.ts'))
    check('F2 the birth door is the ONE caller of the stamp', callers.length === 1 && callers[0]!.endsWith('bornSession.ts'), callers.join(','))
    const estateCallers = srcFiles('src').filter(f => read(f).includes('initializeProjectLocalEstate(') && !f.endsWith('projectLocal/paths.ts'))
    check('F2 the estate verb has ONE caller — the catalog owner', estateCallers.length === 1 && estateCallers[0]!.endsWith('bootCardFacts.ts'), estateCallers.join(','))
    const owner = read('src/utils/bootCardFacts.ts')
    const stampAt = owner.indexOf('export function catalogFirstChat')
    const afterStamp = owner.indexOf('export function', stampAt + 1)
    const body = owner.slice(stampAt, afterStamp)
    const outside = owner.slice(0, stampAt) + owner.slice(afterStamp)
    check('F2 the owner\'s only write verbs live inside the stamp', body.includes('mkdirSync(') && body.includes('durableAtomicPublishSync(') && !outside.includes('mkdirSync(') && !outside.includes('durableAtomicPublishSync(') && !outside.includes('writeFileSync('))
    const estate = read('src/services/projectLocal/paths.ts')
    check('F2 the estate verb creates exactly the directory (no marker files, no ignore rules)', estate.includes('mkdirSync(dir)') && !estate.includes('writeFileSync') && !estate.includes('gitignore'))
  }

  // ── F3: the first chat initializes the catalog ──────────────────────────
  console.log('F3 — the first chat initializes the catalog; the folder joins the selectable projects')
  {
    let beats: string[] = []
    const off = facts.subscribeCurrentProject(p => beats.push(`${p.name}:${p.catalogued}`))
    facts.catalogFirstChat(FOO, 'sid-foo-1')
    const estate = join(FOO, '.mercury')
    check('F3 the stamp created `<folder>/.mercury/`', existsSync(estate) && statSync(estate).isDirectory())
    check('F3 the estate is an empty directory — nothing speculative inside', readdirSync(estate).length === 0)
    const store = portable.getProjectDir(FOO)
    const cardPath = join(store, facts.PROJECT_CARD_FILE)
    check('F3 the project card sits in the folder\'s own session-store dir', existsSync(cardPath), cardPath)
    const card = JSON.parse(read(cardPath)) as Record<string, unknown>
    check('F3 the card names the folder, the stamp and the first session', card.schema === 1 && card.dir === FOO && typeof card.firstChatAt === 'number' && card.firstSessionId === 'sid-foo-1', JSON.stringify(card))
    check('F3 no transcript exists yet (a wordless first chat)', readdirSync(store).filter(f => f.endsWith('.jsonl')).length === 0)
    const listed = facts.workedInProjects()
    const row = listed.find(r => r.dir === FOO)
    check('F3 the folder joined the ONE list (workedInProjects) — by its name, with the stamp, without a transcript', row !== undefined && row.base === 'foo' && row.sessionId === null && row.transcriptPath === null && row.firstChatAt === card.firstChatAt, JSON.stringify(listed))
    const fromBar = facts.scanBootCardFacts(BAR)
    check('F3 the Boot face\'s Projects rows render it from another folder', fromBar.pickerProjects.some(p => p.dir === FOO && p.base === 'foo'))
    check('F3 the Continue doors never offer the wordless chat (no transcript ⇒ no Continue row, no cross-repo form)', facts.scanBootCardFacts(FOO).cwdProject === null && fromBar.recentLast === null)
    const identity = facts.projectIdentity(FOO)
    check('F3 the identity door reads catalogued with the stamp and no newest chat', identity.catalogued === true && identity.firstChatAt === card.firstChatAt && identity.newestChat === null)
    check('F3 the current project (the ground) is the catalogued folder now', facts.currentProject().catalogued === true)
    check('F3 the stamp emitted the beat with the catalogued identity', beats.includes('foo:true'), beats.join(' '))
    const picker = read('src/components/concourse/GroundPicker.tsx')
    const face = read('src/components/BootSplashScreen.tsx')
    check('F3 both listing surfaces render the ONE list (the picker rides workedInProjects, the face rides scanBootCardFacts)', picker.includes('m.workedInProjects()') && face.includes('scanBootCardFacts(process.cwd()'))
    // Idempotent: a second birth in the same folder changes nothing.
    const estateBefore = treeHash(estate)
    const cardBefore = read(cardPath)
    beats = []
    facts.catalogFirstChat(FOO, 'sid-foo-2')
    check('F3 a second birth leaves the estate and the card untouched (the first stamp stands)', treeHash(estate) === estateBefore && read(cardPath) === cardBefore)
    check('F3 the second birth still emits the beat (the board re-reads, cheaply)', beats.length === 1)
    off()
    // Words arrive: a transcript joins the store and the same row carries it.
    const transcript = join(store, 'aaaa-1111.jsonl')
    writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: FOO, message: { role: 'user', content: 'hello' } }) + '\n')
    const rowNow = facts.workedInProjects().find(r => r.dir === FOO)
    check('F3 once a transcript exists the row carries it (the resume door\'s target)', rowNow !== undefined && rowNow.sessionId === 'aaaa-1111' && rowNow.transcriptPath === transcript && rowNow.firstChatAt === card.firstChatAt, JSON.stringify(rowNow))
    check('F3 the Continue row offers the chat now', facts.scanBootCardFacts(FOO).cwdProject?.sessionId === 'aaaa-1111')
    check('F3 the identity\'s newest chat is that transcript', facts.projectIdentity(FOO).newestChat?.sessionId === 'aaaa-1111')
  }

  // ── F4: the .mercury-parent naming ──────────────────────────────────────
  console.log('F4 — a `.mercury` folder wears its parent\'s name; its estate is itself')
  {
    check('F4 the identity door names the parent', facts.projectIdentity(GAMMA_MERC).name === 'gamma' && facts.projectDisplayName(GAMMA_MERC) === 'gamma')
    state.setCwdState(GAMMA_MERC)
    check('F4 the current project names the parent while the path stays the truth', facts.currentProject().name === 'gamma' && facts.currentProject().dir === GAMMA_MERC)
    check('F4 the estate verb refuses a `.mercury` root (it IS the estate)', paths.initializeProjectLocalEstate(GAMMA_MERC) === null && !existsSync(join(GAMMA_MERC, '.mercury')))
    facts.catalogFirstChat(GAMMA_MERC, 'sid-gamma-1')
    check('F4 the stamp never nests a home', !existsSync(join(GAMMA_MERC, '.mercury')))
    const row = facts.workedInProjects().find(r => r.dir === GAMMA_MERC)
    check('F4 the scan row wears the parent\'s name with the dot-dir path beside it', row !== undefined && row.base === 'gamma' && row.dir === GAMMA_MERC)
    const homeEstateBefore = existsSync(join(homedir(), '.mercury'))
    check('F4 the home directory is never initialized as an estate', paths.initializeProjectLocalEstate(homedir()) === null && existsSync(join(homedir(), '.mercury')) === homeEstateBefore)
    check('F4 a filesystem root is never initialized', paths.initializeProjectLocalEstate('/') === null)
    check('F4 a vanished folder is never re-created for its estate', paths.initializeProjectLocalEstate(join(SCRATCH, 'never-existed')) === null && !existsSync(join(SCRATCH, 'never-existed')))
    const again = paths.initializeProjectLocalEstate(FOO)
    check('F4 an existing estate answers created:false and stays as it was', again !== null && again.created === false && readdirSync(join(FOO, '.mercury')).length === 0)
  }

  // ── F5: project scoping ─────────────────────────────────────────────────
  console.log('F5 — a second folder\'s chats never appear under the first')
  {
    facts.catalogFirstChat(BAR, 'sid-bar-1')
    const barStore = portable.getProjectDir(BAR)
    const barTranscript = join(barStore, 'bbbb-2222.jsonl')
    writeFileSync(barTranscript, JSON.stringify({ type: 'user', cwd: BAR, message: { role: 'user', content: 'bar words' } }) + '\n')
    const foo = facts.projectIdentity(FOO)
    const bar = facts.projectIdentity(BAR)
    check('F5 siblings are different projects (different keys)', foo.key !== bar.key && !facts.inProject(foo, BAR) && !facts.inProject(bar, FOO))
    check('F5 a folder belongs to itself', facts.inProject(foo, FOO) && facts.inProject(bar, BAR))
    if (linkOk) {
      check('F5 a symlinked spelling is the SAME project (realpath keys)', facts.inProject(foo, FOO_LINK) && facts.projectIdentity(FOO_LINK).key === foo.key)
    } else {
      console.log('  [SKIP] F5 symlink leg — no symlinks on this platform')
    }
    check('F5 an empty or absent workspace belongs to nothing', !facts.inProject(foo, '') && !facts.inProject(foo, join(SCRATCH, 'nowhere')))
    check('F5 foo\'s newest chat is foo\'s transcript, never bar\'s', foo.newestChat?.sessionId === 'aaaa-1111' && bar.newestChat?.sessionId === 'bbbb-2222')
    const rows = facts.workedInProjects()
    check('F5 the list carries each folder\'s own chat under its own row', rows.find(r => r.dir === FOO)?.sessionId === 'aaaa-1111' && rows.find(r => r.dir === BAR)?.sessionId === 'bbbb-2222')
    check('F5 the newest activity leads (bar\'s words came last)', rows[0]?.dir === BAR, rows.map(r => r.base).join(' · '))
    // The beat: a ground move and a stamp both fire; the unsubscribe stops it.
    const beats: string[] = []
    const off = facts.subscribeCurrentProject(p => beats.push(`${p.name}:${p.catalogued}`))
    state.setCwdState(DELTA)
    await tick()
    check('F5 a ground move fires the beat with the new folder (uncatalogued, by name)', beats.includes('delta:false'), beats.join(' '))
    facts.catalogFirstChat(DELTA, 'sid-delta-1')
    check('F5 the stamp fires the beat with the folder now catalogued', beats.includes('delta:true'), beats.join(' '))
    off()
    const count = beats.length
    state.setCwdState(FOO)
    facts.catalogFirstChat(DELTA, 'sid-delta-2')
    await tick()
    check('F5 after the unsubscribe the beat is silent', beats.length === count)
  }

  // ── F6: a pre-catalog project reads catalogued without a write ──────────
  console.log('F6 — a project whose chats predate the card reads catalogued; no read writes the card')
  {
    // The pre-catalog shape: a store dir holding a transcript and NO card —
    // every project that had chats before this law landed.
    const store = portable.getProjectDir(EPSILON)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'eeee-5555.jsonl'), JSON.stringify({ type: 'user', cwd: EPSILON, message: { role: 'user', content: 'old words' } }) + '\n')
    const homeBefore = treeHash(HOME)
    const folderBefore = treeHash(EPSILON)
    const identity = facts.projectIdentity(EPSILON)
    check('F6 the identity door reads catalogued from the transcript alone, with a null stamp and the newest chat', identity.catalogued === true && identity.firstChatAt === null && identity.newestChat?.sessionId === 'eeee-5555', JSON.stringify(identity))
    state.setCwdState(EPSILON)
    check('F6 the current project reads catalogued the same way', facts.currentProject().catalogued === true && facts.currentProject().firstChatAt === null)
    const row = facts.workedInProjects().find(r => r.dir === EPSILON)
    check('F6 the list carries the pre-catalog project with its chat and a null stamp', row !== undefined && row.sessionId === 'eeee-5555' && row.firstChatAt === null && row.base === 'epsilon', JSON.stringify(row))
    check('F6 the Continue door offers its chat', facts.scanBootCardFacts(EPSILON).cwdProject?.sessionId === 'eeee-5555')
    facts.inProject(identity, EPSILON)
    check('F6 no read wrote the card (law 2: reads never write)', !existsSync(join(store, facts.PROJECT_CARD_FILE)) && treeHash(HOME) === homeBefore)
    check('F6 no read touched the folder', treeHash(EPSILON) === folderBefore && !existsSync(join(EPSILON, '.mercury')))
    // The next birth there stamps it like any first chat — the estate and
    // the card join the chats it already had.
    facts.catalogFirstChat(EPSILON, 'sid-eps-1')
    const after = facts.projectIdentity(EPSILON)
    check('F6 the next birth stamps the pre-catalog project (estate + card) and keeps its chat', existsSync(join(EPSILON, '.mercury')) && typeof after.firstChatAt === 'number' && after.newestChat?.sessionId === 'eeee-5555')
    state.setCwdState(FOO)
  }
} finally {
  facts._resetProjectCatalogForTesting()
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-folder-project: ALL LAWS HOLD' : `\nprove-folder-project: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

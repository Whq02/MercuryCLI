#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-projects-truth.ts — the coordinator&projects
//  four ruled laws at their source seams (the driven halves live
//  in the PTY captures; these pins keep the seams from regressing):
//
//   T1  ONE PROJECT SOURCE: every project-listing surface — the Boot face's
//       Projects rows AND the concourse rail's REPO picker — renders the
//       worked-in session-store scan (bootCardFacts), never the home-roots
//       marker scan (knownProjectDirs stays a spoken-path resolution aid);
//   T2  THE GROUND LAW's focused-chat half (rewritten under the one-door
//       law — the seeded-nascent re-ground retired by name):
//       applying the ground chdirs, records the cwd and pulses the slot; a
//       RESTING slot follows the ground through its workspace door (the
//       next New Session is born in the pick), a real session's connector
//       keeps its own workspace; both ground doors (the concourse seed
//       callback, the Boot face's Projects pick) ride the ONE apply owner;
//   T3  PROJECTS-↵ OPENS THE LATEST CHAT: the Boot face's project pick
//       rides the estate's ONE resume door (focusResumedSession) with the
//       row's own transcript, births a session there for a history-less
//       row, and gates the ground move on the trust ledger;
//   T4  THE .mercury NAME: a project row whose directory IS a
//       project-config home wears its PARENT folder's name on every
//       surface (one seam, the launcher's scan mirrored), the path staying
//       in the detail column.
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'projects-truth-'))
delete process.env.MERCURY_HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(rel, 'utf8')

// ── T1: one project source ──────────────────────────────────────────────────
{
  const picker = read('src/components/concourse/GroundPicker.tsx')
  check('T1 the REPO picker renders the ONE worked-in source', picker.includes('workedInProjects()') && picker.includes('bootCardFacts'))
  check('T1 the picker no longer consumes the marker-scan memory', !picker.includes('knownProjectDirs'))
  const face = read('src/components/BootSplashScreen.tsx')
  check('T1 the Boot face renders the same owner', face.includes('scanBootCardFacts'))
  const owner = read('src/utils/bootCardFacts.ts')
  check('T1 the owner derives both shapes from ONE scan', owner.includes('function scanWorkedInProjects') && owner.includes('export function workedInProjects'))
  check('T1 the spoken-path aid survives where it belongs (coordinator ears only)', read('src/services/concourse/coordinatorTools.ts').includes('export async function knownProjectDirs'))
}

// ── T2: the ground law's focused-chat half ──────────────────────────────────
{
  const ground = read('src/services/switchboard/harnessGround.ts')
  check('T2 the ONE apply owner chdirs + records the cwd', ground.includes('process.chdir(target)') && ground.includes('setCwdState(target)'))
  check('T2 the apply pulses the slot so chrome re-reads', ground.includes('emitFocusedSessionConnectorChanged()'))
  check('T2 no chat is re-grounded (nothing exists to follow the ground before a session is born)', !ground.includes('regroundWorkspace') && !ground.includes('isNascentConnector'))
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check('T2 the concourse seed callback rides the ONE owner', route.includes('harnessGround.js') && !route.includes('state.setCwdState('))
  const face = read('src/components/BootSplashScreen.tsx')
  check('T2 the Boot face project pick rides the ONE owner', face.includes('applyHarnessGround(p.dir)'))
  // The runtime law, executed: a RESTING slot follows the ground through
  // its workspace door (a birth from the face reads the same ground), and
  // the boot's facts park untouched for the birth (never on a chat).
  const state = await import('../../src/bootstrap/state.ts')
  const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
  const facts = await import('../../src/services/switchboard/bootBirthFacts.ts')
  facts.setBootBirthFacts({ title: 'boot title', permissionMode: 'sovereign' as never })
  state.setCwdState('/scratch/alpha')
  const before = slot.getFocusedSessionConnector().workspace()
  let pulses = 0
  const off = slot.subscribeFocusedSessionConnector(() => pulses++)
  state.setCwdState('/scratch/beta')
  slot.emitFocusedSessionConnectorChanged()
  const after = slot.getFocusedSessionConnector().workspace()
  check('T2 the resting slot follows the ground (a new workspace snapshot, the slot pulsed)', !slot.hasFocusedSession() && before.cwd === '/scratch/alpha' && after.cwd === '/scratch/beta' && after !== before && pulses === 1)
  check('T2 the same ground is a stable snapshot', slot.getFocusedSessionConnector().workspace() === after)
  check('T2 the boot facts ride untouched by the ground move', facts.bootBirthFacts().title === 'boot title' && facts.bootBirthFacts().permissionMode === ('sovereign' as never))
  off()
  facts._resetBootBirthFactsForTesting()
}

// ── T3: Projects-↵ opens the latest chat ────────────────────────────────────
{
  const face = read('src/components/BootSplashScreen.tsx')
  const openAt = face.indexOf('const openProject = ')
  const open = face.slice(openAt, face.indexOf('// ── the ORIGINAL rows', openAt))
  check('T3 the pick rides the ONE resume door with the row transcript', open.includes('focusResumedSession(p.sessionId, p.transcriptPath'))
  check('T3 a history-less row births a session there (never a chat off the board)', open.includes('bornSession({ workspaceDir: p.dir') && !open.includes('focusNascentSession'))
  check('T3 the ground move gates on the trust ledger', open.includes('isPathTrusted(p.dir)'))
  check('T3 the pick lands in the MAIN chat (never a board detour)', open.includes('enterRootRepl()'))
  const owner = read('src/utils/bootCardFacts.ts')
  // The owner extracted the newest fact to a local (e.facts.newest → newest)
  // — same threading law, the row still carries the newest transcript or an
  // honest null.
  check('T3 the owner threads the newest transcript path', owner.includes('transcriptPath: newest !== null ? newest.file : null'))
}

// ── T4: the .mercury name ───────────────────────────────────────────────────
{
  const { projectDisplayName } = await import('../../src/utils/bootCardFacts.ts')
  check('T4 a .mercury project row wears its parent name', projectDisplayName('/x/gamma/.mercury') === 'gamma')
  check('T4 an ordinary row keeps its own name', projectDisplayName('/x/repo-beta') === 'repo-beta')
  check('T4 a rootward .mercury falls back honestly', projectDisplayName('/.mercury') === '.mercury')
  const owner = read('src/utils/bootCardFacts.ts')
  check('T4 the scan names rows through the ONE seam', owner.includes('base: projectDisplayName(sessionCwd)'))
  check('T4 the seam rides the projectConfig ratchet, not a re-quoted literal', owner.includes('PROJECT_CONFIG_DIR_NAMES'))
  const launcher = read('assets/splash/mercury-splash.mjs')
  check('T4 the launcher scan mirrors the seam (boot-seam byte parity)', launcher.includes('base: projectDisplayName(cwd)'))
  const picker = read('src/components/concourse/GroundPicker.tsx')
  check('T4 the picker names its boot row through the seam', picker.includes('projectDisplayName(bootGround)'))
}

// ── T5: the ghost-husk filter (field return F1) ─────────────────────────────
//  A signed-out FAILED run mints a transcript whose assistant records all
//  carry annotations.error === 'authentication_failed'. The scan walks past
//  the husk to the project's real newest session; a husks-only folder never
//  becomes a project row; the husk FILE stays on disk. The poison control is
//  today's painted row: before the filter, the husk WAS the resolution.
{
  const { mkdirSync, utimesSync, writeFileSync, existsSync } = await import('node:fs')
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
  const { workedInProjects, scanBootCardFacts } = await import('../../src/utils/bootCardFacts.ts')
  const home = process.env.MERCURY_CONFIG_DIR!
  const projReal = join(home, 'repo-real')
  const projGhost = join(home, 'repo-ghost')
  mkdirSync(projReal, { recursive: true })
  mkdirSync(projGhost, { recursive: true })
  const row = (cwd: string, sid: string, extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: sid,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date().toISOString(),
    ...extra,
  })
  const huskRows = (cwd: string, sid: string): Record<string, unknown>[] => [
    row(cwd, sid, { type: 'user', message: { role: 'user', content: 'hello?' } }),
    row(cwd, sid, {
      type: 'assistant',
      error: 'authentication_failed',
      isApiErrorMessage: true,
      message: { id: 'msg_husk', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'OAuth token has expired.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }),
  ]
  const realRows = (cwd: string, sid: string): Record<string, unknown>[] => [
    row(cwd, sid, { type: 'user', message: { role: 'user', content: 'a real ask' } }),
    row(cwd, sid, {
      type: 'assistant',
      message: { id: 'msg_real', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a real reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
    }),
  ]
  const SID_REAL = '00000000-aaaa-4000-8000-00000000aea1'
  const SID_HUSK = '00000000-aaaa-4000-8000-00000000dead'
  const SID_ONLY = '00000000-aaaa-4000-8000-00000000dea2'
  const dirReal = join(home, 'projects', sanitizePath(projReal))
  const dirGhost = join(home, 'projects', sanitizePath(projGhost))
  mkdirSync(dirReal, { recursive: true })
  mkdirSync(dirGhost, { recursive: true })
  const old = new Date(Date.now() - 3_600_000)
  const fReal = join(dirReal, `${SID_REAL}.jsonl`)
  writeFileSync(fReal, encodeSeedTranscript(realRows(projReal, SID_REAL) as never, SID_REAL))
  utimesSync(fReal, old, old)
  const fHusk = join(dirReal, `${SID_HUSK}.jsonl`)
  writeFileSync(fHusk, encodeSeedTranscript(huskRows(projReal, SID_HUSK) as never, SID_HUSK))
  writeFileSync(join(dirGhost, `${SID_ONLY}.jsonl`), encodeSeedTranscript(huskRows(projGhost, SID_ONLY) as never, SID_ONLY))
  const seen = workedInProjects()
  const real = seen.find(p => p.dir === projReal)
  check('T5 the husk is walked past — the project resolves via its REAL newest session', real !== undefined && real.sessionId === SID_REAL, String(real?.sessionId))
  check('T5 the poison row is gone (the husk was today\'s resolution)', real?.sessionId !== SID_HUSK)
  check('T5 a husks-only folder is not a worked-in project', !seen.some(p => p.dir === projGhost))
  check('T5 the husk FILE stays on disk (forensics — only the scan skips it)', existsSync(fHusk))
  const facts = scanBootCardFacts(projReal)
  check('T5 the Continue form rides the same truth (cwdProject = the real session)', facts.cwdProject?.sessionId === SID_REAL)
}

if (failures > 0) {
  console.log(`\nprove-projects-truth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-projects-truth: ALL LAWS HOLD')

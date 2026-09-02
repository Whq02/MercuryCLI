#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/prove-root-guide-composition.ts — how the
//  instruction engine treats a repository's root guide.
//
//  Laws pinned here, driven on a scratch mirror of this repository's root
//  files (CLAUDE.md, the two-line pointer, and AGENTS.md, the guide) so the
//  same legs run on every machine regardless of any untracked local stub:
//    · DEFAULT profile — the resolution is the native contract; the root
//      CLAUDE.md is not a native project source and never auto-loads; the
//      engine composes no guide without an explicit import.
//    · THE EXPLICIT IMPORT — an untracked MERCURY.local.md carrying
//      `@CLAUDE.md` composes the guide exactly once through the import chain
//      (CLAUDE.md → @AGENTS.md), and the import leaves no diagnostic
//      behind.
//    · THE RETIRED PROFILE VALUE — requesting the compat profile resolves
//      native; nothing composes from it.
//    · THE ADDED DIRECTORIES — every operator-added directory (--add-dir,
//      the workspace) is one more instruction root: its MERCURY.md
//      composes, its nested guides load on touch exactly like the main
//      root's, every entry is stamped with its root, the one per-model
//      ceiling covers all roots, removing the directory removes its
//      instructions, and bare mode never refuses a directory the operator
//      added (the context.ts law).
//
//  Run: ~/.bun/bin/bun run scripts/self-hosting/prove-root-guide-composition.ts
// ============================================================================
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const repo = join(import.meta.dir, '..', '..')

let failures = 0
const check = (cond: boolean, msg: string, detail = ''): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
  }
}

// Hermetic child: pinned scratch home, ambient HERMES_/TF_/CLAUDE_ stripped
// (proof-hygiene: never read the calibration machine's flag state). An
// added directory (DRV_ADDED_DIR) enters through the /add-dir command's own
// path minus the React shell: the permission update the command builds,
// applied to the tool-permission context, handed to the state-change choke
// point exactly as the store hands it. DRV_TOUCH names a file to touch for
// the nested ladders; DRV_REMOVE_AFTER narrows the workspace the same way
// and recomposes.
const ADDED_NEEDLE = 'added-directory-guide-needle-7c1e'
const NESTED_NEEDLE = 'added-directory-nested-guide-needle-9b2d'
const PARENT_NEEDLE = 'added-directory-parent-guide-needle-4f6a'
const driverSrc = `
import { enableConfigs } from '${repo}/src/utils/config/globalConfig.js'
enableConfigs()
const { getAddedDirectories, getCachedInstructionPrompt, setCachedInstructionPrompt } = await import('${repo}/src/bootstrap/state.js')
const { getEmptyToolPermissionContext } = await import('${repo}/src/Tool.js')
const { applyPermissionUpdate } = await import('${repo}/src/utils/permissions/PermissionUpdate.js')
const { onChangeAppState } = await import('${repo}/src/state/onChangeAppState.js')
const stateOf = toolPermissionContext => ({ toolPermissionContext, mainLoopModel: null, expandedView: null, verbose: false, settings: undefined, isUltraplanMode: false })
let permission = getEmptyToolPermissionContext()
const changeWorkspace = (type, dir) => {
  const next = applyPermissionUpdate(permission, { type, directories: [dir], destination: 'session' })
  onChangeAppState({ oldState: stateOf(permission), newState: stateOf(next) })
  permission = next
}
setCachedInstructionPrompt('stale-before-the-change')
if (process.env.DRV_ADDED_DIR) changeWorkspace('addDirectories', process.env.DRV_ADDED_DIR)
const cachedPromptAfterChange = getCachedInstructionPrompt()
const { isInstructionDiscoveryDisabled, getUserContext } = await import('${repo}/src/context.js')
const { getInstructionFiles, getInstructionCompositionState, composeInstructionPrompt, filterInjectedInstructionFiles, getInstructionBundle, getMaxMemoryCharacterCount, getLargeMemoryFiles } = await import('${repo}/src/services/instructions/engine.js')
const files = await getInstructionFiles()
const state = getInstructionCompositionState()
const composed = composeInstructionPrompt(filterInjectedInstructionFiles(files))
const bundle = await getInstructionBundle()
// The list as it stood at composition time (a DRV_REMOVE_AFTER leg narrows it below).
const addedAtCompose = getAddedDirectories()
// The real gate: the user context the model receives (context.ts decides whether discovery runs).
const userContext1 = await getUserContext()
const userContextInstructions = userContext1.claudeMd ?? null
let touched = []
if (process.env.DRV_TOUCH) {
  const { getNestedMemoryAttachmentsForFile } = await import('${repo}/src/utils/attachments/nestedMemory.js')
  const { createFileStateCacheWithSizeLimit } = await import('${repo}/src/utils/fileStateCache.js')
  const appState = stateOf(permission)
  const ctx = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => appState }
  touched = (await getNestedMemoryAttachmentsForFile(process.env.DRV_TOUCH, ctx, appState)).map(a => a.path)
}
// An unrelated workspace change — a permission rule, no directory moved —
// replaces the tool-permission context; the choke point must drop nothing.
let unrelated = null
if (process.env.DRV_ADDED_DIR) {
  const next = applyPermissionUpdate(permission, { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' })
  onChangeAppState({ oldState: stateOf(permission), newState: stateOf(next) })
  permission = next
  const userContext2 = await getUserContext()
  unrelated = { contextSurvived: userContext2 === userContext1, cachedPrompt: getCachedInstructionPrompt(), addedDirectories: getAddedDirectories() }
}
let after = null
if (process.env.DRV_REMOVE_AFTER && process.env.DRV_ADDED_DIR) {
  changeWorkspace('removeDirectories', process.env.DRV_ADDED_DIR)
  const files2 = await getInstructionFiles()
  const composed2 = composeInstructionPrompt(filterInjectedInstructionFiles(files2))
  const userContext3 = await getUserContext()
  after = { paths: files2.map(f => f.path), composedHasAddedNeedle: composed2.includes('${ADDED_NEEDLE}'), addedDirectories: getAddedDirectories(), contextDropped: userContext3 !== userContext1 }
}
console.log(JSON.stringify({
  paths: files.map(f => f.path),
  resolution: state.resolution,
  diagnostics: state.diagnostics,
  composedHasGuide: composed.includes('Mercury — building and running a local copy'),
  guideCount: composed.split('Mercury is a terminal harness for software development').length - 1,
  addedDirectories: addedAtCompose,
  discoveryDisabled: isInstructionDiscoveryDisabled(),
  composedHasAddedNeedle: composed.includes('${ADDED_NEEDLE}'),
  composedHasNestedNeedle: composed.includes('${NESTED_NEEDLE}'),
  composedHasParentNeedle: composed.includes('${PARENT_NEEDLE}'),
  composedHasRootStamp: process.env.DRV_ADDED_DIR ? composed.includes('for the added directory ' + process.env.DRV_ADDED_DIR + ',') : false,
  composedLength: composed.length,
  userContextHasInstructions: userContextInstructions !== null,
  userContextHasAddedNeedle: (userContextInstructions ?? '').includes('${ADDED_NEEDLE}'),
  cachedPromptAfterChange,
  entries: bundle.entries.map(e => ({ path: e.path, type: e.type, origin: e.origin, root: e.root ?? null })),
  cap: getMaxMemoryCharacterCount(),
  largeFiles: getLargeMemoryFiles(files).map(f => f.path),
  touched,
  unrelated,
  after,
}))
`
const driverDir = mkdtempSync(join(tmpdir(), 'native-selfhost-drv-'))
const driverPath = join(driverDir, 'drv.ts')
await Bun.write(driverPath, driverSrc)

interface Capture {
  paths: string[]
  resolution: { requested: string; resolved: string; mapped?: string }
  diagnostics: { kind: string; path: string }[]
  composedHasGuide: boolean
  guideCount: number
  addedDirectories: string[]
  discoveryDisabled: boolean
  composedHasAddedNeedle: boolean
  composedHasNestedNeedle: boolean
  composedHasParentNeedle: boolean
  composedHasRootStamp: boolean
  composedLength: number
  userContextHasInstructions: boolean
  userContextHasAddedNeedle: boolean
  cachedPromptAfterChange: string | null
  entries: { path: string; type: string; origin: string; root: string | null }[]
  cap: number
  largeFiles: string[]
  touched: string[]
  unrelated: { contextSurvived: boolean; cachedPrompt: string | null; addedDirectories: string[] } | null
  after: { paths: string[]; composedHasAddedNeedle: boolean; addedDirectories: string[]; contextDropped: boolean } | null
}
function drive(cwd: string, extraEnv: Record<string, string>): Capture {
  const home = mkdtempSync(join(tmpdir(), 'native-selfhost-home-'))
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(MERCURY_|HERMES_|TF_|CLAUDE_)/.test(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = home
  env.MERCURY_EVOLUTION_LEDGER = '0'
  Object.assign(env, extraEnv)
  const run = spawnSync(process.execPath, ['run', driverPath], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  rmSync(home, { recursive: true, force: true })
  if (run.status !== 0) {
    console.error(`  [FAIL] driver exited ${run.status}: ${String(run.stderr).slice(0, 800)}`)
    process.exit(1)
  }
  const lines = String(run.stdout).trim().split('\n')
  return JSON.parse(lines[lines.length - 1]!) as Capture
}

console.log('root guide composition — the pointer arrangement, both profiles')

// ── default profile, THE REPO (stub-independent structural laws only) ──────
const nat = drive(repo, {})
check(
  nat.resolution.resolved === 'native',
  `default resolution is the native contract (requested ${nat.resolution.requested} → resolved ${nat.resolution.resolved})`,
)
check(
  !nat.paths.includes(join(repo, 'MERCURY.md')),
  'no retired root MERCURY.md composes (the file is gone)',
)

// ── the root guide's two states — a scratch MIRROR, both legs, every machine
// realpath: the engine reports canonical paths (darwin's /var → /private/var).
const mirror = realpathSync(mkdtempSync(join(tmpdir(), 'native-selfhost-mirror-')))
const mirrorGuide = join(mirror, 'CLAUDE.md')
const mirrorStub = join(mirror, 'MERCURY.local.md')
copyFileSync(join(repo, 'CLAUDE.md'), mirrorGuide)
copyFileSync(join(repo, 'AGENTS.md'), join(mirror, 'AGENTS.md'))

// (a) bare checkout: no native source composes.
const bare = drive(mirror, {})
check(bare.resolution.resolved === 'native', 'bare guide layout resolves native')
check(
  !bare.paths.includes(mirrorGuide),
  'root CLAUDE.md does not compose as a native project source (no auto-load)',
)
check(bare.guideCount === 0, `no root guide composes natively without the stub (count ${bare.guideCount})`)
check(
  !bare.diagnostics.some(d => d.path === mirrorGuide),
  'no diagnostic is raised for the pointer file (nothing composes, nothing is reported)',
  JSON.stringify(bare.diagnostics),
)

// (b) the explicit import: MERCURY.local.md with `@CLAUDE.md` composes the
//     guide exactly once through the import chain.
writeFileSync(mirrorStub, '@CLAUDE.md\n')
const stub = drive(mirror, {})
check(stub.resolution.resolved === 'native', 'stub layout still resolves native (the import is not a profile flip)')
check(
  stub.paths.includes(mirrorGuide) && stub.composedHasGuide,
  'the local stub composes the guide through @CLAUDE.md → @AGENTS.md',
)
check(stub.guideCount === 1, `the guide composes exactly once via the stub (count ${stub.guideCount})`)
check(
  !stub.diagnostics.some(d => d.path === mirrorGuide || d.path === mirrorStub),
  'the explicit import composes the pointer file without a diagnostic (no missing target, cycle or duplicate)',
  JSON.stringify(stub.diagnostics),
)

// ── the retired compat profile: the value is ignored, native holds ──────────
unlinkSync(mirrorStub)
const retiredReq = drive(mirror, { MERCURY_INSTRUCTION_PROFILE: 'compat' })
check(
  retiredReq.resolution.resolved === 'native',
  `the retired 'compat' profile value resolves native (requested ${retiredReq.resolution.requested} → ${retiredReq.resolution.resolved})`,
)
check(retiredReq.guideCount === 0, `no root guide composes under the retired value (count ${retiredReq.guideCount})`)

// ── the operator's added directories: one more instruction root each ───────
//    Its MERCURY.md composes, root-stamped for the model, within the ceiling;
//    no ancestor walk above the added root; a nested guide waits for a touch
//    exactly like the main root's; the /add-dir command path invalidates the
//    caches; the one per-model ceiling covers all roots the way the main
//    root gets it (reported, composed whole); removing the directory drops
//    its instructions; bare mode: the context.ts law.
const parent = realpathSync(mkdtempSync(join(tmpdir(), 'native-selfhost-parent-')))
writeFileSync(join(parent, 'MERCURY.md'), `# Parent guide\n\n${PARENT_NEEDLE}\n`)
const added = join(parent, 'root')
const addedGuide = join(added, 'MERCURY.md')
const nestedGuide = join(added, 'sub', 'MERCURY.md')
const nestedFile = join(added, 'sub', 'file.ts')
mkdirSync(join(added, 'sub'), { recursive: true })
writeFileSync(addedGuide, `# Added root guide\n\n${ADDED_NEEDLE}\n`)
writeFileSync(nestedGuide, `# Nested guide\n\n${NESTED_NEEDLE}\n`)
writeFileSync(nestedFile, 'export const answer = 42\n')
const withAdded = drive(mirror, { DRV_ADDED_DIR: added, DRV_TOUCH: nestedFile, DRV_REMOVE_AFTER: '1' })
check(
  withAdded.addedDirectories.length === 1 && withAdded.addedDirectories[0] === added,
  'the /add-dir command path (the permission update → the state-change choke point) reaches the added-directories list',
  JSON.stringify(withAdded.addedDirectories),
)
check(
  withAdded.cachedPromptAfterChange === null,
  'the command path drops the cached instruction prompt (never stale for the classifier)',
  String(withAdded.cachedPromptAfterChange),
)
check(!withAdded.discoveryDisabled, 'instruction discovery stays enabled with an added directory')
check(
  withAdded.paths.includes(addedGuide) && withAdded.composedHasAddedNeedle,
  "an added directory's MERCURY.md composes",
  withAdded.paths.join(' · '),
)
check(
  withAdded.composedHasRootStamp,
  'the composed slice is root-stamped for the model ("for the added directory <root>")',
)
check(
  withAdded.entries.some(e => e.path === addedGuide && e.type === 'Project' && e.origin === 'additional-dir' && e.root === added),
  "the bundle entry is stamped with the root it came from (origin 'additional-dir')",
  JSON.stringify(withAdded.entries),
)
check(withAdded.largeFiles.length === 0, 'within the ceiling: a small guide is not reported large')
check(
  !withAdded.composedHasParentNeedle && !withAdded.paths.includes(join(parent, 'MERCURY.md')),
  "no ancestor walk above an added root: the parent directory's guide does not compose",
  withAdded.paths.join(' · '),
)
check(
  !withAdded.paths.includes(nestedGuide) && !withAdded.composedHasNestedNeedle,
  "a nested guide under the added root waits for a touch, exactly like the main root's (the boot walk never descends)",
  withAdded.paths.join(' · '),
)
check(
  withAdded.touched.includes(nestedGuide),
  'touching a file under the added root attaches its nested guide (the ladders anchor at the added root)',
  withAdded.touched.join(' · ') || '(nothing attached)',
)
check(
  withAdded.userContextHasAddedNeedle,
  'the user context the model receives carries the added guide (the real gate in context.ts)',
)
check(
  withAdded.unrelated !== null &&
    withAdded.unrelated.contextSurvived &&
    withAdded.unrelated.cachedPrompt !== null &&
    withAdded.unrelated.cachedPrompt.includes(ADDED_NEEDLE) &&
    withAdded.unrelated.addedDirectories.length === 1,
  'an unrelated workspace change (a permission rule, no directory moved) drops nothing: the composed user context and the classifier prompt survive',
  JSON.stringify(withAdded.unrelated),
)
check(
  withAdded.after !== null &&
    !withAdded.after.paths.includes(addedGuide) &&
    !withAdded.after.composedHasAddedNeedle &&
    withAdded.after.addedDirectories.length === 0 &&
    withAdded.after.contextDropped,
  'removing the directory (the same path) drops its instructions from the next composition and drops the composed user context',
  JSON.stringify(withAdded.after),
)
check(
  stub.entries.some(e => e.path === mirrorStub && e.origin === 'project-walk' && e.root === mirror),
  "the main root's entries are stamped with the boot cwd (origin 'project-walk')",
  JSON.stringify(stub.entries),
)

// one ceiling, all roots together: the same per-model cap, the same measure,
// the same over-ceiling behaviour (reported by the large-file notice and
// composed whole — the engine cuts only the auto-memory entrypoint)
writeFileSync(addedGuide, `# Added root guide\n\n${ADDED_NEEDLE}\n${'x'.repeat(bare.cap + 1)}\n`)
const big = drive(mirror, { DRV_ADDED_DIR: added })
check(big.cap === bare.cap, `one ceiling: the per-model cap is the same number with an added root (${big.cap} = ${bare.cap})`)
check(
  big.largeFiles.includes(addedGuide),
  "an over-cap guide in an added root is reported by the same large-file measure as the main root's",
  big.largeFiles.join(' · ') || '(none reported)',
)
check(
  big.composedHasAddedNeedle && big.composedLength > big.cap,
  "…and composes whole, never cut — the over-ceiling behaviour the main root gets",
  `composed ${big.composedLength} chars, cap ${big.cap}`,
)

const bareAlone = drive(mirror, { MERCURY_SIMPLE: '1' })
check(
  bareAlone.discoveryDisabled && !bareAlone.userContextHasInstructions,
  'bare mode with no added directory disables instruction discovery: the user context carries no instructions',
)
const bareAdded = drive(mirror, { MERCURY_SIMPLE: '1', DRV_ADDED_DIR: added })
check(
  !bareAdded.discoveryDisabled && bareAdded.userContextHasAddedNeedle,
  "bare mode never refuses a directory the operator added: its guide reaches the user context (the context.ts law)",
)
rmSync(parent, { recursive: true, force: true })

rmSync(mirror, { recursive: true, force: true })
rmSync(driverDir, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ root guide composition proven (both profiles, both guide states, the added-directory law)' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

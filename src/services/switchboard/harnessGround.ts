// ============================================================================
//  switchboard/harnessGround — THE GROUND LAW's process-side apply, one home.
//
//  "The selected repo IS the harness ground — changing it re-grounds the
//  whole product; clearing it returns to the boot folder. Sessions keep
//  their OWN grounds regardless."
//
//  Two doors move the ground — the concourse rail's REPO picker and the
//  Boot face's Projects pick — and both funnel here: the process chdirs and
//  the estate's cwd owner records it. Under the one-door law no chat
//  follows the ground (a fresh boot has no chat to follow it): the next
//  New Session is born IN the ground — the birth door reads the screen's
//  cwd at ↵ — and a real session's connector keeps its own workspace,
//  never touched. The seed-override WRITE stays with each caller (the
//  concourse serializes its writes through its own chain); this module is
//  the process truth only.
//
//  THE GROUND-MOVE RESET (the never-stale law): a ground move is a re-boot
//  in the picked repo. The --worktree boot mover (setup.ts) is the landed
//  precedent — setCwd + setOriginalCwd + setProjectRoot + the instruction
//  cache clear, "the original cwd changed, so the memoized instruction walk
//  is stale" — and this door is its mid-process sibling: every boot-memoized
//  ground fact resets HERE, at the one seam, or the screen keeps painting
//  the boot folder's photo for the rest of the process (the config-key
//  disease: trust grants and /mcp disables landing on the BOOT repo's slice
//  after a picker move). The
//  named facts, each with its pin in scripts/staleness/:
//    · originalCwd + projectRoot — the identity anchors every project-scoped
//      derivation reads (settings paths, session storage, instructions);
//      Resume/sessions surfaces follow the ground BY DESIGN (the same
//      intent as the Projects-↵ door);
//    · the project-config key memo (getProjectPathForConfig);
//    · the settings caches + the settings watcher's watch targets (armed at
//      initialise over the OLD ground's paths — reground());
//    · the instruction-file walk (the setup.ts precedent);
//    · the context memos (git status · system · user · getIsGit);
//    · the command/skill rosters (clearCommandsCache — the loader memos;
//      the PATHS already follow: getSkillsPath reads process.cwd());
//    · the agents definitions cache; the example-command memos; the
//      project-onboarding memo; the plans-directory memo;
//    · extensions: the roster is marked PENDING (the honest "photo" flag —
//      the board's r swaps), never hot-swapped under the operator.
//  The gitFilesystem watch reground predates this list (TASK-017 S2).
//
//  THE TRUE BOOT GROUND is latched at the FIRST apply, before any move —
//  the null-clear returns exactly there for the process lifetime; nothing
//  re-latches it (originalCwd now moves with the ground, so it can no
//  longer serve as the clear target).
//
//  Every reset is fail-soft in its own arm — a projection's failure never
//  loses the cwd move itself.
// ============================================================================

/** The boot folder, latched at the first apply — see the header. */
let trueBootGround: string | null = null

/** Apply the ground: `dir`, or null for the boot folder. Fail-soft — a
 *  missing folder leaves the seed as the record and the preflight names it.
 *  Returns the ground actually applied. */
export async function applyHarnessGround(dir: string | null): Promise<string> {
  const state = await import('../../bootstrap/state.js')
  if (trueBootGround === null) trueBootGround = state.getOriginalCwd()
  const target = dir !== null && dir.length > 0 ? dir : trueBootGround
  try {
    process.chdir(target)
  } catch {
    /* missing folder — the seed still lands; preflight names it */
  }
  // The re-boot trio (the setup.ts precedent): the identity anchors move
  // with the ground, then the cwd owner records it (the ground-move beat).
  state.setOriginalCwd(target)
  state.setProjectRoot(target)
  state.setCwdState(target)
  // The git-facts cache follows the ground: without this the branch/head/
  // remote chrome — and the gitBranch stamped into every later session
  // record — kept answering from the FIRST repo for the rest of the process
  // (TASK-017 S2, git-facts-pinned-to-first-resolved-gitdir).
  try {
    const gitFs = await import('../../utils/git/gitFilesystem.js')
    gitFs.regroundGitWatch()
  } catch {
    /* the cache is a projection — the cwd move stands on its own */
  }
  // The project-config key: the process-lifetime memo of the ground's key.
  // Its derivation input (originalCwd) moved above; the memo must re-run or
  // every project save keeps landing on the boot repo's slice.
  try {
    const projectConfig = await import('../../utils/config/projectConfig.js')
    projectConfig.getProjectPathForConfig.cache?.clear?.()
  } catch {
    /* projection */
  }
  // The settings layer: the per-source caches re-read off the moved paths,
  // and the change watcher re-arms on them (its watch targets were computed
  // at initialise over the OLD ground — a new ground's settings edit would
  // otherwise never fan out).
  try {
    const settingsCache = await import('../../utils/settings/settingsCache.js')
    settingsCache.resetSettingsCache()
  } catch {
    /* projection */
  }
  try {
    const detector = await import('../../utils/settings/changeDetector.js')
    await detector.settingsChangeDetector.reground()
  } catch {
    /* projection */
  }
  // The instruction-file walk (the setup.ts precedent, verbatim).
  try {
    const instructions = await import('../instructions/engine.js')
    instructions.clearInstructionFileCaches()
  } catch {
    /* projection */
  }
  // The context memos: git status, the system/user context blocks, and the
  // is-git answer — all memoized over the old ground.
  try {
    const context = await import('../../context.js')
    context.getGitStatus.cache?.clear?.()
    context.getSystemContext.cache?.clear?.()
    context.getUserContext.cache?.clear?.()
  } catch {
    /* projection */
  }
  try {
    const git = await import('../../utils/git.js')
    git.getIsGit.cache?.clear?.()
  } catch {
    /* projection */
  }
  // The command/skill rosters: the loader memos (per-cwd keys whose ANCHORS
  // moved) plus the derived skill views and the extension command
  // catalogues — clearCommandsCache is the exported full clear.
  try {
    const commands = await import('../../commands.js')
    commands.clearCommandsCache()
  } catch {
    /* projection */
  }
  // The agents definitions cache (per-cwd keyed; cleared for the same
  // anchor-move reason as the command roster).
  try {
    const agents = await import('../../tools/AgentTool/loadAgentsDir.js')
    agents.clearAgentDefinitionsCache()
  } catch {
    /* projection */
  }
  // The example-command memos (they read the project slice — the OLD key's).
  try {
    const examples = await import('../../utils/exampleCommands.js')
    examples.getExampleCommandFromCache.cache?.clear?.()
    examples.refreshExampleCommands.cache?.clear?.()
  } catch {
    /* projection */
  }
  // The project-onboarding memos (both read the project slice): the show
  // gate and the rendered first-run hint that sits on it (FC-134) — a moved
  // ground must never paint the previous project's hint.
  try {
    const onboarding = await import('../../projectOnboardingState.js')
    onboarding.shouldShowProjectOnboarding.cache?.clear?.()
    onboarding.projectOnboardingHint.cache?.clear?.()
  } catch {
    /* projection */
  }
  // The plans-directory memo (its invalidation handle is part of its
  // contract — the worktree doors already clear it).
  try {
    const plans = await import('../../utils/plans.js')
    plans.getPlansDirectory.cache.clear()
  } catch {
    /* projection */
  }
  // Extensions: the roster derives from the ground's project folder and
  // settings — mark it PENDING (the honest "photo" flag; the board's r
  // swaps) rather than hot-swapping servers under the operator.
  try {
    const extensions = await import('../../extensions/boot.js')
    extensions.setExtensionsPending(true)
  } catch {
    /* projection */
  }
  try {
    // A resting slot answers the screen's ground through its workspace
    // door: pulse the slot's subscribers so the chrome re-reads at once
    // (it must not keep painting the boot folder until an unrelated render).
    const slot = await import('../engine-connector/focusedConnector.js')
    slot.emitFocusedSessionConnectorChanged()
  } catch {
    /* the slot is a projection here — the cwd move stands on its own */
  }
  return target
}

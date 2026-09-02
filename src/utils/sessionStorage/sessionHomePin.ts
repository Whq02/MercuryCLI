// ============================================================================
//  sessionHomePin — the ONE transcript-home law.
//
//  A daemon-hosted switchboard session runs with cwd INSIDE its carved
//  worktree (isolation), but its transcript home is the WORKSPACE's project
//  dir — the same derivation every reader uses (workerTranscriptPath, the
//  peek mirror, enter/resume). Without the pin the writer derives from
//  originalCwd (the worktree) while every reader watches the workspace home:
//  divergent on every default worktree-isolated launch (the kickoff audit's
//  one refuted claim).
//
//  The pin rides the spawn spec's extraEnv (respawn-carried) as the
//  registered MERCURY_SESSION_HOME flag and is CONSUMED ONCE at boot: read,
//  then scrubbed from process.env, so bash-spawned grandchild CLIs can never
//  inherit another session's home.
// ============================================================================
import { deleteFlagEnv, flagEnv } from '../../substrate/flagRegistry.js'

/** Read-and-scrub the transcript-home pin. Null for plain boots. */
export function consumeSessionHomePin(): string | null {
  const pin = flagEnv('MERCURY_SESSION_HOME')
  deleteFlagEnv('MERCURY_SESSION_HOME')
  if (pin === undefined || pin.trim() === '') return null
  return pin
}

/**
 * Per-command exit-code interpretation.
 *
 * A non-zero exit code usually means the command failed, but several standard
 * tools overload low exit codes with non-error meanings (grep exits 1 for "no
 * matches", diff exits 1 for "files differ"). This module turns an exit code
 * into an honest verdict — is this really an error, and what does the code
 * mean — so the harness never reports a successful `grep` as a failure. It is
 * a heuristic aid to the human/model, never a security decision.
 */
import { pinnedCommandAnalysis } from '../../utils/permissions/decision/commandAnalysis.js'

/** The interpretation of one command's exit code. */
export type CommandSemantic = (exitCode: number) => { isError: boolean; message?: string }

/**
 * Per-command overrides, keyed by base command. Each entry decides, from the
 * exit code alone, whether the run is an error and what note (if any) to show.
 * Contract data — the commands, their error thresholds and their notes.
 */
const COMMAND_SEMANTICS: Record<string, CommandSemantic> = {
  grep: code => ({
    isError: code >= 2,
    message: code === 1 ? 'no matches found' : undefined,
  }),
  rg: code => ({
    isError: code >= 2,
    message: code === 1 ? 'no matches found' : undefined,
  }),
  find: code => ({
    isError: code >= 2,
    message: code === 1 ? 'some directories were inaccessible' : undefined,
  }),
  diff: code => ({
    isError: code >= 2,
    message: code === 1 ? 'files differ' : undefined,
  }),
  test: code => ({
    isError: code >= 2,
    message: code === 1 ? 'condition is false' : undefined,
  }),
  '[': code => ({
    isError: code >= 2,
    message: code === 1 ? 'condition is false' : undefined,
  }),
}

/**
 * Reduce a (possibly compound) command to the base command that determines its
 * exit status: the last subcommand of the pipeline, first word. Heuristic —
 * never a security signal.
 */
function baseCommandFor(command: string): string {
  const subcommands = pinnedCommandAnalysis.splitCommand(command)
  const last = subcommands[subcommands.length - 1] ?? command
  return last.trim().split(/\s+/)[0] ?? ''
}

/**
 * Interpret a finished command's exit code. Returns whether it should count as
 * an error and an optional human-readable note. stderr is accepted for
 * signature symmetry with the caller but is not consulted (stderr is merged
 * into stdout upstream).
 */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  _stdout: string,
  _stderr: string,
): { isError: boolean; message?: string } {
  const base = baseCommandFor(command)
  const semantic = COMMAND_SEMANTICS[base]
  if (semantic) {
    return semantic(exitCode)
  }
  // Default: any non-zero code is an error, named by its number.
  if (exitCode !== 0) {
    return { isError: true, message: `failed with exit code ${exitCode}` }
  }
  return { isError: false }
}

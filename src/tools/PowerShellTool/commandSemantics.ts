/**
 * Per-command exit-code interpretation for PowerShell. Native cmdlets do not
 * signal failure by exit code, so only external executables need semantics.
 * The base-command extraction is a documented heuristic and must NEVER be
 * reused for a security decision.
 */

/** The interpretation of one command's exit code. */
export type CommandSemantic = (
  exitCode: number,
  stdout: string,
  stderr: string,
) => { isError: boolean; message?: string }

/** Reduce a (possibly compound) command to the base command of its last pipeline segment. */
function baseCommandFor(command: string): string {
  const segments = command.split(/[;|]/)
  const last = (segments[segments.length - 1] ?? command).trim()
  const withoutCall = last.replace(/^[.&]\s+/, '')
  let first = withoutCall.split(/\s+/)[0] ?? ''
  if (/^['"]/.test(first)) first = first.slice(1)
  if (/['"]$/.test(first)) first = first.slice(0, -1)
  const baseName = first.split(/[\\/]/).pop() ?? first
  return baseName.toLowerCase().replace(/\.exe$/, '')
}

/** Interpret a finished command's exit code. */
export function interpretCommandResult(
  command: string,
  exitCode: number,
  _stdout: string,
  _stderr: string,
): { isError: boolean; message?: string } {
  const base = baseCommandFor(command)

  if (base === 'grep' || base === 'rg' || base === 'findstr') {
    if (exitCode === 0) return { isError: false }
    if (exitCode === 1) return { isError: false, message: 'no matches found' }
    return { isError: true } // exit >= 2: an error, but no message
  }

  // Lookup and comparison tools whose non-zero exit is a VALID NEGATIVE
  // ANSWER, never a failure (sweep #2, packet 71): where.exe reports
  // "not found" with 1; fc/comp/diff/cmp report "files differ" with 1 and
  // keep 2+ for real errors.
  if (base === 'where') {
    if (exitCode === 0) return { isError: false }
    if (exitCode === 1) return { isError: false, message: 'not found on the search path' }
    return { isError: true, message: `where failed with exit code ${exitCode}` }
  }
  if (base === 'fc' || base === 'comp' || base === 'diff' || base === 'cmp') {
    if (exitCode === 0) return { isError: false, message: 'files are identical' }
    if (exitCode === 1) return { isError: false, message: 'files differ' }
    return { isError: true, message: `${base} failed with exit code ${exitCode}` }
  }

  if (base === 'robocopy') {
    // Exit codes are a bitfield: 0-7 are success, 8+ is an error.
    // A failing robocopy (exit >= 8) is an error with NO message.
    if (exitCode >= 8) return { isError: true }
    if (exitCode === 0) return { isError: false, message: 'no files copied; source and destination are already in sync' }
    const filesCopied = (exitCode & 1) === 1
    return {
      isError: false,
      message: filesCopied ? 'files were copied successfully' : 'completed without errors',
    }
  }

  // Default: any non-zero exit is an error, naming the code.
  if (exitCode !== 0) return { isError: true, message: `command failed with exit code ${exitCode}` }
  return { isError: false }
}

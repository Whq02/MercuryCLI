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
    return { isError: true }
  }
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
    if (exitCode < 0 || exitCode >= 8) return { isError: true }
    if (exitCode === 0) {
      return { isError: false, message: 'no files copied; source and destination are already in sync' }
    }
    if ((exitCode & 1) === 1) return { isError: false, message: 'files were copied successfully' }
    return { isError: false, message: 'completed without errors' }
  }
  if (exitCode === 0) return { isError: false }
  return { isError: true, message: `command failed with exit code ${exitCode}` }
}

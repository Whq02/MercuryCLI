import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/tools/PowerShellTool/commandSemantics.ts:13')
}

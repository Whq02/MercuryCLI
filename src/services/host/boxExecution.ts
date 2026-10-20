import { posix, win32 } from 'node:path'
import type { HostBox } from './boxes.js'
import { sshArguments, type HostRunner } from './ssh.js'

export const shQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export const psQuote = (value: string): string => "'" + value.replaceAll("'", "''") + "'"
export function boxJoin(box: Pick<HostBox, 'os'>, ...parts: string[]): string { return (box.os === 'windows' ? win32 : posix).join(...parts) }
export function boxAbsolutePath(box: HostBox, path: string): string {
  if (/[\0\r\n]/.test(path) || !(box.os === 'windows' ? win32 : posix).isAbsolute(path)) throw new Error('Give an absolute folder path on the selected computer.')
  return path
}
export async function runBoxScript(box: Pick<HostBox, 'os' | 'target'>, script: string, runner: HostRunner, signal: AbortSignal, timeoutMs = 30_000): Promise<string> {
  const windows = box.os === 'windows'
  const executable = windows ? 'powershell.exe' : '/bin/sh'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'\n" + script, 'utf16le').toString('base64')] : ['-c', 'set -eu\n' + script]
  return box.target ? runner.run('ssh', [...sshArguments(box.target), windows ? executable + ' ' + args.join(' ') : executable + ' -c ' + shQuote('set -eu\n' + script)], signal, timeoutMs) : runner.run(executable, args, signal, timeoutMs)
}
export async function writeBoxFile(box: HostBox, path: string, content: string, runner: HostRunner, signal: AbortSignal): Promise<void> {
  const base64 = Buffer.from(content).toString('base64')
  const script = box.os === 'windows'
    ? '$p=' + psQuote(path) + '; [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)) | Out-Null; [IO.File]::WriteAllBytes($p,[Convert]::FromBase64String(' + psQuote(base64) + '))'
    : 'umask 077; mkdir -p ' + shQuote(posix.dirname(path)) + '; printf %s ' + shQuote(base64) + (box.os === 'darwin' ? ' | base64 -D' : ' | base64 -d') + ' > ' + shQuote(path)
  await runBoxScript(box, script, runner, signal)
}

import { tmpdir } from 'node:os'
import { posix as posixPath } from 'node:path'
import { rememberedPlatform } from '../platform/host.js'
import { childGetsOwnProcessGroup } from '../platform/processes.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { getPowerShellEdition } from './powershellDetection.js'
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js'
import { hostEnv } from '../hostEnv.js'
import { notBuilt } from '../../pi/holes.js'

export function buildPowerShellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command]
}

const PLAIN_RENDER_PRELUDE =
  "if ($null -ne (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue)) { $PSStyle.OutputRendering = 'PlainText' }\n"

export const UTF8_OUTPUT_PRELUDE =
  "try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}\n"

const CLEAR_LOCATION_HISTORY_PRELUDE =
  'try { & { for ($i = 0; $i -lt 25; $i++) { Set-Location -LiteralPath . } } } catch {}\n'

const LOCATION_WORD_RE =
  /(?:^|[^\w-])(?:cd|chdir|sl|set-location|push-location|pushd|pop-location|popd)(?![\w-])/i

const HIDING_WORD_RE =
  /(?:^|[^\w-])(?:invoke-expression|iex|invoke-command|icm|scriptblock|executioncontext)(?![\w-])/i

const ENCODED_COMMAND_RE =
  /(?:^|[^\w-])-(?:ec|enc(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)(?![\w-])/i

const CALL_OPERATOR_RE =
  /(?<![>&])&(?!&)[ \t]*[$'"({]|(?:^|[\r\n;|({=]|&&|\|\|)[ \t]*&(?!&)[ \t]*\S/

const DOT_SOURCE_RE = /(?:^|[\r\n;|({=&])[ \t]*\.[ \t]+\S/

const SCRIPT_INVOCATION_RE = /(?:^|[\r\n;|({=&])[ \t]*[^\s;|({=&]+\.ps1(?![\w-])/i

function matchesLocationOrHiding(text: string): boolean {
  return (
    LOCATION_WORD_RE.test(text) ||
    HIDING_WORD_RE.test(text) ||
    ENCODED_COMMAND_RE.test(text) ||
    CALL_OPERATOR_RE.test(text) ||
    DOT_SOURCE_RE.test(text) ||
    SCRIPT_INVOCATION_RE.test(text)
  )
}

function needsLocationHistoryClear(command: string): boolean {
  if (command.includes('\0')) return true
  const normalized = command.replace(/[\u2013\u2014\u2015]/g, '-')
  if (matchesLocationOrHiding(normalized)) return true
  if (normalized.includes('`')) return matchesLocationOrHiding(normalized.replace(/`(?:\r?\n)?/g, ''))
  return false
}

function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

function buildTrailer(cwdFileInShell: string): string {
  const literal = cwdFileInShell.split("'").join("''")
  return [
    '',
    '; $mc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    `; [IO.File]::WriteAllText('${literal}', (Get-Location).Path, [Text.UTF8Encoding]::new($false))`,
    '; exit $mc',
  ].join('\n')
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  return notBuilt('src/utils/shell/powershellProvider.ts:72')
}

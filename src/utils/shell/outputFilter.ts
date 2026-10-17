import { getInitialSettings } from '../settings/settings.js'
import { plural } from '../stringUtils.js'

export const SHELL_OUTPUT_FILTER_SETTING = 'shell.filterOutput'
const REPEAT_RUN_FLOOR = 3

export type OutputFilterLeftOut = { progress: number; noise: number; repeats: number }

export type FilteredShellOutput = { text: string; leftOut: OutputFilterLeftOut; changed: boolean }

export function isShellOutputFilterOn(): boolean {
  try {
    return getInitialSettings().shell?.filterOutput === true
  } catch {
    return false
  }
}

const PROGRESS_LINE = /\b\d{1,3}(?:\.\d+)?%|\[[=#>\-. ]{4,}\]|[━█▓▒░]{4,}|\bETA\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\|[/\-\\|]\s*$/
const KEEP_LINE = /\b(?:ERR!|ERROR|error|Error|fatal|FATAL|Traceback|failed|FAILED|exception|Exception|panic)\b|^Exited with code/
const NOISE_LINES: readonly RegExp[] = [
  /^npm (?:WARN|warn|notice)\b/,
  /^(?:added|removed|changed|audited|up to date, audited) \d+ packages?/,
  /^found \d+ (?:\w+ )?vulnerabilit/,
  /^\d+ packages? (?:are|is) looking for funding/,
  /^\s+run `npm fund` for details/,
  /^(?:warning|info) .*\b(?:deprecated|peer dependenc|incorrect peer)/,
  /^Progress: resolved \d+/,
  /^Packages: [+-]\d+/,
  /^(?:Collecting|Requirement already satisfied|Installing collected packages|Attempting uninstall|Successfully uninstalled|Preparing metadata|Building wheels? for|Created wheel for|Stored in directory|Running setup\.py)\b/,
  /^\s*(?:Downloading|Using cached) \S+\.(?:whl|tar\.gz|zip|egg)\b/,
  /^\s+(?:Downloading|Using cached|Preparing metadata) /,
  /^\[notice\] /,
  /^\s*(?:Compiling|Downloaded|Downloading|Updating|Fresh|Checking|Documenting|Blocking|Locking|Adding|Removing) \S+ (?:v\d|crates|packages|index|\d+ packages)/,
  /^(?:Get|Hit|Ign):\d+ /,
  /^(?:Reading package lists|Building dependency tree|Reading state information|Fetched \d|Selecting previously unselected|Preparing to unpack|Unpacking |Setting up |Processing triggers for )/,
  /^[0-9a-f]{12}: (?:Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/,
  /^(?:Digest: sha256:|Status: Downloaded newer image|Status: Image is up to date)/,
  /^remote: (?:Counting|Compressing|Enumerating|Total) /,
  /^(?:Receiving|Resolving) (?:objects|deltas):/,
  /^(?:Unpacking objects|Updating files|Filtering content):/,
  /^==> (?:Downloading|Fetching|Pouring|Already downloaded)/,
  /^#{5,}/,
  /^go: (?:downloading|finding|extracting) /,
  /^Download(?:ing|ed) from \S+: /,
  /^\[INFO\] Download(?:ing|ed) from /,
]

function isProgressLine(line: string): boolean {
  return PROGRESS_LINE.test(line) && !KEEP_LINE.test(line)
}

function isNoiseLine(line: string): boolean {
  if (KEEP_LINE.test(line)) return false
  return NOISE_LINES.some(pattern => pattern.test(line))
}

function collapseProgress(lines: readonly string[], leftOut: OutputFilterLeftOut): string[] {
  const kept: string[] = []
  let run: string | null = null
  for (const line of lines) {
    if (isProgressLine(line)) {
      if (run !== null) leftOut.progress++
      run = line
      continue
    }
    if (run !== null) {
      kept.push(run)
      run = null
    }
    kept.push(line)
  }
  if (run !== null) kept.push(run)
  return kept
}

function dropNoise(lines: readonly string[], leftOut: OutputFilterLeftOut): string[] {
  const kept: string[] = []
  for (const line of lines) {
    if (isNoiseLine(line)) leftOut.noise++
    else kept.push(line)
  }
  return kept
}

function foldRepeats(lines: readonly string[], leftOut: OutputFilterLeftOut): string[] {
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    let end = index + 1
    while (end < lines.length && lines[end] === line) end++
    const count = end - index
    if (count >= REPEAT_RUN_FLOOR && line.trim() !== '') {
      kept.push(`${line}  [repeated ${count} times]`)
      leftOut.repeats++
    } else {
      for (let i = index; i < end; i++) kept.push(line)
    }
    index = end
  }
  return kept
}

export function filterShellOutput(text: string): FilteredShellOutput {
  const leftOut: OutputFilterLeftOut = { progress: 0, noise: 0, repeats: 0 }
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const filtered = foldRepeats(dropNoise(collapseProgress(lines, leftOut), leftOut), leftOut)
  const changed = leftOut.progress + leftOut.noise + leftOut.repeats > 0
  return { text: changed ? filtered.join('\n') : text, leftOut, changed }
}

export function outputFilterFooter(leftOut: OutputFilterLeftOut, rawPath: string | undefined): string {
  const parts: string[] = []
  if (leftOut.progress > 0) parts.push(`${leftOut.progress} progress ${plural(leftOut.progress, 'redraw')}`)
  if (leftOut.noise > 0) parts.push(`${leftOut.noise} install ${plural(leftOut.noise, 'line')}`)
  if (leftOut.repeats > 0) parts.push(`${leftOut.repeats} ${plural(leftOut.repeats, 'run')} of repeated lines`)
  const what = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  const where = rawPath === undefined ? '' : `; the raw output is kept at ${rawPath}`
  return `[${SHELL_OUTPUT_FILTER_SETTING}: ${what} left out${where}]`
}

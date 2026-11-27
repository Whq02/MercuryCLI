import { errorMessage } from '../../platform/errors/errors.js'
import { execFileNoThrow } from '../../platform/processes/execFileNoThrow.js'

function debianPackages(): ReadonlyMap<string, string> {
  return new Map([
    ['libglib-2.0.so.0', 'libglib2.0-0'],
    ['libgobject-2.0.so.0', 'libglib2.0-0'],
    ['libgio-2.0.so.0', 'libglib2.0-0'],
    ['libnspr4.so', 'libnspr4'],
    ['libnss3.so', 'libnss3'],
    ['libnssutil3.so', 'libnss3'],
    ['libsmime3.so', 'libnss3'],
    ['libatk-1.0.so.0', 'libatk1.0-0'],
    ['libatk-bridge-2.0.so.0', 'libatk-bridge2.0-0'],
    ['libatspi.so.0', 'libatspi2.0-0'],
    ['libdbus-1.so.3', 'libdbus-1-3'],
    ['libcups.so.2', 'libcups2'],
    ['libexpat.so.1', 'libexpat1'],
    ['libxcb.so.1', 'libxcb1'],
    ['libxkbcommon.so.0', 'libxkbcommon0'],
    ['libasound.so.2', 'libasound2'],
    ['libgbm.so.1', 'libgbm1'],
    ['libX11.so.6', 'libx11-6'],
    ['libXext.so.6', 'libxext6'],
    ['libcairo.so.2', 'libcairo2'],
    ['libpango-1.0.so.0', 'libpango-1.0-0'],
    ['libudev.so.1', 'libudev1'],
    ['libXcomposite.so.1', 'libxcomposite1'],
    ['libXdamage.so.1', 'libxdamage1'],
    ['libXfixes.so.3', 'libxfixes3'],
    ['libXrandr.so.2', 'libxrandr2'],
  ])
}

const PROBE_TIMEOUT_MS = 5_000
const NAMED_LIBRARIES_CAP = 40
const LOADER_REFUSAL = /error while loading shared libraries: ([A-Za-z0-9._+-]{1,80}):/
const LDD_MISSING = /^\s*([A-Za-z0-9._+-]{1,80}) => not found$/gm
const APT_STANZA = /^([a-z0-9][a-z0-9.+-]*):\n {2}Installed: (.+)\n {2}Candidate: (.+)$/gm

export interface LibraryReads {
  platform?: NodeJS.Platform
  run?: (file: string, args: string[]) => Promise<string>
}

async function runProbe(file: string, args: string[]): Promise<string> {
  return (await execFileNoThrow(file, args, { timeout: PROBE_TIMEOUT_MS, useCwd: false })).stdout
}

async function aptNamesFor(packages: readonly string[], run: NonNullable<LibraryReads['run']>): Promise<string[]> {
  if (packages.length === 0) return []
  const answer = await run('apt-cache', ['policy', ...packages.flatMap(name => [`${name}t64`, name])])
  const offered = new Set<string>()
  for (const stanza of answer.matchAll(APT_STANZA)) {
    if (stanza[3] !== '(none)') offered.add(stanza[1]!)
  }
  return packages.flatMap(name => (offered.has(`${name}t64`) ? [`${name}t64`] : offered.has(name) ? [name] : []))
}

export async function missingLibraryWords(failure: string, executablePath: string, reads: LibraryReads = {}): Promise<string | null> {
  if ((reads.platform ?? process.platform) !== 'linux') return null
  const refused = LOADER_REFUSAL.exec(failure)
  if (refused === null) return null
  const run = reads.run ?? runProbe
  const listed = [...(await run('ldd', [executablePath])).matchAll(LDD_MISSING)].map(hit => hit[1]!)
  const missing = [...new Set(listed.length > 0 ? listed : [refused[1]!])]
  const named = missing.slice(0, NAMED_LIBRARIES_CAP).join(', ')
  const more = missing.length > NAMED_LIBRARIES_CAP ? ` and ${missing.length - NAMED_LIBRARIES_CAP} more` : ''
  const packageOf = debianPackages()
  const packages = await aptNamesFor([...new Set(missing.flatMap(soname => packageOf.get(soname) ?? []))], run)
  const install = packages.length === 0 ? '' : `\n  the operator runs: sudo apt-get install ${packages.join(' ')}`
  return `the browser did not start — this machine lacks ${missing.length} shared ${missing.length === 1 ? 'library' : 'libraries'} it loads: ${named}${more}${install}`
}

export async function launchFailure(error: unknown, executablePath: string): Promise<unknown> {
  const words = await missingLibraryWords(errorMessage(error), executablePath)
  return words === null ? error : new Error(words, { cause: error })
}

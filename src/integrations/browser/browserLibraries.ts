import { readdirSync } from 'node:fs'
import { withDeadline } from '../../platform/async/deadline.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'
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
const NO_ARCHIVER = 'no zip archiver is available'
const LDD_MISSING = /^\s*([A-Za-z0-9._+-]{1,80}) => not found$/gm
const APT_STANZA = /^([a-z0-9][a-z0-9.+-]*):\n {2}Installed: (.+)\n {2}Candidate: (.+)$/gm
const APT_LISTS = '/var/lib/apt/lists'
const UPDATE_LINE = '\n  apt holds no package list on this machine, so the same call names the packages to install only after the operator runs: sudo apt-get update'

export interface LibraryReads {
  platform?: NodeJS.Platform
  run?: (file: string, args: string[]) => Promise<string>
  lists?: string
}

async function runProbe(file: string, args: string[]): Promise<string> {
  const answered = execFileNoThrow(file, args, { timeout: PROBE_TIMEOUT_MS, useCwd: false }).then(run => run.stdout)
  return withDeadline(answered, PROBE_TIMEOUT_MS, () => '', { unref: true })
}

async function aptPackagesFor(packages: readonly string[], run: NonNullable<LibraryReads['run']>): Promise<{ offered: { name: string; installed: boolean }[]; absent: string[] }> {
  if (packages.length === 0) return { offered: [], absent: [] }
  const answer = await run('apt-cache', ['policy', 'apt', ...packages.flatMap(name => [`${name}t64`, name])])
  const offered = new Map<string, boolean>()
  for (const stanza of answer.matchAll(APT_STANZA)) {
    if (stanza[3] !== '(none)') offered.set(stanza[1]!, stanza[2] !== '(none)')
  }
  const picks = packages.map(name => (offered.has(`${name}t64`) ? `${name}t64` : offered.has(name) ? name : null))
  return {
    offered: picks.flatMap(pick => (pick === null ? [] : [{ name: pick, installed: offered.get(pick) === true }])),
    absent: offered.get('apt') === true ? packages.filter((_, index) => picks[index] === null) : [],
  }
}

function updateLine(unknownToApt: boolean, reads: LibraryReads): string {
  if (!unknownToApt) return ''
  try {
    return readdirSync(reads.lists ?? APT_LISTS).some(name => name.includes('_Packages')) ? '' : UPDATE_LINE
  } catch (error) {
    passedOver(error)
    return ''
  }
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
  const apt = await aptPackagesFor([...new Set(missing.flatMap(soname => packageOf.get(soname) ?? []))], run)
  const lacking = apt.offered.filter(pkg => !pkg.installed).map(pkg => pkg.name)
  const line = lacking.length === 0 ? updateLine(apt.absent.length > 0, reads) : `\n  the operator runs: sudo apt-get install ${lacking.join(' ')}`
  return `the browser did not start — this machine lacks ${missing.length} shared ${missing.length === 1 ? 'library' : 'libraries'} it loads: ${named}${more}${line}`
}

export async function launchFailure(error: unknown, executablePath: string): Promise<unknown> {
  const words = await missingLibraryWords(errorMessage(error), executablePath)
  return words === null ? error : new Error(words, { cause: error })
}

export async function missingArchiverWords(failure: string, reads: LibraryReads = {}): Promise<string | null> {
  if ((reads.platform ?? process.platform) !== 'linux') return null
  if (!failure.includes(NO_ARCHIVER)) return null
  const apt = await aptPackagesFor(['unzip', ...new Set(debianPackages().values())], reads.run ?? runProbe)
  const lacking = apt.offered.filter(pkg => !pkg.installed).map(pkg => pkg.name)
  if (lacking[0] !== 'unzip') return `this machine lacks unzip, which unpacks the browser's archive${updateLine(apt.absent[0] === 'unzip', reads)}`
  const libraries = lacking.length - 1
  const beside = libraries === 0 ? '' : `, and ${libraries} ${libraries === 1 ? 'package' : 'packages'} of libraries the browser loads`
  return `this machine lacks unzip, which unpacks the browser's archive${beside}\n  the operator runs: sudo apt-get install ${lacking.join(' ')}`
}

export async function installFailure(error: unknown): Promise<unknown> {
  const words = await missingArchiverWords(errorMessage(error))
  return words === null ? error : new Error(words, { cause: error })
}

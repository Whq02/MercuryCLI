import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Browser, detectBrowserPlatform, getDownloadUrl } from '@puppeteer/browsers'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '..', '..'))
const home = mkdtempSync(join(tmpdir(), 'browser-missing-libraries-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_BROWSER = '1'
process.env.MERCURY_BROWSER_NO_DISCOVERY = '1'
process.env.MERCURY_BROWSER_PATH = process.execPath
const CACHE = join(home, 'browsers')
process.env.MERCURY_BROWSER_CACHE_DIR = CACHE

const browser = await import(join(ROOT, 'src/integrations/browser/browserSession.ts'))
const { BrowserTool } = await import(join(ROOT, 'src/tools/browser/BrowserTool.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/engine/run-owner/resolveOwner.ts'))
const owner = processOwnerForLane('missing-libraries')
const { installManagedBrowser } = await import(join(ROOT, 'src/integrations/browser/browserInstall.ts'))
const { call: browserCommand } = await import(join(ROOT, 'src/commands/browser/browserCommand.ts'))
const libraries: {
  missingLibraryWords?: (
    failure: string,
    executablePath: string,
    reads?: { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<string> },
  ) => Promise<string | null>
  missingArchiverWords?: (failure: string, reads?: { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<string> }) => Promise<string | null>
} = existsSync(join(ROOT, 'src/integrations/browser/browserLibraries.ts'))
  ? await import(join(ROOT, 'src/integrations/browser/browserLibraries.ts'))
  : {}

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail.slice(0, 900)} — the sentences are made in src/integrations/browser/browserLibraries.ts`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const EXECUTABLE = '/home/ada/.mercury/browsers/chrome/linux_arm-158.0.8127.88/chrome-linux-arm64/chrome'
const driverFailure = (stderr: string, code: number): string =>
  `Failed to launch the browser process:  Code: ${code}\n\nstderr:\n${stderr}\n\nTROUBLESHOOTING: https://pptr.dev/troubleshooting\n`
const LOADER_FAILURE = driverFailure(`${EXECUTABLE}: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory`, 127)
const SANDBOX_FAILURE = driverFailure('[1126/213001.000000:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!', 133)

const CLEAN_SERVER_MISSING = [
  'libglib-2.0.so.0', 'libgobject-2.0.so.0', 'libnspr4.so', 'libnss3.so', 'libnssutil3.so', 'libsmime3.so', 'libgio-2.0.so.0',
  'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libcups.so.2', 'libxcb.so.1', 'libxkbcommon.so.0', 'libasound.so.2', 'libgbm.so.1',
  'libX11.so.6', 'libXext.so.6', 'libcairo.so.2', 'libpango-1.0.so.0', 'libXcomposite.so.1', 'libXdamage.so.1', 'libXfixes.so.3',
  'libXrandr.so.2', 'libatspi.so.0',
]
const lddOutput = (missing: readonly string[]): string =>
  ['\tlinux-vdso.so.1 (0x0000ffff9f7f2000)', '\tlibdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff8f440000)', ...missing.map(name => `\t${name} => not found`), '\tlibc.so.6 => /lib/aarch64-linux-gnu/libc.so.6 (0x0000ffff8f270000)', ''].join('\n')
const stanza = (name: string, candidate: string, installed = '(none)'): string => `${name}:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n`
const RENAMED = ['libglib2.0-0', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libatspi2.0-0', 'libcups2', 'libasound2']
const PLAIN = ['libnspr4', 'libnss3', 'libxcb1', 'libxkbcommon0', 'libgbm1', 'libx11-6', 'libxext6', 'libcairo2', 'libpango-1.0-0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2']
const APT_2604 = [...RENAMED.flatMap(name => [stanza(`${name}t64`, '2.88.0-1ubuntu0.1'), stanza(name, '(none)')]), ...PLAIN.map(name => stanza(name, '1.0-1'))].join('')
const APT_2204 = [...RENAMED, ...PLAIN].map(name => stanza(name, '1.0-1')).join('')

interface Probe {
  calls: { file: string; args: string[] }[]
  run: (file: string, args: string[]) => Promise<string>
}
function probe(ldd: string, apt: string): Probe {
  const calls: Probe['calls'] = []
  return {
    calls,
    run: async (file, args) => {
      calls.push({ file, args })
      return file === 'ldd' ? ldd : file === 'apt-cache' ? apt : ''
    },
  }
}
const words = async (failure: string, platform: NodeJS.Platform, reads: Probe): Promise<string | null> =>
  libraries.missingLibraryWords === undefined ? 'this tree has no src/integrations/browser/browserLibraries.ts' : libraries.missingLibraryWords(failure, EXECUTABLE, { platform, run: reads.run })
const installLine = (text: string | null): string[] => /\n {2}the operator runs: sudo apt-get install (.+)$/.exec(text ?? '')?.[1]?.split(' ') ?? []

const libraryFailure = (buildId: string): string =>
  `All providers failed for chrome ${buildId}:\n  - DefaultProvider: Extraction failed: no zip archiver is available. Install \`unzip\` (or \`tar.exe\`/Powershell on Windows), or add the optional \`yauzl\` dependency.`
const NO_UNZIP = 'this machine lacks unzip, which unpacks the browser\'s archive'
const SERVER_HOLDS = ['libglib2.0-0t64', 'libnspr4', 'libnss3', 'libdbus-1-3', 'libexpat1', 'libxcb1', 'libxkbcommon0', 'libx11-6', 'libxext6', 'libudev1']
const SERVER_LACKS = ['libatk1.0-0t64', 'libatk-bridge2.0-0t64', 'libatspi2.0-0t64', 'libcups2t64', 'libasound2t64', 'libgbm1', 'libcairo2', 'libpango-1.0-0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2']
const APT_SERVER = [stanza('unzip', '6.0-28ubuntu7'), ...SERVER_HOLDS.map(name => stanza(name, '1.0-1', '1.0-1')), ...SERVER_LACKS.map(name => stanza(name, '1.0-1')), ...RENAMED.map(name => stanza(name, '(none)'))].join('')
const archiverWords = async (failure: string, platform: NodeJS.Platform, reads: Probe): Promise<string | null> =>
  libraries.missingArchiverWords === undefined ? 'this tree words no failure to unpack' : libraries.missingArchiverWords(failure, { platform, run: reads.run })

const context = { agentId: 'missing-libraries', abortController: new AbortController() } as never
const opened = async (): Promise<{ result: string; outcome: string }> => (await BrowserTool.call({ op: 'open', url: 'http://127.0.0.1:9/' }, context)).data

try {
  section('1. a clean Ubuntu 26.04 server: every library ldd reports, and the install line apt vouches for')
  const server = probe(lddOutput(CLEAN_SERVER_MISSING), APT_2604)
  const serverWords = await words(LOADER_FAILURE, 'linux', server)
  check('the sentence is the tool\'s own and says the browser did not start', serverWords?.startsWith('the browser did not start — this machine lacks 23 shared libraries it loads: ') === true, serverWords ?? '(none)')
  check('every one of the 23 missing libraries is named', CLEAN_SERVER_MISSING.every(name => serverWords?.includes(name) === true), serverWords ?? '(none)')
  check('the install line names the 19 packages, the renamed six by the name apt offers', JSON.stringify(installLine(serverWords).toSorted()) === JSON.stringify([...RENAMED.map(name => `${name}t64`), ...PLAIN].toSorted()), installLine(serverWords).join(' '))
  check('it says what the operator runs', serverWords?.includes('\n  the operator runs: sudo apt-get install ') === true, serverWords ?? '(none)')
  check('the driver\'s troubleshooting line and the executable\'s path are not in it', serverWords !== null && !/pptr\.dev|TROUBLESHOOTING|Failed to launch|\/home\/ada/.test(serverWords), serverWords ?? '(none)')
  check('ldd is read once, on the executable that failed', server.calls.filter(call => call.file === 'ldd').length === 1 && server.calls.find(call => call.file === 'ldd')?.args.join(' ') === EXECUTABLE, JSON.stringify(server.calls.map(call => call.file)))
  check('apt is asked once', server.calls.filter(call => call.file === 'apt-cache').length === 1, JSON.stringify(server.calls.map(call => call.file)))

  section('2. a release without the renamed packages: the names apt offers there')
  const older = await words(LOADER_FAILURE, 'linux', probe(lddOutput(CLEAN_SERVER_MISSING), APT_2204))
  check('the install line holds no t64 name and all 19 packages', installLine(older).length === 19 && installLine(older).every(name => !name.endsWith('t64')), installLine(older).join(' '))

  section('3. a machine whose apt knows none of them, or has no apt: the libraries and no install line')
  const noApt = await words(LOADER_FAILURE, 'linux', probe(lddOutput(CLEAN_SERVER_MISSING), ''))
  check('the libraries are named', CLEAN_SERVER_MISSING.every(name => noApt?.includes(name) === true), noApt ?? '(none)')
  check('no install line is printed', noApt !== null && !noApt.includes('apt-get') && !noApt.includes('\n'), noApt ?? '(none)')
  const partial = await words(LOADER_FAILURE, 'linux', probe(lddOutput(['libgbm.so.1', 'libmercury-proof-absent.so.9']), stanza('libgbm1', '25.0-1')))
  check('a library with no known package is named and left out of the install line', partial?.includes('libmercury-proof-absent.so.9') === true && installLine(partial).join(' ') === 'libgbm1', partial ?? '(none)')

  section('4. ldd answers nothing: the one library the loader named')
  const silent = await words(LOADER_FAILURE, 'linux', probe('', APT_2604))
  check('one library, the loader\'s own', silent?.startsWith('the browser did not start — this machine lacks 1 shared library it loads: libglib-2.0.so.0') === true && installLine(silent).join(' ') === 'libglib2.0-0t64', silent ?? '(none)')

  section('5. what ldd prints is data: a name is cut, the list is bounded')
  const hostile = await words(LOADER_FAILURE, 'linux', probe(lddOutput([`lib${'x'.repeat(300)}.so.1`, 'lib\u001b[31mred.so.1', 'libgbm.so.1']), ''))
  check('a name over 80 characters or with a control character is not printed', hostile !== null && !hostile.includes('xxxx') && !hostile.includes('\u001b') && hostile.includes('libgbm.so.1'), hostile ?? '(none)')
  const many = await words(LOADER_FAILURE, 'linux', probe(lddOutput(Array.from({ length: 50 }, (_, index) => `libmany${index}.so.1`)), ''))
  check('fifty missing libraries: forty named and the rest counted', many?.includes('lacks 50 shared libraries') === true && many.includes('libmany39.so.1') && !many.includes('libmany40.so.1') && many.endsWith(' and 10 more'), many ?? '(none)')

  section('6. controls: another platform, another failure')
  for (const platform of ['darwin', 'win32'] as const) {
    const other = probe(lddOutput(CLEAN_SERVER_MISSING), APT_2604)
    check(`${platform}: no sentence and no program run`, (await words(LOADER_FAILURE, platform, other)) === null && other.calls.length === 0, JSON.stringify(other.calls))
  }
  const sandbox = probe(lddOutput(CLEAN_SERVER_MISSING), APT_2604)
  check('linux, a sandbox refusal: no sentence and no program run', (await words(SANDBOX_FAILURE, 'linux', sandbox)) === null && sandbox.calls.length === 0, JSON.stringify(sandbox.calls))

  section('7. through the tool, the driver stood in')
  browser.setBrowserLaunchDriverForProof(async () => { throw new Error(SANDBOX_FAILURE) })
  const refused = await opened()
  check('a launch that fails for another reason answers the driver\'s words, as before', refused.outcome === 'failed' && refused.result === `open failed: ${SANDBOX_FAILURE}`, refused.result)
  browser.setBrowserLaunchDriverForProof(async () => { throw new Error(LOADER_FAILURE) })
  const loader = await opened()
  if (process.platform === 'linux') {
    check('linux: a launch the loader refused answers the tool\'s sentence', loader.outcome === 'failed' && loader.result.startsWith('open failed: the browser did not start — this machine lacks ') && !/pptr\.dev|TROUBLESHOOTING/.test(loader.result), loader.result)
  } else {
    check(`${process.platform}: a launch the loader refused answers the driver's words, as before`, loader.outcome === 'failed' && loader.result === `open failed: ${LOADER_FAILURE}`, loader.result)
  }
  browser.setBrowserLaunchDriverForProof(null)

  section('8. linux: a real program with libraries it cannot load, started by the real driver')
  const patched = (['/bin/bash', '/bin/sh'] as const)
    .filter(file => process.platform === 'linux' && existsSync(file))
    .map(file => {
      let bytes = readFileSync(file).toString('latin1')
      const absent: string[] = []
      for (const [real, stand] of [['libtinfo.so.6', 'libtinfq.so.6'], ['libc.so.6', 'libq.so.6']] as const) {
        if (!bytes.includes(`${real}\u0000`)) continue
        bytes = bytes.replaceAll(`${real}\u0000`, `${stand}\u0000`)
        absent.push(stand)
      }
      return { bytes, absent }
    })
    .toSorted((a, b) => b.absent.length - a.absent.length)[0]
  if (patched === undefined || patched.absent.length === 0) {
    console.log(`  (not run here: ${process.platform === 'linux' ? 'neither /bin/bash nor /bin/sh names a glibc library to take away' : `${process.platform} has no ld.so; sections 1 to 7 hold the sentence`})`)
  } else {
    const program = join(home, 'no-libraries')
    writeFileSync(program, patched.bytes, 'latin1')
    chmodSync(program, 0o755)
    process.env.MERCURY_BROWSER_PATH = program
    const real = await opened()
    check(`the answer names every library taken away (${patched.absent.join(', ')})`, real.outcome === 'failed' && patched.absent.every(name => real.result.includes(name)), real.result)
    check('the answer is the tool\'s sentence, with no line of the driver\'s', real.result.startsWith(`open failed: the browser did not start — this machine lacks ${patched.absent.length} shared `) && !/pptr\.dev|TROUBLESHOOTING|Failed to launch/.test(real.result), real.result)
    check('a library no package is known for brings no install line', !real.result.includes('apt-get'), real.result)
  }

  section('9. a library that is there and cannot be loaded: a package apt reports installed is not named')
  const oneHeld = await words(LOADER_FAILURE, 'linux', probe(lddOutput(['libgbm.so.1', 'libcairo.so.2']), [stanza('libgbm1', '25.0-1', '25.0-1'), stanza('libcairo2', '1.18.4-1')].join('')))
  check('both libraries are named and the line names the one package that is not installed', oneHeld?.includes('libgbm.so.1') === true && oneHeld.includes('libcairo.so.2') && installLine(oneHeld).join(' ') === 'libcairo2', oneHeld ?? '(none)')
  const allHeld = await words(LOADER_FAILURE, 'linux', probe(lddOutput(['libgbm.so.1', 'libasound.so.2']), [stanza('libgbm1', '25.0-1', '25.0-1'), stanza('libasound2t64', '1.2.15-1', '1.2.15-1'), stanza('libasound2', '(none)')].join('')))
  check('every package installed: the libraries are named and no line is printed', allHeld?.includes('libgbm.so.1') === true && allHeld.includes('libasound.so.2') && !allHeld.includes('apt-get') && !allHeld.includes('\n'), allHeld ?? '(none)')

  section('10. a probe whose own child keeps its pipe open is given up at the bound')
  if (process.platform === 'win32' || libraries.missingLibraryWords === undefined) {
    console.log(`  (not run here: ${process.platform === 'win32' ? 'the stand-in program is a POSIX shell script' : 'this tree has no sentence to bound'})`)
  } else {
    const programs = join(home, 'programs')
    mkdirSync(programs)
    const lingerer = join(programs, 'ldd.pid')
    writeFileSync(join(programs, 'ldd'), `#!/bin/sh\n/bin/sleep 14 &\necho $! > '${lingerer}'\nwait\n`)
    chmodSync(join(programs, 'ldd'), 0o755)
    const reach = process.env.PATH
    process.env.PATH = programs
    const began = Date.now()
    const bounded = await libraries.missingLibraryWords(LOADER_FAILURE, EXECUTABLE, { platform: 'linux' }).finally(() => {
      process.env.PATH = reach
    })
    const took = Date.now() - began
    const ran = existsSync(lingerer)
    if (ran && took < 13_000) spawnSync('/bin/kill', [readFileSync(lingerer, 'utf8').trim()])
    check('the stand-in ldd ran and left a child of its own holding its pipe', ran, programs)
    check(`the answer came within the 5 s bound and a second (${took} ms)`, took < 6_000, 'the probe was waited for past its bound')
    check('it reads as when ldd is absent: the one library the loader named and no line', bounded === 'the browser did not start — this machine lacks 1 shared library it loads: libglib-2.0.so.0', bounded ?? '(none)')
  }

  section('11. a provision with no unpacker, apt answering as on a clean Ubuntu Server 26.04: one line for both steps')
  const clean = probe('', APT_SERVER)
  const cleanWords = await archiverWords(libraryFailure('158.0.8127.88'), 'linux', clean)
  check('the sentence is the tool\'s own', cleanWords?.startsWith(`${NO_UNZIP}, and 12 packages of libraries the browser loads\n`) === true, cleanWords ?? '(none)')
  check('the line is unzip first, then the twelve packages the server lacks and none it holds', installLine(cleanWords)[0] === 'unzip' && JSON.stringify(installLine(cleanWords).slice(1).toSorted()) === JSON.stringify(SERVER_LACKS.toSorted()), installLine(cleanWords).join(' '))
  check('nothing of Windows, of an optional package or of the library\'s own words is in it', cleanWords !== null && !/Windows|Powershell|tar\.exe|yauzl|DefaultProvider|All providers/.test(cleanWords), cleanWords ?? '(none)')
  check('apt is asked once and nothing else is run', clean.calls.length === 1 && clean.calls[0]?.file === 'apt-cache', JSON.stringify(clean.calls.map(call => call.file)))
  const whole = await archiverWords(libraryFailure('158.0.8127.88'), 'linux', probe('', [stanza('unzip', '6.0-28'), ...[...SERVER_HOLDS, ...SERVER_LACKS].map(name => stanza(name, '1.0-1', '1.0-1'))].join('')))
  check('a machine that holds every library: unzip alone', whole === `${NO_UNZIP}\n  the operator runs: sudo apt-get install unzip`, whole ?? '(none)')
  const plainNames = await archiverWords(libraryFailure('158.0.8127.88'), 'linux', probe('', [stanza('unzip', '6.0-26'), ...[...RENAMED, ...PLAIN].map(name => stanza(name, '1.0-1'))].join('')))
  check('a release without the renamed packages: its own names', installLine(plainNames)[0] === 'unzip' && installLine(plainNames).includes('libasound2') && installLine(plainNames).every(name => !name.endsWith('t64')), installLine(plainNames).join(' '))
  const bare = await archiverWords(libraryFailure('158.0.8127.88'), 'linux', probe('', ''))
  check('no apt: the sentence and no line', bare === NO_UNZIP, bare ?? '(none)')
  const unzipHeld = await archiverWords(libraryFailure('158.0.8127.88'), 'linux', probe('', [stanza('unzip', '6.0-28', '6.0-28'), ...SERVER_LACKS.map(name => stanza(name, '1.0-1'))].join('')))
  check('apt reports unzip installed: the sentence and no line', unzipHeld === NO_UNZIP, unzipHeld ?? '(none)')
  for (const platform of ['darwin', 'win32'] as const) {
    const other = probe('', APT_SERVER)
    check(`${platform}: no sentence and no program run`, (await archiverWords(libraryFailure('158.0.8127.88'), platform, other)) === null && other.calls.length === 0, JSON.stringify(other.calls))
  }
  const otherFailure = probe('', APT_SERVER)
  check('another failure of the library: no sentence and no program run', (await archiverWords('All providers failed for chrome 158.0.8127.88:\n  - DefaultProvider: Extraction failed: End-of-central-directory signature not found.', 'linux', otherFailure)) === null && otherFailure.calls.length === 0, JSON.stringify(otherFailure.calls))

  section('12. through the installer: the library makes the build folder, then finds no unpacker')
  const libraryError = new Error(libraryFailure('158.0.8127.96'))
  let made = ''
  const thrown: unknown = await installManagedBrowser('158.0.8127.96', undefined, async (options: { cacheDir: string; platform: string; buildId: string }) => {
    made = join(options.cacheDir, Browser.CHROME, `${options.platform}-${options.buildId}`)
    mkdirSync(made, { recursive: true })
    throw libraryError
  }).then(() => null, (error: unknown) => error)
  const said = thrown instanceof Error ? thrown.message : String(thrown)
  if (process.platform === 'linux') {
    check('linux: the installer throws the tool\'s sentence', said.startsWith(NO_UNZIP) && !/yauzl|Powershell/.test(said), said)
    check('linux: the library\'s error is its cause', thrown instanceof Error && thrown.cause === libraryError, said)
  } else {
    check(`${process.platform}: the installer rethrows the library's error as it came`, thrown === libraryError, said)
  }
  check('the build folder the failed attempt made is gone', made.startsWith(CACHE) && !existsSync(made), made)

  section('13. both doors, the real library, no unpacker in reach')
  const hostPlatform = detectBrowserPlatform()
  if (process.platform === 'win32' || hostPlatform === undefined) {
    console.log('  (not run here: on Windows the library unpacks by the system\'s own tar.exe, found by its path)')
  } else {
    const stage = (buildId: string): string => {
      const archive = decodeURIComponent(getDownloadUrl(Browser.CHROME, hostPlatform, buildId).toString()).split('/').pop() ?? ''
      mkdirSync(join(CACHE, Browser.CHROME), { recursive: true })
      writeFileSync(join(CACHE, Browser.CHROME, `${buildId}-${archive}`), 'an archive no program in reach unpacks')
      return join(CACHE, Browser.CHROME, `${hostPlatform}-${buildId}`)
    }
    const told = (answer: string, door: string, buildId: string): boolean =>
      process.platform === 'linux'
        ? answer.startsWith(`${door}${NO_UNZIP}`) && !/Windows|Powershell|yauzl|DefaultProvider/.test(answer)
        : answer === `${door}${libraryFailure(buildId)}`
    const expected = process.platform === 'linux' ? 'the tool\'s sentence' : 'the library\'s words, as before'
    const reach = process.env.PATH
    const nowhere = join(home, 'no-programs')
    mkdirSync(nowhere)
    process.env.PATH = nowhere
    const toolFolder = stage('158.0.8127.97')
    const commandFolder = stage('158.0.8127.98')
    const provisioned: { result: string; outcome: string } = (await BrowserTool.call({ op: 'provision', buildId: '158.0.8127.97' }, context)).data
    const typed: unknown = await browserCommand('install 158.0.8127.98 confirm', {}).then(() => null, (error: unknown) => error)
    process.env.PATH = reach
    check(`${process.platform}: the tool's provision answers ${expected}`, provisioned.outcome === 'failed' && told(provisioned.result, 'provision failed: ', '158.0.8127.97'), provisioned.result)
    check('the build folder the library made for it is gone', !existsSync(toolFolder), toolFolder)
    check(`${process.platform}: /browser install throws ${expected}`, told(String(typed), 'Error: ', '158.0.8127.98'), String(typed))
    check('the build folder the library made for it is gone', !existsSync(commandFolder), commandFolder)
  }
} finally {
  browser.setBrowserLaunchDriverForProof(null)
  await browser.closeBrowserSessionDetailed(owner)
  removeScratch(home)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const browser = await import(join(ROOT, 'src/integrations/browser/browserSession.ts'))
const { BrowserTool } = await import(join(ROOT, 'src/tools/browser/BrowserTool.ts'))
const { processOwnerForLane } = await import(join(ROOT, 'src/engine/run-owner/resolveOwner.ts'))
const owner = processOwnerForLane('missing-libraries')
const libraries: {
  missingLibraryWords?: (
    failure: string,
    executablePath: string,
    reads?: { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<string> },
  ) => Promise<string | null>
} = existsSync(join(ROOT, 'src/integrations/browser/browserLibraries.ts'))
  ? await import(join(ROOT, 'src/integrations/browser/browserLibraries.ts'))
  : {}

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
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
const stanza = (name: string, candidate: string): string => `${name}:\n  Installed: (none)\n  Candidate: ${candidate}\n  Version table:\n`
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
} finally {
  browser.setBrowserLaunchDriverForProof(null)
  await browser.closeBrowserSessionDetailed(owner)
  removeScratch(home)
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)

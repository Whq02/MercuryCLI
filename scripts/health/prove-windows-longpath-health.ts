import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.10' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)

const rawScratch = mkdtempSync(join(tmpdir(), 'win-longpath-health-'))
const scratch = realpathSync(rawScratch)
const home = join(scratch, 'home')
const configDir = join(home, '.mercury')
const daemonDir = join(configDir, 'daemon')
const localAppData = join(scratch, 'AppData', 'Local')
const managedBin = join(localAppData, 'Mercury', 'bin')
const managedVer = join(configDir, 'versions', '1.0.10')
const extractedDir = join(scratch, 'winget', 'mercury')
const nodeExe = join(extractedDir, 'vendor', 'node', 'node.exe')
const bundleMjs = join(extractedDir, 'mercury.mjs')
const work = join(scratch, 'work')

for (const dir of [home, configDir, daemonDir, managedBin, managedVer, dirname(nodeExe), work]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(managedVer, 'mercury.mjs'), 'export {}\n')
writeFileSync(join(managedVer, 'manifest.json'), '{"node":">=24"}\n')
writeFileSync(join(configDir, 'versions', 'current.txt'), '1.0.10\n')
writeFileSync(join(managedBin, 'mercury.cmd'), '@echo off\r\n')
writeFileSync(bundleMjs, 'export {}\n')
writeFileSync(join(extractedDir, 'manifest.json'), '{"node":">=24"}\n')
writeFileSync(join(extractedDir, 'mercury.cmd'), '@echo off\r\n')
writeFileSync(nodeExe, '')

const savedEnv = { ...process.env }
const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')!
const execPathDesc = Object.getOwnPropertyDescriptor(process, 'execPath')!
const savedArgv1 = process.argv[1]

let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail = ''): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}

try {
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    PATH: `${managedBin};/usr/bin;/bin`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  })
  for (const key of [
    'MERCURY_HOME',
    'MERCURY_VERSIONS_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'MERCURY_OAUTH_TOKEN',
  ]) {
    delete process.env[key]
  }

  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  Object.defineProperty(process, 'execPath', { value: nodeExe, configurable: true })
  process.argv[1] = `\\\\?\\${bundleMjs}`

  const { runWithCwdOverride } = await import(`${root}/src/utils/cwd.ts`)
  const { runHealthReport } = await import(`${root}/src/utils/healthReport.ts`)
  const { classifyInstallProvenance, gatherInstallProbeFacts, provenanceLine } = await import(
    `${root}/src/services/privateChannel/installProvenance.ts`
  )
  const { commandOnPath, ownCommandWord } = await import(`${root}/src/services/privateChannel/installPath.ts`)

  type Row = { id: string; status: string; evidence: string; fix?: string; detail?: string }
  type Cert = { sections: Array<{ checks: Row[] }> }
  const cert = (await runWithCwdOverride(work, () => runHealthReport())) as Cert
  const allRows: Row[] = cert.sections.flatMap(section => section.checks)
  const rowOf = (id: string): Row | undefined => allRows.find(row => row.id === id)

  const provRow = rowOf('install-provenance')
  check(
    'install-provenance strips \\\\?\\ and classifies the extracted release beside the managed install',
    provRow?.status === 'ok' &&
      !provRow.evidence.includes('\\\\?\\') &&
      provRow.evidence.includes(`extracted-release 1.0.10 at ${extractedDir}`),
    JSON.stringify(provRow),
  )

  const pathRow = rowOf('command-on-path')
  check(
    'command-on-path names the active install root without \\\\?\\',
    pathRow?.status === 'info' &&
      !pathRow.evidence.includes('\\\\?\\') &&
      pathRow.evidence.includes(`this Mercury runs from ${extractedDir}`),
    JSON.stringify(pathRow),
  )

  const expectedOptIn = `opt-in: run \`${nodeExe} ${bundleMjs} daemon\``
  const signInsRow = rowOf('daemon-sign-ins')
  check(
    'daemon-sign-ins opt-in advice omits \\\\?\\ from the bundle path',
    signInsRow?.status === 'off' &&
      !signInsRow.evidence.includes('\\\\?\\') &&
      signInsRow.evidence.includes(expectedOptIn),
    JSON.stringify(signInsRow),
  )

  const daemonRow = rowOf('daemon')
  check(
    'daemon opt-in advice omits \\\\?\\ from the copyable command',
    daemonRow?.status === 'off' &&
      !daemonRow.evidence.includes('\\\\?\\') &&
      daemonRow.evidence.includes(expectedOptIn),
    JSON.stringify(daemonRow),
  )

  const leaked = allRows.filter(
    r => r.evidence.includes('\\\\?\\') || (r.fix ?? '').includes('\\\\?\\') || (r.detail ?? '').includes('\\\\?\\'),
  )
  check(
    'no health row carries the \\\\?\\ prefix in evidence, fix or detail',
    leaked.length === 0,
    leaked.map(r => `${r.id}: ${r.evidence}`).join(' | '),
  )

  const winExtract = classifyInstallProvenance(
    gatherInstallProbeFacts({
      invokedPath: String.raw`\\?\C:\Users\op\AppData\Local\Microsoft\WinGet\Packages\Mercury\mercury\mercury.mjs`,
      versionsDir: String.raw`C:\Users\op\.mercury\versions`,
      platform: 'win32',
    }),
  )
  check(
    'win32 drive path strips \\\\?\\ at entry in invokedPath, activeRoot and provenanceLine',
    winExtract.invokedPath === String.raw`C:\Users\op\AppData\Local\Microsoft\WinGet\Packages\Mercury\mercury\mercury.mjs` &&
      winExtract.activeRoot === String.raw`C:\Users\op\AppData\Local\Microsoft\WinGet\Packages\Mercury\mercury` &&
      !provenanceLine(winExtract).includes('\\\\?\\'),
    JSON.stringify({ invokedPath: winExtract.invokedPath, activeRoot: winExtract.activeRoot, line: provenanceLine(winExtract) }),
  )

  const winManagedFacts = gatherInstallProbeFacts({
    invokedPath: String.raw`\\?\C:\Users\op\.mercury\versions\1.0.10\mercury.mjs`,
    versionsDir: String.raw`C:\Users\op\.mercury\versions`,
    platform: 'win32',
  })
  check(
    'win32 managed versions containment matches when argv[1] carries \\\\?\\ and versionsDir does not',
    winManagedFacts.entryVersion === '1.0.10' &&
      winManagedFacts.entryVersionDir === String.raw`C:\Users\op\.mercury\versions\1.0.10`,
    JSON.stringify({ entryVersion: winManagedFacts.entryVersion, entryVersionDir: winManagedFacts.entryVersionDir }),
  )

  const winUnc = classifyInstallProvenance(
    gatherInstallProbeFacts({
      invokedPath: String.raw`\\?\UNC\fileserver\tools\mercury\mercury.mjs`,
      versionsDir: String.raw`C:\Users\op\.mercury\versions`,
      platform: 'win32',
    }),
  )
  check(
    'win32 \\\\?\\UNC\\ prefix normalizes to \\\\server\\share',
    winUnc.invokedPath === String.raw`\\fileserver\tools\mercury\mercury.mjs` &&
      winUnc.activeRoot === String.raw`\\fileserver\tools\mercury`,
    JSON.stringify({ invokedPath: winUnc.invokedPath, activeRoot: winUnc.activeRoot }),
  )

  const plainCmd = ownCommandWord({
    provenanceKind: 'extracted-release',
    found: { state: 'absent' },
    node: String.raw`\\?\C:\Mercury\mercury\vendor\node\node.exe`,
    bundle: String.raw`\\?\C:\Mercury\mercury\mercury.mjs`,
  })
  const spacedCmd = ownCommandWord({
    provenanceKind: 'extracted-release',
    found: { state: 'absent' },
    node: String.raw`C:\Users\Alice Smith\Mercury\mercury\vendor\node\node.exe`,
    bundle: String.raw`\\?\C:\Users\Alice Smith\Mercury\mercury\mercury.mjs`,
  })
  const uncCmd = ownCommandWord({
    provenanceKind: 'extracted-release',
    found: { state: 'absent' },
    node: String.raw`\\?\UNC\fileserver\tools\mercury\vendor\node\node.exe`,
    bundle: String.raw`\\?\UNC\fileserver\tools\mercury\mercury.mjs`,
  })
  check(
    'ownCommandWord strips \\\\?\\ and \\\\?\\UNC\\ on Windows before quoting',
    plainCmd === String.raw`C:\Mercury\mercury\vendor\node\node.exe C:\Mercury\mercury\mercury.mjs` &&
      spacedCmd ===
        `${JSON.stringify(String.raw`C:\Users\Alice Smith\Mercury\mercury\vendor\node\node.exe`)} ${JSON.stringify(String.raw`C:\Users\Alice Smith\Mercury\mercury\mercury.mjs`)}` &&
      uncCmd === String.raw`\\fileserver\tools\mercury\vendor\node\node.exe \\fileserver\tools\mercury\mercury.mjs`,
    JSON.stringify({ plainCmd, spacedCmd, uncCmd }),
  )

  const cmdFound = commandOnPath(
    {
      versionsDir: String.raw`C:\Users\op\.mercury\versions`,
      binDir: String.raw`C:\Users\op\AppData\Local\Mercury\bin`,
      shimPath: String.raw`C:\Users\op\AppData\Local\Mercury\bin\mercury.cmd`,
      shimSetPaths: [String.raw`C:\Users\op\AppData\Local\Mercury\bin\mercury.cmd`],
      isWindows: true,
    },
    () => String.raw`\\?\C:\Tools\mercury\mercury.exe`,
  )
  check(
    'commandOnPath strips \\\\?\\ from a resolved Windows command path',
    cmdFound.state === 'other' && cmdFound.resolved === String.raw`C:\Tools\mercury\mercury.exe`,
    JSON.stringify(cmdFound),
  )

  Object.defineProperty(process, 'platform', platformDesc)
  const posixFacts = gatherInstallProbeFacts({
    invokedPath: bundleMjs,
    versionsDir: join(configDir, 'versions'),
    platform: 'darwin',
  })
  const posixCmd = ownCommandWord({
    provenanceKind: 'development',
    found: { state: 'absent' },
    node: '/usr/local/bin/node',
    bundle: '/Users/op/mercury/dist/mercury.mjs',
  })
  check(
    'POSIX paths and ownCommandWord remain unchanged',
    posixFacts.invokedPath === bundleMjs && posixCmd === '/usr/local/bin/node /Users/op/mercury/dist/mercury.mjs',
    JSON.stringify({ invokedPath: posixFacts.invokedPath, posixCmd }),
  )
} finally {
  Object.defineProperty(process, 'platform', platformDesc)
  Object.defineProperty(process, 'execPath', execPathDesc)
  if (savedArgv1 === undefined) delete process.argv[1]
  else process.argv[1] = savedArgv1
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)

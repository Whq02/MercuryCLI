import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { firstPtyVisibility, nodeBinPath, runArtifactArena } from '../streaming/artifactArena.ts'

const option = (name: string): string | undefined => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const root = resolve(option('--source') ?? join(dirname(fileURLToPath(import.meta.url)), '../..'))
const dist = resolve(option('--dist') ?? join(root, 'dist/mercury.mjs'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-nix-')))
const output = join(scratch, 'nix/store/00000000000000000000000000000000-mercury-9.9.9')
const payload = join(output, 'libexec/mercury')
const marker = join(output, 'nix-support/mercury')
const entry = join(payload, 'mercury.mjs')
const node = nodeBinPath()
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function snapshot(dir: string): string {
  if (!existsSync(dir)) return 'absent'
  const walk = (at: string): string[] => readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(row => row.isDirectory() ? walk(join(at, row.name)) : [`${join(at, row.name).slice(dir.length)}:${createHash('sha256').update(readFileSync(join(at, row.name))).digest('hex')}`])
  return walk(dir).join('\n')
}
try {
  mkdirSync(payload, { recursive: true })
  mkdirSync(dirname(marker), { recursive: true })
  copyFileSync(dist, entry)
  copyFileSync(join(dirname(dist), 'manifest.json'), join(payload, 'manifest.json'))
  writeFileSync(join(payload, 'mercury'), '#!/bin/sh\nexit 0\n')
  writeFileSync(marker, 'libexec/mercury\n')
  const { gatherInstallProbeFacts, classifyInstallProvenance, provenanceGuidance } = await import(pathToFileURL(join(root, 'src/services/privateChannel/installProvenance.ts')).href)
  const versions = join(scratch, 'probe-versions')
  const facts = (path: string, platform: NodeJS.Platform = process.platform) => gatherInstallProbeFacts({ invokedPath: path, versionsDir: versions, platform, env: { IN_NIX_SHELL: 'pure', NIX_PROFILES: output } })
  const owned = classifyInstallProvenance(facts(entry, 'linux'))
  check('the flake-shaped real payload belongs to Nix', owned.kind === 'nix' && owned.updateOwner === 'nix', JSON.stringify(owned))
  const link = join(scratch, 'profile-entry.mjs')
  symlinkSync(entry, link)
  check('a profile symlink has the same real payload owner', classifyInstallProvenance(facts(link, 'linux')).kind === 'nix')
  check('Windows keeps its existing owner even with the Nix marker present', classifyInstallProvenance(facts(entry, 'win32')).kind !== 'nix')
  check('Nix guidance names the flake or profile, not a managed installation', provenanceGuidance(owned) === 'update the flake input or the profile that provides it')
  check('the evidence names the ownership marker', owned.evidence.some((line: string) => line.includes(marker)))
  const copied = join(scratch, 'copied/mercury.mjs')
  mkdirSync(dirname(copied), { recursive: true })
  copyFileSync(entry, copied)
  copyFileSync(join(payload, 'manifest.json'), join(dirname(copied), 'manifest.json'))
  copyFileSync(join(payload, 'mercury'), join(dirname(copied), 'mercury'))
  check('a payload copied out of its Nix output is not owned by Nix', classifyInstallProvenance(facts(copied, 'linux')).kind === 'extracted-release')
  rmSync(marker)
  check('a store-shaped path or Nix environment alone is not ownership', classifyInstallProvenance(facts(entry, 'linux')).kind === 'extracted-release')
  writeFileSync(marker, 'libexec/somewhere-else\n')
  check('a marker for another payload is not ownership', classifyInstallProvenance(facts(entry, 'linux')).kind === 'extracted-release')
  writeFileSync(marker, 'libexec/mercury\n')
  for (const path of [entry, join(payload, 'manifest.json'), join(payload, 'mercury'), marker]) chmodSync(path, 0o444)
  chmodSync(payload, 0o555)
  const immutable = snapshot(output)
  if (process.platform !== 'win32') {
    for (const resident of [false, true]) {
      const home = join(scratch, resident ? 'resident' : 'empty')
      const config = join(home, '.mercury')
      const versionDir = join(config, 'versions')
      const userBin = join(home, '.local/bin')
      mkdirSync(config, { recursive: true })
      mkdirSync(userBin, { recursive: true })
      writeFileSync(join(home, '.profile'), 'original profile\n')
      writeFileSync(join(userBin, 'mercury'), 'foreign command\n')
      if (resident) {
        mkdirSync(join(versionDir, '8.8.8'), { recursive: true })
        writeFileSync(join(versionDir, 'current.txt'), '8.8.8\n')
        writeFileSync(join(versionDir, 'previous.txt'), '8.8.7\n')
        writeFileSync(join(versionDir, '8.8.8/mercury'), 'co-resident payload\n')
      }
      const protectedBytes = (): string => [snapshot(versionDir), snapshot(userBin), readFileSync(join(home, '.profile'), 'utf8')].join('\n')
      const before = protectedBytes()
      const ghLog = join(scratch, `gh-${resident}.log`)
      const gh = join(scratch, `gh-${resident}.mjs`)
      writeFileSync(gh, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(ghLog)}, 'called\\n'); process.exit(1)\n`)
      for (const args of [['update'], ['update', '--yes'], ['update', '--check'], ['update', '--status'], ['update', '--rollback'], ['install'], ['install', '--dry-run'], ['install', '--uninstall']]) {
        const rollback = args.includes('--rollback')
        const sentence = rollback
          ? "rollback refused: this Mercury was installed by Nix; `mercury update --rollback` manages installs made by `mercury install` or the install script\n  Nix manages this install's versions; roll back the flake input or the profile that provides it\nupdate the flake input or the profile that provides it"
          : args[0] === 'install'
            ? 'this Mercury was installed by Nix; manage it through the flake or the profile that provides it'
            : args.includes('--status')
              ? `installed by Nix at ${payload} — update the flake input or the profile that provides it`
              : 'this Mercury was installed by Nix; update the flake input or the profile that provides it'
        const env = { PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home, MERCURY_CONFIG_DIR: config, MERCURY_VERSIONS_DIR: versionDir, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_UPDATE_API_BASE_URL: 'http://127.0.0.1:1', MERCURY_GH_CMD: JSON.stringify([node, gh]), CI: '1', TERM: 'dumb' }
        const homeCheck = spawnSync(node, ['-e', 'if (require("node:os").homedir() !== process.env.HOME) throw new Error("Nix proof runtime has the wrong home")'], { env, encoding: 'utf8' })
        if (homeCheck.status !== 0) throw new Error(homeCheck.stderr || 'Nix proof runtime did not confirm its scratch home')
        const run = spawnSync(node, [entry, ...args], { env, encoding: 'utf8', timeout: 30_000 })
        check(`${resident ? 'co-resident' : 'empty'} home: ${args.join(' ')} answers with the owner sentence and the package-manager exit`, run.status === (rollback ? 1 : 0) && (rollback ? run.stderr : run.stdout).trim() === sentence, `${run.status}: ${run.stdout} ${run.stderr}`)
        const json = spawnSync(node, [entry, ...args, '--json'], { env, encoding: 'utf8', timeout: 30_000 })
        let record: any = null
        try { record = JSON.parse(json.stdout) } catch {}
        check(`${resident ? 'co-resident' : 'empty'} home: ${args.join(' ')} JSON records Nix, no guessed command and the existing refusal state only for rollback`, json.status === (rollback ? 1 : 0) && record?.state === (rollback ? 'refused' : 'installer-managed') && record?.provenance?.kind === 'nix' && record?.provenance?.updateOwner === 'nix' && record?.provenance?.updateCommand === null, json.stdout + json.stderr)
      }
      check(`${resident ? 'co-resident' : 'empty'} home: every managed byte, foreign command and PATH file stayed intact`, protectedBytes() === before, `before=${before}\nafter=${protectedBytes()}`)
      check(`${resident ? 'co-resident' : 'empty'} home: no package manager or release channel was consulted`, !existsSync(ghLog))
    }
    for (const resident of [false, true]) {
      let configDir = ''
      const run = await runArtifactArena({
        distPath: entry,
        turns: [],
        sends: [],
        seconds: 15,
        cols: 120,
        rows: 40,
        keep: true,
        anchor: null,
        extraEnv: { MERCURY_UPDATE_API_BASE_URL: 'http://127.0.0.1:1', MERCURY_GH_CMD: JSON.stringify([node, '-e', 'process.exit(1)']), BROWSER: '/usr/bin/true' },
        seedHome: dir => {
          configDir = dir
          if (!resident) return
          mkdirSync(join(dir, 'versions/8.8.8'), { recursive: true })
          writeFileSync(join(dir, 'versions/current.txt'), '8.8.8\n')
          writeFileSync(join(dir, 'versions/8.8.8/mercury'), '#!/bin/sh\nexit 0\n')
        },
      })
      try {
        check(`${resident ? 'co-resident' : 'empty'} home: the read-only payload boots to the chat`, firstPtyVisibility(run.ptyReads, 'Typeaprompt', 0) !== undefined, run.outcome.reason ?? '')
        check(`${resident ? 'co-resident' : 'empty'} home: startup passed the launcher step`, existsSync(join(configDir, 'invocation-record.json')))
        check(`${resident ? 'co-resident' : 'empty'} home: startup wrote no managed launcher`, !existsSync(join(run.paths.home, '.local/bin/mercury')))
        check(`${resident ? 'co-resident' : 'empty'} home: startup armed no quiet update cache`, !existsSync(join(configDir, 'update-notice.json')))
      } finally { run.cleanup() }
    }
  }
  check('all invocations left the read-only store payload byte-identical', snapshot(output) === immutable)
} finally {
  if (existsSync(payload)) chmodSync(payload, 0o755)
  for (const path of [entry, join(payload, 'manifest.json'), join(payload, 'mercury'), marker]) if (existsSync(path)) chmodSync(path, 0o644)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`prove-nix-ownership: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0

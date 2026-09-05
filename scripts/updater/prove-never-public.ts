#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const channelDir = join(ROOT, 'src', 'services', 'privateChannel')
const channelFiles = readdirSync(channelDir).filter(f => f.endsWith('.ts'))
check('the channel owner exists with its modules', channelFiles.length >= 4, channelFiles.join(', '))
const channelSources = new Map(channelFiles.map(f => [f, readFileSync(join(channelDir, f), 'utf8')] as const))
const channelSrc = [...channelSources.values()].join('\n')
const cliSrc =
  readFileSync(join(ROOT, 'src', 'cli', 'update.ts'), 'utf8') + readFileSync(join(ROOT, 'src', 'cli', 'installVerb.ts'), 'utf8')
const all = channelSrc + cliSrc
const TRANSPORT = 'channelTransport.ts'
const transportSrc = channelSources.get(TRANSPORT) ?? ''
check('the anonymous road has its one owner', transportSrc.length > 0, `${TRANSPORT} absent`)

for (const [label, needle] of [
  ['npm registry', 'npmjs.com'],
  ['npm install path', 'npm install'],
  ['GCS bucket delivery', 'storage.googleapis'],
  ['hand-built release-asset URL (the listing owns every download URL)', 'releases/download/'],
  ['curl transport', "'curl'"],
] as const) {
  check(`channel sources carry no ${label}`, !all.includes(needle))
}

for (const [file, src] of channelSources) {
  if (file === TRANSPORT) continue
  check(`${file} performs no fetch of its own (the anonymous road is ${TRANSPORT})`, !src.includes('fetch('))
}
check('the cli verbs perform no fetch of their own', !cliSrc.includes('fetch('))
check(
  'the anonymous root is the registered seam over the GitHub REST default, in the transport only',
  /flagEnv\('MERCURY_UPDATE_API_BASE_URL'\)/.test(transportSrc) &&
    transportSrc.includes("'https://api.github.com'") &&
    ![...channelSources].some(([f, s]) => f !== TRANSPORT && (s.includes('MERCURY_UPDATE_API_BASE_URL') || s.includes('api.github.com'))),
)
check('the anonymous request sends no credential header', !/authorization/i.test(transportSrc))
check(
  'every anonymous wait is a named inactivity deadline, never a bare timeout',
  transportSrc.includes('armInactivityDeadline(') && !all.includes('AbortSignal.timeout') && !/setTimeout\(/.test(transportSrc),
)
check('the anonymous road follows the release record\'s own download URL', transportSrc.includes('browser_download_url') || channelSources.get('channelCore.ts')!.includes('browser_download_url'))

check(
  'the only spawned transport binary is gh (MERCURY_GH_CMD the sole registered override)',
  /return \['gh'\]/.test(channelSrc) &&
    /flagEnv\('MERCURY_GH_CMD'\)/.test(channelSrc) &&
    /execFile\(argv\[0\]!/.test(channelSrc) &&
    !/execFile\('(?!chmod)/.test(channelSrc),
)

for (const [label, needle] of [
  ['gh token subcommand', 'auth token'],
  ['GH_TOKEN env read', 'GH_TOKEN'],
  ['GITHUB_TOKEN env read', 'GITHUB_TOKEN'],
  ['OAuth secret vocabulary', 'client_secret'],
] as const) {
  check(`channel sources never touch ${label}`, !all.includes(needle))
}

const wf = readFileSync(join(ROOT, '.github', 'workflows', 'private-release.yml'), 'utf8')
check('workflow has no npm publish', !wf.includes('npm publish'))
check('workflow has no public-bucket upload', !wf.includes('storage.googleapis') && !wf.includes('aws s3'))
check('workflow marks every labelled tag prerelease', wf.includes("PRERELEASE='--prerelease'"))
check('workflow uses the repo-scoped github.token only', wf.includes('GH_TOKEN: ${{ github.token }}') && !wf.includes('PERSONAL_ACCESS_TOKEN'))
check('workflow release step targets gh release create (this repo)', wf.includes('gh release create'))

console.log('')
if (failures === 0) {
  console.log('PASS prove-never-public')
  process.exit(0)
}
console.log(`FAIL prove-never-public (${failures})`)
process.exit(1)

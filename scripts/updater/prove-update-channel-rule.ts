#!/usr/bin/env bun
import { CHECKSUM_MANIFEST_NAME, parsePrivateVersion, selectRelease, type ChannelRelease, type ReleaseSelection } from '../../src/services/privateChannel/channelCore.js'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

const rel = (tagName: string, flagged: boolean, over: Partial<ChannelRelease> = {}): ChannelRelease => ({
  tagName,
  isDraft: false,
  isPrerelease: flagged,
  assetNames: [
    `mercury-${tagName}-linux-x64.tar.gz`,
    `mercury-${tagName}-macos-arm64.tar.gz`,
    `mercury-${tagName}-windows-x64.zip`,
    CHECKSUM_MANIFEST_NAME,
  ],
  ...over,
})
const pick = (installed: string, releases: ChannelRelease[]): ReleaseSelection => selectRelease(releases, parsePrivateVersion(installed)!, 'linux', 'x64')
const words = (s: ReleaseSelection): string => JSON.stringify(s)
const offers = (s: ReleaseSelection, tag: string): boolean => s.state === 'update-available' && s.tag === tag

const FLAGGED = true
const FINAL = false
const channelOn20261029 = [rel('v1.0.0-beta.43', FLAGGED), rel('v1.0.0-beta.44', FLAGGED), rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FINAL)]

console.log('── §1 the road out of a release candidate (FRC2W-S-02: rc.1 refused the final v1.0.0) ──')
check('1.0.0-rc.1 updates to v1.0.0 published as a full release', offers(pick('1.0.0-rc.1', channelOn20261029), 'v1.0.0'), words(pick('1.0.0-rc.1', channelOn20261029)))
check('1.0.0-beta.44 updates to v1.0.0 as well', offers(pick('1.0.0-beta.44', channelOn20261029), 'v1.0.0'), words(pick('1.0.0-beta.44', channelOn20261029)))
check('1.0.0-rc.1 updates to v1.0.0 when the tag was flagged by hand too', offers(pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FLAGGED)]), 'v1.0.0'))
check('1.0.0-rc.1 updates to v1.0.0 with the older tags shuffled in the listing', offers(pick('1.0.0-rc.1', [...channelOn20261029].reverse()), 'v1.0.0'))

console.log('── §2 a pre-release install takes the newest release, whatever GitHub flags it ──')
check('1.0.0-rc.1 updates to v1.0.0-rc.2 published without the flag', offers(pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0-rc.2', FINAL)]), 'v1.0.0-rc.2'), words(pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0-rc.2', FINAL)])))
check('1.0.0-rc.1 updates to v1.0.0-rc.2 published with the flag', offers(pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0-rc.2', FLAGGED)]), 'v1.0.0-rc.2'))
check('1.0.0-rc.1 takes the newest of its channel when a later candidate follows the final', offers(pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED)]), 'v1.0.1-rc.1'))
check('1.0.0-beta.44 updates to v1.0.1 straight over the final and its candidate', offers(pick('1.0.0-beta.44', [rel('v1.0.0-beta.44', FLAGGED), rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED), rel('v1.0.1', FINAL)]), 'v1.0.1'))
check('a pre-release install on the newest tag is current', pick('1.0.1-rc.1', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED)]).state === 'current')

console.log('── §3 a full-release install moves only to the next full release ──')
check('1.0.0 updates to v1.0.1 published as a full release', offers(pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1', FINAL)]), 'v1.0.1'))
check('1.0.0 updates to v1.0.1 when that tag carries the pre-release flag for the older installs', offers(pick('1.0.0', [rel('v1.0.0', FLAGGED), rel('v1.0.1', FLAGGED)]), 'v1.0.1'), words(pick('1.0.0', [rel('v1.0.0', FLAGGED), rel('v1.0.1', FLAGGED)])))
check('1.0.0 updates to v1.1.0 over a v1.0.1', offers(pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1', FINAL), rel('v1.1.0', FINAL)]), 'v1.1.0'))
check('1.0.0 stays current when the only newer tag is a flagged candidate', pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED)]).state === 'current', words(pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED)])))
check('1.0.0 stays current when the only newer tag is an unflagged candidate', pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FINAL)]).state === 'current', words(pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FINAL)])))
check('1.0.0 stays current under a beta and a candidate of later versions', pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED), rel('v1.0.2-beta.1', FLAGGED)]).state === 'current')
check('1.0.0 takes v1.0.1 past its candidate', offers(pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FLAGGED), rel('v1.0.1', FINAL)]), 'v1.0.1'))
check('1.0.1 takes v1.0.2 past a v1.1.0-beta.1 that sorts above it', offers(pick('1.0.1', [rel('v1.0.1', FINAL), rel('v1.0.2', FINAL), rel('v1.1.0-beta.1', FLAGGED)]), 'v1.0.2'))
check('a full-release install on the newest full release is current', pick('1.0.1', [rel('v1.0.0', FINAL), rel('v1.0.1', FINAL)]).state === 'current')

console.log('── §4 what the flag never does, and what still refuses ──')
{
  const lists: Array<[string, ChannelRelease[]]> = [
    ['1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FINAL)]],
    ['1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0-rc.2', FINAL)]],
    ['1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1', FLAGGED)]],
    ['1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1-rc.1', FINAL)]],
  ]
  const results = lists.map(([installed, list]) => pick(installed, list))
  check('no selection is refused for the pre-release flag or its absence', results.every(s => s.state !== 'malformed-release' && !JSON.stringify(s).toLowerCase().includes('prerelease')), results.map(words).join(' | '))
}
check('a draft is never selected on either channel', pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1', FINAL, { isDraft: true })]).state === 'current' && pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FINAL, { isDraft: true })]).state === 'current')
check('an empty listing is no-releases', pick('1.0.0', []).state === 'no-releases')
{
  const s = pick('1.0.0', [rel('v1.0.0', FINAL), rel('v1.0.1', FINAL, { assetNames: [CHECKSUM_MANIFEST_NAME] })])
  check('a full release without this platform\'s archive is still refused by name', s.state === 'malformed-release' && s.note.includes('linux-x64'), words(s))
}
{
  const s = pick('1.0.0-rc.1', [rel('v1.0.0-rc.1', FLAGGED), rel('v1.0.0', FINAL, { assetNames: ['mercury-v1.0.0-linux-x64.tar.gz'] })])
  check(`a full release without ${CHECKSUM_MANIFEST_NAME} is still refused for a pre-release install`, s.state === 'malformed-release' && s.note.includes(CHECKSUM_MANIFEST_NAME), words(s))
}
check('an unsupported platform is still its own state', selectRelease([rel('v1.0.1', FINAL)], parsePrivateVersion('1.0.0')!, 'linux', 'riscv64').state === 'unsupported-platform')

console.log('')
if (failures === 0) {
  console.log('PASS prove-update-channel-rule')
  process.exit(0)
}
console.log(`FAIL prove-update-channel-rule (${failures})`)
process.exit(1)

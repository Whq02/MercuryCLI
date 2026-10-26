import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { proofHome, installFixture, root, serverPath } from './fixture.ts'
import { computeActiveSet, publishActiveSet } from '../../src/extensions/active.js'
import { clearExtensionMcpServerCache, getExtensionMcpServers } from '../../src/extensions/load/servers.js'
import { noteWords } from '../../src/components/extensions/rowWords.js'
import { readSwitch, setSwitch } from '../../src/extensions/install.js'
import { updateSettingsForSource } from '../../src/utils/settings/settings.js'
import { MEDIA_EXTENSION_ID, MEDIA_SERVER_NAME, mediaHealth } from '../../src/services/media/settings.js'

try {
  const read = () => { const set = computeActiveSet({ cwd: proofHome, sessionPaths: [] }); publishActiveSet(set); clearExtensionMcpServerCache(); return set }
  let set = read()
  const rows = set.roster.entries.filter(row => row.id === MEDIA_EXTENSION_ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.switchedOn, false)
  assert.match(noteWords(rows[0]!, null), /\/config.*on/)
  assert.equal(set.active.some(row => row.entry.id === MEDIA_EXTENSION_ID), false)
  assert.equal(getExtensionMcpServers()[MEDIA_SERVER_NAME], undefined)
  assert.equal(mediaHealth().status, 'off')
  installFixture()
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath } }).error, null)
  assert.equal(setSwitch(MEDIA_EXTENSION_ID, true).ok, true)
  assert.equal(readSwitch(MEDIA_EXTENSION_ID).on, true)
  set = read()
  assert.equal(set.roster.entries.filter(row => row.id === MEDIA_EXTENSION_ID).length, 1)
  const server = getExtensionMcpServers()[MEDIA_SERVER_NAME]
  assert.ok(server && server.type === 'stdio')
  assert.equal(server.command, process.execPath)
  assert.deepEqual(server.args, [serverPath])
  assert.equal(server.env?.MEDIA_ROOT, root)
  assert.equal(setSwitch(MEDIA_EXTENSION_ID, false).ok, true)
  read()
  assert.equal(getExtensionMcpServers()[MEDIA_SERVER_NAME], undefined)
  console.log('media off-by-default: one off row; no server; enabled and disabled through the shared setting')
} finally { rmSync(proofHome, { recursive: true, force: true }) }

import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsSchema } from '../../src/utils/settings/types.js'
import { updateSettingsForSource } from '../../src/utils/settings/settings.js'
import { mediaConfigModule, mediaEnvironment, mediaHealth, mediaRoot, readMediaSettings, saveMediaSettings } from '../../src/services/media/settings.js'
import { proofHome, root, serverPath, installFixture } from './fixture.ts'

try {
  installFixture()
  assert.ok(SettingsSchema().safeParse({ media: { enabled: false, root, imageModel: 'image-one', videoModel: 'video-one', serverPath } }).success)
  for (const media of [{ enabled: 'yes' }, { root: '' }, { imageModel: 1 }, { videoModel: '' }, { serverPath: 123 }]) assert.equal(SettingsSchema().safeParse({ media }).success, false)
  assert.equal(updateSettingsForSource('userSettings', { media: { root, serverPath } }).error, null)
  const reader = await mediaConfigModule()
  await reader.writeMediaConfig(root, { outputs: join(root, 'outputs'), nice: 7, jobCap: 3, ports: { image: 0, video: 0 } })
  await saveMediaSettings({ enabled: true, imageModel: 'image-two', videoModel: 'video-one' })
  assert.equal(readMediaSettings().enabled, true)
  assert.equal(mediaRoot(), root)
  const config = await reader.readMediaConfig(root)
  assert.equal(config.imageModel, 'image-two')
  assert.equal(config.videoModel, 'video-one')
  assert.equal(config.nice, 7)
  assert.equal(config.jobCap, 3)
  assert.equal(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).outputs, join(root, 'outputs'))
  assert.deepEqual(mediaEnvironment(), { MEDIA_ROOT: root })
  await assert.rejects(saveMediaSettings({ imageModel: 'video-one' }), /image model/)
  assert.equal((await reader.readMediaConfig(root)).imageModel, 'image-two')
  assert.equal(mediaHealth().evidence, 'Media runtime missing · /imagesetup')
  const binary = join(root, 'sd-server')
  writeFileSync(binary, '')
  writeFileSync(join(root, 'runtime.json'), JSON.stringify({ binary }))
  assert.equal(mediaHealth().status, 'ok')
  assert.equal(mediaHealth({ enabled: true, root: join(root, 'absent') }).evidence, 'Media folder missing · /imagesetup')
  assert.throws(() => mediaRoot({ root: '../elsewhere' }), /absolute/)
  assert.match(mediaHealth({ root, imageModel: 'misplaced' }).evidence, /config\.json/)
  assert.equal(readMediaSettings().imageModel, undefined)
  assert.equal(readMediaSettings().videoModel, undefined)
  console.log('media settings: typed keys; shared config reader; preserved engine keys; kind validation; health remedies')
} finally { rmSync(proofHome, { recursive: true, force: true }) }

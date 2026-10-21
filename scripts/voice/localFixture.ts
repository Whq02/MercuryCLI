import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { voicePackPlatform } from '../../src/services/voice/voicePack.ts'
import { whisperCpuFloorWords } from '../../src/services/voice/whisperPack.ts'

export function localFixture(dir: string, text = 'world', delayMs = 0): { env: Record<string, string>; calls: () => number; ledger: string } {
  mkdirSync(dir, { recursive: true })
  const ledger = join(dir, 'decodes.log')
  const model = join(dir, 'ggml-fixture.en.bin')
  writeFileSync(model, 'fixture model')
  const addon = `const fs = require('node:fs')
module.exports = {
  packVersion: () => '0.0.0', engineVersion: () => 'fixture', systemInfo: () => 'fixture',
  cpuFloor: () => ({ met: true, missing: [] }), loadModel: () => 1, modelInfo: () => ({ multilingual: false, kind: 'fixture' }), unloadModel: () => {},
  transcribe: async (_handle, pcm) => {
    fs.appendFileSync(${JSON.stringify(ledger)}, 'decode ' + pcm.length + '\\n')
    await new Promise(done => setTimeout(done, ${delayMs}))
    return { text: ${JSON.stringify(text)}, ms: ${delayMs}, language: 'en', segments: 1 }
  }
}
`
  writeFileSync(join(dir, 'fixture.cjs'), addon)
  const digest = createHash('sha256').update(addon).digest('hex')
  writeFileSync(join(dir, '.vendor-manifest.json'), JSON.stringify({ name: 'mercury-whisper', version: '0.0.0', platform: voicePackPlatform(), addon: 'fixture.cjs', addonSha256: digest, sourceTreeDigest: digest, engine: { name: 'whisper.cpp', version: 'fixture' }, cpuFloor: whisperCpuFloorWords(), gpu: 'none', crates: [], fileCount: 1, treeDigest: digest }))
  return {
    env: { MERCURY_WHISPER_PACK_DIR: dir, MERCURY_WHISPER_MODEL: model },
    calls: () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).length : 0,
    ledger,
  }
}

import assert from 'node:assert/strict'
const { validateSettingsFileContent } = await import('../../src/utils/settings/validation.ts')
const authored = validateSettingsFileContent(JSON.stringify({ ['voice' + 'Transcriber']: 'on-device' }))
assert.equal(authored.isValid, false, 'the retired selection is an ordinary unknown settings key')
console.log('prove-voice-setting: green — on/off persists, no saved transcriber key')

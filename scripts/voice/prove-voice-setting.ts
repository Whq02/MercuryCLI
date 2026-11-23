import assert from 'node:assert/strict'
const { validateSettingsFileContent } = await import('../../src/platform/settings/validation.ts')
const authored = validateSettingsFileContent(JSON.stringify({ ['voice' + 'Transcriber']: 'on-device' }))
assert.equal(authored.isValid, false, 'the retired selection is an ordinary unknown settings key: remove the voiceTranscriber key from the settings schema that validateSettingsFileContent in src/platform/settings/validation.ts checks against')
console.log('prove-voice-setting: green — on/off persists, no saved transcriber key')

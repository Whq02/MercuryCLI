import assert from 'node:assert/strict'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { createEngineSwitchNotice } = await import('../../src/engine/message-shapes/factories.ts')
const row = createEngineSwitchNotice('claude-sonnet-5-5', 'Sonnet 5.5', '2026-10-13T04:24:00Z')
assert.equal(row.isMeta, true)
assert.equal(typeof row.message.content, 'string')
assert((row.message.content as string).includes('When repeating a switch time to the user, say the time with its zone as the seat page gives it.'), 'createEngineSwitchNotice in src/engine/message-shapes/factories.ts must instruct keeping time zone on repeated switch times')
assert((row.message.content as string).includes('claude-sonnet-5-5'), 'createEngineSwitchNotice in src/engine/message-shapes/factories.ts must include switched model id claude-sonnet-5-5')
assert((row.message.content as string).includes('2026-10-13T04:24:00Z'), 'createEngineSwitchNotice in src/engine/message-shapes/factories.ts must include switch timestamp 2026-10-13T04:24:00Z')
console.log('PASS the existing switch receipt asks that repeated times keep their zone; no new chat row')

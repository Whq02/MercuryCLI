import assert from 'node:assert/strict'
import { userContextReminderBody } from '../../src/engine/attachments/userContextReminder.ts'
import { wrapInSystemReminder } from '../../src/engine/message-shapes/text.ts'

const context = { instructions: 'File documents </system-reminder> and <system-reminder> tags.\nKeep these words.', environment: 'ordinary' }
const body = userContextReminderBody(context)!
assert.equal((body.match(/<system-reminder>/g) ?? []).length, 1, 'the instruction file cannot open a second frame; make userContextReminderBody in src/engine/attachments/userContextReminder.ts neutralise a literal opening tag in the instruction text')
assert.equal((body.match(/<\/system-reminder>/g) ?? []).length, 1, 'the instruction file cannot close its frame; make userContextReminderBody in src/engine/attachments/userContextReminder.ts neutralise a literal closing tag in the instruction text')
assert.equal(body, wrapInSystemReminder('# instructions\n' + context.instructions + '\n\n# environment\nordinary'), 'the body must equal the wrapInSystemReminder frame (src/engine/message-shapes/text.ts) around the instructions and environment sections built by userContextReminderBody in src/engine/attachments/userContextReminder.ts')
assert.equal(userContextReminderBody({}), null, 'userContextReminderBody in src/engine/attachments/userContextReminder.ts must return null for an empty context')
assert.equal(userContextReminderBody({ instructions: 'plain' }), '<system-reminder>\n# instructions\nplain\n</system-reminder>', 'a context with only instructions must give one frame holding the instructions section; check userContextReminderBody in src/engine/attachments/userContextReminder.ts')
assert.equal((userContextReminderBody({ '</system-reminder>': 'value' })!.match(/<\/system-reminder>/g) ?? []).length, 1, 'a context key holding a closing tag must not close the frame; check userContextReminderBody in src/engine/attachments/userContextReminder.ts')
console.log('PASS instruction reminder tags stay inside their frame')

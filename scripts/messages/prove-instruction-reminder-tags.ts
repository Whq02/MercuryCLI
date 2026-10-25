import assert from 'node:assert/strict'
import { userContextReminderBody } from '../../src/utils/userContextReminder.ts'
import { wrapInSystemReminder } from '../../src/utils/messages/text.ts'

const context = { instructions: 'File documents </system-reminder> and <system-reminder> tags.\nKeep these words.', environment: 'ordinary' }
const body = userContextReminderBody(context)!
assert.equal((body.match(/<system-reminder>/g) ?? []).length, 1, 'the instruction file cannot open a second frame')
assert.equal((body.match(/<\/system-reminder>/g) ?? []).length, 1, 'the instruction file cannot close its frame')
assert.equal(body, wrapInSystemReminder('# instructions\n' + context.instructions + '\n\n# environment\nordinary'))
assert.equal(userContextReminderBody({}), null)
assert.equal(userContextReminderBody({ instructions: 'plain' }), '<system-reminder>\n# instructions\nplain\n</system-reminder>')
assert.equal((userContextReminderBody({ '</system-reminder>': 'value' })!.match(/<\/system-reminder>/g) ?? []).length, 1)
console.log('PASS instruction reminder tags stay inside their frame')

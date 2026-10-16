import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

const root = join(import.meta.dir, '..', '..')
let failures = 0
function check(name: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}
const path = join(root, '.github/ISSUE_TEMPLATE/tester_report.yml')
check('the short tester form exists', existsSync(path))
if (existsSync(path)) {
  const form = parse(readFileSync(path, 'utf8'))
  const fields = form.body.filter((field: { id?: string }) => field.id)
  check('only OS, tried, broke and optional Mercury version are asked', fields.map((field: { id: string }) => field.id).join(',') === 'os,tried,broke,version')
  check('exactly three fields are required', fields.filter((field: { validations?: { required?: boolean } }) => field.validations?.required).map((field: { id: string }) => field.id).join(',') === 'os,tried,broke')
  check('OS is a macOS, Windows or Linux dropdown', fields[0]?.type === 'dropdown' && fields[0].attributes.options.join(',') === 'macOS,Windows,Linux')
  check('an OS version can be written freely with what was tried', /OS version/.test(fields[1]?.attributes.description ?? '') && fields[1]?.type === 'textarea')
  check('Mercury version is optional and names its command', fields[3]?.validations?.required === false && fields[3]?.attributes.description.includes('mercury --version'))
  check('no health dump is asked for', !fields.some((field: { id: string }) => field.id === 'health'))
}
const config = parse(readFileSync(join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8'))
const first = config.contact_links[0]
check('the first contact link opens the short form directly', first?.name === 'Tester report' && first?.url === 'https://github.com/Whq02/MercuryCLI/issues/new?template=tester_report.yml')
check('blank reports stay disabled', config.blank_issues_enabled === false)
const { ISSUE_FORMS, ISSUE_KINDS, composeIssueBody, promptedFields, issueFormUrl } = await import('../../src/commands/feedback/issueForms.ts')
check('the form picker puts the tester report first', ISSUE_KINDS[0] === 'tester')
const tester = ISSUE_FORMS.tester
check('the command form carries the same four field ids', tester?.fields.map(field => field.id).join(',') === 'os,tried,broke,version')
if (tester) {
  check('the two short prompts are tried and broke, and both require words', promptedFields(tester).map(field => field.id).join(',') === 'tried,broke' && tester.fields.find(field => field.id === 'broke')?.required === true)
  const values = { os: 'Linux', tried: 'Opened the picker', broke: 'Blank screen', version: 'Mercury test' }
  const body = composeIssueBody(tester, { values, recentErrors: [{ error: 'not part of the short form', timestamp: 'now' }] })
  check('the short body includes answers but no health or error dump', Object.values(values).every(value => body.includes(value)) && !body.includes('Recent errors') && !body.includes('health --json'))
  const url = new URL(issueFormUrl(tester, { slug: 'Whq02/MercuryCLI', title: '[tester] Picker', values }))
  check('the browser fallback selects the same template and OS option', url.searchParams.get('template') === 'tester_report.yml' && url.searchParams.get('os') === 'Linux')
}
const { call } = await import('../../src/commands/feedback/feedback.tsx')
const context = { abortController: new AbortController(), messages: [] } as never
const short = await call(() => {}, context, '--short My task', 'bug') as { props: { kind: string; initialDescription: string } }
check('/bug --short selects the short form and preserves the attempted task', short.props.kind === 'tester' && short.props.initialDescription === 'My task')
const ordinary = await call(() => {}, context, 'My task', 'bug') as { props: { kind: string } }
check('/bug still selects the full bug form', ordinary.props.kind === 'bug')
const { takeTesterDoor, sessionSawFailure, TESTER_DOOR_LINE } = await import('../../src/commands/feedback/testerDoor.ts')
check('after a session that saw a failure: one invitation per session, with a new session independent', takeTesterDoor('tester-proof-a', true) === TESTER_DOOR_LINE && takeTesterDoor('tester-proof-a', true) === null && takeTesterDoor('tester-proof-b', true) === TESTER_DOOR_LINE)
check('after a clean session the farewell carries no door (the pass: "nothing had broken")', takeTesterDoor('tester-proof-c', false) === null && takeTesterDoor('tester-proof-c', false) === null)
check('with no focused session the door is not shown', takeTesterDoor('tester-proof-d') === null)
const stamp = new Date().toISOString()
const row = (m: Record<string, unknown>) => ({ uuid: crypto.randomUUID(), timestamp: stamp, ...m }) as never
const prompt = row({ type: 'user', message: { role: 'user', content: 'run the tests' } })
const toolCall = (id: string) => row({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'pnpm vitest run' } }] } })
const result = (id: string, failed: boolean) => row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: failed ? 'pnpm: command not found' : '23 passed', ...(failed ? { is_error: true } : {}) }] } })
const answer = (text: string, error = false) => row({ type: 'assistant', message: { id: 'a', role: 'assistant', content: [{ type: 'text', text }] }, ...(error ? { isApiErrorMessage: true } : {}) })
check('a clean session (a prompt, a tool that worked, a reply) saw no failure', sessionSawFailure([prompt, toolCall('t1'), result('t1', false), answer('All 23 tests pass.')]) === false)
check('an empty session saw no failure', sessionSawFailure([]) === false)
check('a tool result that carried is_error is a failure (the resume card\'s own count)', sessionSawFailure([prompt, toolCall('t2'), result('t2', true), answer('pnpm is not installed.')]) === true)
check('a session whose last reply was an API error is a failure', sessionSawFailure([prompt, answer('The request failed', true)]) === true)
const { REJECT_MESSAGE, REJECT_MESSAGE_WITH_REASON_PREFIX, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import('../../src/utils/messages/rejectionText.ts')
const denied = (id: string, text: string) => row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `<tool_use_error>${text}</tool_use_error>`, is_error: true }] } })
check('a session in which the user only declined a permission card ("no") saw no failure: no door', sessionSawFailure([prompt, toolCall('t3'), denied('t3', REJECT_MESSAGE), answer('Understood, I will not run it.')]) === false)
check('a decline with a reason, a cancel before the run and an esc during the tool are not failures either', sessionSawFailure([prompt, toolCall('t4'), denied('t4', `${REJECT_MESSAGE_WITH_REASON_PREFIX}use the Test tool`), toolCall('t5'), denied('t5', CANCEL_MESSAGE), toolCall('t6'), row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't6', content: INTERRUPT_MESSAGE_FOR_TOOL_USE, is_error: true }] } }), answer('Stopped.')]) === false)
check('a declined call beside a tool that genuinely errored is still a failure: the door', sessionSawFailure([prompt, toolCall('t7'), denied('t7', REJECT_MESSAGE), toolCall('t8'), result('t8', true), answer('pnpm is not installed.')]) === true)
const readme = readFileSync(join(root, 'README.md'), 'utf8')
check('the installation docs describe counts honestly', /approximate script-request counts by source and UTC\s+day \(completed installs are not counted\); the counter stores no IP address, user-agent string\s+or cookie/.test(readme))
check('the README install line stays plain', readme.includes('curl -fsSL https://mercury-cli.ai/install | sh') && !readme.includes('https://mercury-cli.ai/install?src='))
check('the README links to the short form and command', readme.includes('[the tester form](https://mercury-cli.ai/report)') && readme.includes('/bug --short <what you tried>'))
console.log(`tester door: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

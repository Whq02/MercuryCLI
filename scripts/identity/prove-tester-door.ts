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
const { takeTesterDoor, TESTER_DOOR_LINE } = await import('../../src/commands/feedback/testerDoor.ts')
check('one invitation per session, with a new session independent', takeTesterDoor('tester-proof-a') === TESTER_DOOR_LINE && takeTesterDoor('tester-proof-a') === null && takeTesterDoor('tester-proof-b') === TESTER_DOOR_LINE)
const readme = readFileSync(join(root, 'README.md'), 'utf8')
check('the installation docs describe counts honestly', /approximate script-request counts by source and UTC\s+day \(completed installs are not counted\); the counter stores no IP address, user-agent string\s+or cookie/.test(readme))
check('the README install line stays plain', readme.includes('curl -fsSL https://mercury-cli.ai/install | sh') && !readme.includes('https://mercury-cli.ai/install?src='))
check('the README links to the short form and command', readme.includes('[the tester form](https://mercury-cli.ai/report)') && readme.includes('/bug --short <what you tried>'))
console.log(`tester door: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

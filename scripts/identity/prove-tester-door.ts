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
console.log(`tester door: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)

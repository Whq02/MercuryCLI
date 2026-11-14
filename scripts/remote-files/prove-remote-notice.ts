#!/usr/bin/env bun
import { underScratchHome } from './remoteKit.ts'

underScratchHome(import.meta.path)
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const notice = (await import('../../src/services/remoteFiles/notice.ts').catch(() => ({}))) as { remoteFilesNotice?: (input: string, messages?: unknown[]) => Array<{ type: string; content?: string }> }
const orchestrator = await Bun.file(new URL('../../src/utils/attachments/orchestrator.ts', import.meta.url)).text()

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const WORDS =
  "`ssh://host/path` is a file on another machine: Read, Edit, Write, Grep and Glob take it as a path. `host` is what `ssh host` accepts; `ssh://host/~/x` is under that account's home; Read of `ssh://` alone lists the hosts of the ssh configuration."
const ABSENT = ['<there is no such notice>', '<there is no such notice>']
const told = (input: string, messages: unknown[] = []): string[] => (notice.remoteFilesNotice === undefined ? ABSENT : notice.remoteFilesNotice(input, messages).map(row => `${row.type}: ${row.content}`))
const said = { type: 'attachment', attachment: { type: 'critical_system_reminder', content: WORDS } }
const boundary = { type: 'system', subtype: 'compact_boundary' }
const other = { type: 'attachment', attachment: { type: 'critical_system_reminder', content: '# Tool manual: Read' } }

check('a prompt that names a file on another machine carries the notice, in the ruled words, as a reminder the screen does not draw', JSON.stringify(told('look at ssh://web1/srv/app/config.yml and fix the port')) === JSON.stringify([`critical_system_reminder: ${WORDS}`]), told('look at ssh://web1/srv/app/config.yml').join(' | '))
check('ssh:// alone, a bare host, a host with an account and a port: each carries it', ['list ssh://', 'what is on ssh://web1', 'read ssh://deploy@web1:2222/~/notes.md'].every(input => told(input).length === 1), ['list ssh://', 'what is on ssh://web1'].map(input => told(input).length).join(' '))
check('a prompt with no such path carries nothing', [told('fix the port in config.yml'), told('ssh into web1 and look'), told('the scheme ssh: with one slash ssh:/web1/x'), told('')].every(rows => rows.length === 0), told('ssh into web1 and look').join(' | '))
check('a git remote is not a file on another machine: ssh://git@..., and a path that ends .git', [told('clone ssh://git@github.com/acme/app.git'), told('the remote is ssh://git@host/acme/app'), told('push to ssh://build.internal/srv/git/app.git.'), told('use ssh://host/repos/app.git')].every(rows => rows.length === 0), told('use ssh://host/repos/app.git').join(' | '))
check('a prompt that names both carries it', told('clone ssh://git@github.com/acme/app.git and read ssh://web1/etc/hosts').length === 1)
check('it is said once in a conversation', told('and ssh://web1/etc/hosts too', [said]).length === 0 && told('and ssh://web1/etc/hosts too', [other]).length === 1)
check('and again after the conversation was folded', told('and ssh://web1/etc/hosts too', [said, boundary]).length === 1 && told('and ssh://web1/etc/hosts too', [said, boundary, said]).length === 0)
check('the producer loads the notice only for a prompt that holds ssh://, on the road that carries the prompt\'s own attachments', /maybe\('remote_files', async \(\) => \(input\.includes\('ssh:\/\/'\) \? \(await import\('\.\.\/\.\.\/services\/remoteFiles\/notice\.js'\)\)\.remoteFilesNotice\(input, messages\) : \[\]\), \{ inputScoped: true \}\)/.test(orchestrator) && !/^import .*remoteFiles/m.test(orchestrator))

console.log(`\nremote notice: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)

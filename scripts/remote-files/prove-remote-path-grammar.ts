#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import ignore from 'ignore'
import { underScratchHome } from './remoteKit.ts'

underScratchHome(import.meta.path)
const {
  authorityText,
  formatRemotePath,
  isRemotePath,
  noteResolvedAuthority,
  parseRemotePath,
  remoteChild,
  remoteHostLabel,
  remoteRuleAuthority,
  remoteRuleCandidates,
  remoteRuleEndpointForms,
  remoteRulePattern,
  remoteSessionRule,
  RemotePathError,
} = await import('../../src/services/remoteFiles/target.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Row = { written: string; user?: string; host: string; port?: number; home: string | null; path: string; folder?: boolean; identity: string }

section('§1 the forms a path takes')
const forms: Row[] = [
  { written: 'ssh://web1/etc/nginx/nginx.conf', host: 'web1', home: null, path: '/etc/nginx/nginx.conf', identity: 'ssh://web1/etc/nginx/nginx.conf' },
  { written: 'SSH://web1/etc/hosts', host: 'web1', home: null, path: '/etc/hosts', identity: 'ssh://web1/etc/hosts' },
  { written: '  ssh://web1/etc/hosts', host: 'web1', home: null, path: '/etc/hosts', identity: 'ssh://web1/etc/hosts' },
  { written: 'ssh://deploy@10.0.0.5:2222/srv/app/', user: 'deploy', host: '10.0.0.5', port: 2222, home: null, path: '/srv/app', folder: true, identity: 'ssh://deploy@10.0.0.5:2222/srv/app' },
  { written: 'ssh://[2001:db8::7]/var/log/syslog', host: '2001:db8::7', home: null, path: '/var/log/syslog', identity: 'ssh://[2001:db8::7]/var/log/syslog' },
  { written: 'ssh://root@[::1]:2200/x', user: 'root', host: '::1', port: 2200, home: null, path: '/x', identity: 'ssh://root@[::1]:2200/x' },
  { written: 'ssh://::1/x', host: '::1', home: null, path: '/x', identity: 'ssh://[::1]/x' },
  { written: 'ssh://web1/', host: 'web1', home: null, path: '/', identity: 'ssh://web1/' },
  { written: 'ssh://web1', host: 'web1', home: '', path: '', identity: 'ssh://web1/~' },
  { written: 'ssh://web1/~', host: 'web1', home: '', path: '', identity: 'ssh://web1/~' },
  { written: 'ssh://web1/~/', host: 'web1', home: '', path: '', folder: true, identity: 'ssh://web1/~' },
  { written: 'ssh://web1/~/notes/a.md', host: 'web1', home: '', path: 'notes/a.md', identity: 'ssh://web1/~/notes/a.md' },
  { written: 'ssh://web1/~bob/x', host: 'web1', home: 'bob', path: 'x', identity: 'ssh://web1/~bob/x' },
  { written: 'ssh://web1/%7E/x', host: 'web1', home: null, path: '/~/x', identity: 'ssh://web1/%7E/x' },
  { written: 'ssh://web1/~odd name/x', host: 'web1', home: null, path: '/~odd name/x', identity: 'ssh://web1/%7Eodd name/x' },
  { written: 'ssh://web1/a%20b/c%25d', host: 'web1', home: null, path: '/a b/c%d', identity: 'ssh://web1/a b/c%25d' },
  { written: 'ssh://web1/my file "q" $(id) `x` ?a=1#frag', host: 'web1', home: null, path: '/my file "q" $(id) `x` ?a=1#frag', identity: 'ssh://web1/my file "q" $(id) `x` ?a=1#frag' },
  { written: 'ssh://web1/a%3Ab%3Fc%23d', host: 'web1', home: null, path: '/a:b?c#d', identity: 'ssh://web1/a:b?c#d' },
  { written: 'ssh://web1/a%0Ab', host: 'web1', home: null, path: '/a\nb', identity: 'ssh://web1/a%0Ab' },
  { written: 'ssh://web1/a//b/./c/../d', host: 'web1', home: null, path: '/a/b/c/../d', identity: 'ssh://web1/a/b/c/../d' },
  { written: 'ssh://web1/100%/x%zz', host: 'web1', home: null, path: '/100%/x%zz', identity: 'ssh://web1/100%25/x%25zz' },
  { written: 'ssh://web1/tail%20', host: 'web1', home: null, path: '/tail ', identity: 'ssh://web1/tail%20' },
  { written: 'ssh://web1/caf%C3%A9', host: 'web1', home: null, path: '/café', identity: 'ssh://web1/café' },
  { written: 'ssh://user%40corp@host/x', user: 'user@corp', host: 'host', home: null, path: '/x', identity: 'ssh://user%40corp@host/x' },
  { written: 'ssh://web1/etc/hosts:12-40', host: 'web1', home: null, path: '/etc/hosts:12-40', identity: 'ssh://web1/etc/hosts:12-40' },
]
for (const row of forms) {
  let said = ''
  let ok = false
  try {
    const target = parseRemotePath(row.written)
    said = JSON.stringify(target)
    ok =
      target !== null &&
      target.authority.host === row.host &&
      target.authority.user === row.user &&
      target.authority.port === row.port &&
      target.home === row.home &&
      target.path === row.path &&
      target.folder === (row.folder ?? false) &&
      formatRemotePath(target) === row.identity
    if (target !== null && formatRemotePath(target) !== row.identity) said += ` identity ${formatRemotePath(target)}`
  } catch (error) {
    said = String(error)
  }
  check(`${JSON.stringify(row.written)} is ${row.identity}`, ok, said)
}

section('§2 an identity read again is itself')
for (const row of forms) {
  const again = parseRemotePath(row.identity)
  const first = parseRemotePath(row.written)
  check(
    `${row.identity} round-trips`,
    again !== null && first !== null && formatRemotePath(again) === row.identity && again.path === first.path && again.home === first.home && authorityText(again.authority) === authorityText(first.authority),
    JSON.stringify(again),
  )
}

section('§3 the host list, and what is not a remote path')
check('ssh:// alone is the host list', parseRemotePath('ssh://') === null && parseRemotePath('ssh:///') === null)
for (const local of ['/etc/hosts', 'ssh:/web1/x', 'sshx://web1/x', 'https://web1/x', 'mercury://seat', 'C:\\ssh://x', '']) {
  check(`${JSON.stringify(local)} is not a remote path`, !isRemotePath(local))
}
check('a value that is not a string is not a remote path', !isRemotePath(undefined) && !isRemotePath(7))

section('§4 a malformed path says what is wrong and names no file')
const refusals: Array<[string, RegExp]> = [
  ['ssh:///etc/hosts', /names no host: write ssh:\/\/<host>\/etc\/hosts\.$/],
  ['ssh://@web1/x', /names no user before the @\.$/],
  ['ssh://web1:0/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:99999/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:22x/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://-oProxyCommand=id/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://-l@web1/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://%2DoProxyCommand=id/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://we b1/x', /names no host\.$/],
  ['ssh://x%40prod/etc/shadow', /names no host\.$/],
  ['ssh://deploy@x%40prod:2222/~/x', /names no host\.$/],
  ['ssh://./x', /names no host\.$/],
  ['ssh://../etc/hosts', /names no host\.$/],
  ['ssh://.web1/x', /names no host\.$/],
  ['ssh://web1/a%00b', /holds a null byte\.$/],
  ['ssh://web1/%FF%FE', /holds an escape that is not UTF-8 text\.$/],
]
for (const [written, words] of refusals) {
  let said = 'parsed'
  let typed = false
  try {
    said = `parsed ${JSON.stringify(parseRemotePath(written))}`
  } catch (error) {
    typed = error instanceof RemotePathError
    said = error instanceof Error ? error.message : String(error)
  }
  check(`${JSON.stringify(written)}: ${words.source}`, typed && words.test(said) && said.startsWith(written), said)
}

section('§4a a password in a path is never repeated')
{
  const words = ' was written with a password; ssh signs in with your keys and agent, so leave it out.'
  const said = (written: string): string => {
    try {
      return `parsed ${JSON.stringify(parseRemotePath(written))}`
    } catch (error) {
      return error instanceof RemotePathError ? error.message : `threw ${String(error)}`
    }
  }
  for (const [written, named] of [
    ['ssh://user:S3CR3T@web1/x', 'ssh://user@web1/x'],
    ['ssh://user:S3@CR3T@web1:2222/~/x', 'ssh://user@web1:2222/~/x'],
    ['ssh://:S3CR3T@web1/x', 'ssh://@web1/x'],
    ['ssh://user:S3CR3T@web1', 'ssh://user@web1'],
    ['ssh://user:S3C/R3T@web1/x', 'ssh://user@web1/x'],
    ['ssh://user:12345@web1/x', 'ssh://user@web1/x'],
  ] as Array<[string, string]>) {
    check(`${written.replace(/S3.*R3T/, '…')} is answered as ${named}`, said(written) === `${named}${words}`, said(written).replace(/S3\S*R3T/g, '<the password>'))
  }
  const leaky = [
    'ssh://user:S3CR3T@web1/x',
    'ssh://-o:S3CR3T@web1/x',
    'ssh://a;b:S3CR3T@web1/x',
    'ssh://user:S3CR3T@/x',
    'ssh://user:S3CR3T@.web1/x',
    'ssh://user:S3CR3T@web1:99999/x',
    'ssh://user:S3CR3T@web1/a%00b',
    'ssh://user:S3CR3T@web1/%FF',
    'ssh://us%FFer:S3CR3T@web1/x',
    'ssh://user:S3%FFCR3T@web1/x',
    'ssh://user:S3CR3T@we b1/x',
    'ssh://user:S3C/R3T@web1/x',
    'ssh://user:S3C/R3T@we;b1/x',
    'SSH://User:S3CR3T@Web1/x',
  ]
  const told = leaky.map(written => [said(written), JSON.stringify(remoteRuleCandidates(written, 'deny')), String(remoteHostLabel(written)), String(remoteSessionRule(written)), String(remoteRuleAuthority(written))].join(' '))
  check('whatever else is wrong with such a path, nothing said about it or kept from it holds what stood after the colon', told.every(text => !/S3|R3T/.test(text)) && told.every(text => !text.startsWith('parsed')), told.find(text => /S3|R3T/.test(text) || text.startsWith('parsed'))?.replace(/S3\S*R3T/g, '<the password>'))
  check('a port and an @ further down the path are not a password', said('ssh://web1:22/home/a@b%00') === 'ssh://web1:22/home/a@b%00 holds a null byte.' && parseRemotePath('ssh://web1:22/home/a@b.txt')?.path === '/home/a@b.txt', said('ssh://web1:22/home/a@b%00'))
}

section('§4b a host or a user holding a character a shell acts on')
const shellWords = /has a character in its host or its user that a shell would act on\.$/
const refusedAs = (written: string): string => {
  try {
    return `parsed ${JSON.stringify(parseRemotePath(written))}`
  } catch (error) {
    return error instanceof RemotePathError ? error.message : `threw ${String(error)}`
  }
}
const escapeOf = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
for (const char of '\'`"$\\;&<>|(){},*?[]') {
  const said = [`ssh://a${char}b/x`, `ssh://a${escapeOf(char)}b/x`, `ssh://deploy@a${escapeOf(char)}b:2222/~/x`].map(refusedAs)
  check(`a host holding ${char}, written or escaped`, said.every(words => shellWords.test(words)), said.join(' | '))
}
for (const char of '\'`"$;&<>|(){}*?[]') {
  const said = [`ssh://a${char}b@web1/x`, `ssh://a${escapeOf(char)}b@web1/x`].map(refusedAs)
  check(`a user holding ${char}, written or escaped`, said.every(words => shellWords.test(words)), said.join(' | '))
}
check('a user with a dash after a space', shellWords.test(refusedAs('ssh://a%20-b@web1/x')) && shellWords.test(refusedAs('ssh://a -b@web1/x')), refusedAs('ssh://a%20-b@web1/x'))
check('a user ending in a backslash', shellWords.test(refusedAs('ssh://ab%5C@web1/x')) && shellWords.test(refusedAs('ssh://ab\\@web1/x')), refusedAs('ssh://ab%5C@web1/x'))
check('a command substitution in the host, in the user, and escaped', [`ssh://$(id)/x`, 'ssh://`id`/x', 'ssh://%24%28id%29/x', 'ssh://$(id)@web1/x', 'ssh://a;id@web1/x'].every(written => shellWords.test(refusedAs(written))), refusedAs('ssh://%24%28id%29/x'))
for (const [written, user, host] of [
  ['ssh://DOMAIN%5Cdeploy@web1/x', 'DOMAIN\\deploy', 'web1'],
  ['ssh://John%20Smith@web1/x', 'John Smith', 'web1'],
  ['ssh://first.last+tag@web-1.example.com:2222/x', 'first.last+tag', 'web-1.example.com'],
  ['ssh://a,b@web1/x', 'a,b', 'web1'],
  ['ssh://[fe80::1%25en0]/x', undefined, 'fe80::1%en0'],
  ['ssh://héllo_1/x', undefined, 'héllo_1'],
  ['ssh://a~b#c=d!e^f/x', undefined, 'a~b#c=d!e^f'],
] as Array<[string, string | undefined, string]>) {
  let parsed: ReturnType<typeof parseRemotePath> = null
  try {
    parsed = parseRemotePath(written)
  } catch {
    parsed = null
  }
  check(`${written} is still a destination`, parsed !== null && parsed.authority.host === host && parsed.authority.user === user, refusedAs(written))
}
check('a rule whose authority holds such a character names no host to ask the ssh configuration about', remoteRuleAuthority('ssh://a;b/**') === null && remoteRuleAuthority('ssh://$(id)/**') === null && remoteRuleAuthority('ssh://u`x`@web1/**') === null)
{
  const control = (char: string): boolean => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f
  const space = (char: string): boolean => ' \t\n\v\f\r'.includes(char)
  const stockHost = (name: string): boolean => !name.startsWith('-') && ![...name].some(char => '\'`"$\\;&<>|(){},'.includes(char) || space(char) || control(char))
  const stockUser = (name: string): boolean => !name.startsWith('-') && ![...name].some((char, at) => control(char) || '\'`";&<>|(){}$\\'.includes(char) || (space(char) && name[at + 1] === '-'))
  type Asked = { name: string; stock: boolean; args: string[]; written: string }
  const asked: Asked[] = []
  for (let code = 1; code < 0x80; code++) {
    const char = String.fromCharCode(code)
    const shown = code < 0x21 || code === 0x7f ? `0x${code.toString(16)}` : char
    asked.push(
      { name: `host ${shown}`, stock: !stockHost(`a${char}b`), args: ['--', `a${char}b`], written: `ssh://a${escapeOf(char)}b/x` },
      { name: `user ${shown}`, stock: !stockUser(`a${char}b`), args: ['-l', `a${char}b`, '--', 'web1'], written: `ssh://a${escapeOf(char)}b@web1/x` },
      { name: `user end ${shown}`, stock: !stockUser(`ab${char}`), args: ['-l', `ab${char}`, '--', 'web1'], written: `ssh://ab${escapeOf(char)}@web1/x` },
    )
  }
  asked.push(
    { name: 'ssh://a%20-b@web1/x', stock: !stockUser('a -b'), args: ['-l', 'a -b', '--', 'web1'], written: 'ssh://a%20-b@web1/x' },
    { name: 'ssh://%2Dx@web1/x', stock: !stockUser('-x'), args: ['-l', '-x', '--', 'web1'], written: 'ssh://%2Dx@web1/x' },
    { name: 'ssh://%2Dx/x', stock: !stockHost('-x'), args: ['--', '-x'], written: 'ssh://%2Dx/x' },
  )
  const LEFT_TO_SSH = 'user \\'
  const parsedHere = (row: Asked): boolean => refusedAs(row.written).startsWith('parsed')
  const byStock = asked.filter(row => row.stock)
  const looser = byStock.filter(parsedHere).map(row => row.name)
  check(`of the ${byStock.length} hosts and users OpenSSH 10.6 refuses for their characters (its two functions, asked of every ASCII character in each place), every one is refused here whatever ssh is installed, but one: a backslash inside a user, which is left to the installed ssh`, byStock.length === 143 && JSON.stringify(looser) === JSON.stringify([LEFT_TO_SSH]), looser.join(' · '))
  check('among them a dollar inside a user and at its end, and a backslash at its end', ['user $', 'user end $', 'user end \\'].every(name => byStock.some(row => row.name === name && !parsedHere(row))), byStock.filter(parsedHere).map(row => row.name).join(' · '))
  const version = /OpenSSH_(\d+)\.(\d+)/.exec(spawnSync('ssh', ['-V'], { encoding: 'utf8' }).stderr ?? '')
  const recent = version !== null && (Number(version[1]) > 9 || (Number(version[1]) === 9 && Number(version[2]) >= 6))
  if (!recent) {
    console.log(`  [SKIP] the installed ssh (${version === null ? 'none found' : version[0]}) does not check host and user characters itself (OpenSSH 9.6 and later do): its refusals were not compared`)
  } else {
    const sshRefuses = (args: string[]): boolean => {
      const ran = spawnSync('ssh', ['-F', '/dev/null', '-G', ...args], { encoding: 'utf8' })
      return ran.status !== 0 && /contains invalid characters/.test(ran.stderr ?? '')
    }
    const bySsh = asked.filter(row => sshRefuses(row.args))
    const left = bySsh.some(row => row.name === LEFT_TO_SSH)
    const missed = bySsh.filter(row => row.name !== LEFT_TO_SSH && parsedHere(row)).map(row => row.name)
    if (left) console.log(`  [NOTE] the installed ${version![0]} refuses a backslash inside a user (ssh -l 'a\\b' answers "remote username contains invalid characters", as OpenSSH 10.6 does) and Mercury leaves that one to ssh: a domain account written DOMAIN\\user is refused on this machine by ssh itself, when it connects`)
    check(`every host and user the installed ${version![0]} refuses for its characters is refused here (${bySsh.length - (left ? 1 : 0)} of them${left ? ', and the one left to ssh' : ''})`, bySsh.length > 40 && missed.length === 0, missed.join(' · '))
  }
}

section('§5 a child of a folder')
{
  const root = parseRemotePath('ssh://web1/')!
  const dir = parseRemotePath('ssh://web1/srv/app')!
  const home = parseRemotePath('ssh://web1/~')!
  const under = parseRemotePath('ssh://web1/~/notes')!
  check('under the root', formatRemotePath(remoteChild(root, 'etc')) === 'ssh://web1/etc')
  check('under a folder, with a nested name', formatRemotePath(remoteChild(dir, 'src/a b.ts')) === 'ssh://web1/srv/app/src/a b.ts')
  check('under the home', formatRemotePath(remoteChild(home, '.bashrc')) === 'ssh://web1/~/.bashrc')
  check('under a folder of the home', formatRemotePath(remoteChild(under, 'x.md')) === 'ssh://web1/~/notes/x.md')
  check('a name with a newline is spelled so that it reads back', parseRemotePath(formatRemotePath(remoteChild(dir, 'a\nb')))!.path === '/srv/app/a\nb')
}

section('§6 a rule beginning ssh:// and the forms a path is matched by')
const matches = (rule: string, path: string, behavior: 'allow' | 'deny' | 'ask' = 'deny'): boolean => {
  const candidates = remoteRuleCandidates(path, behavior) ?? []
  return [rule, ...remoteRuleEndpointForms(rule)].some(form => {
    const pattern = remoteRulePattern(form)
    if (pattern === null) return false
    const matcher = ignore().add(pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)
    return candidates.some(candidate => matcher.test(candidate).ignored)
  })
}
check('a local rule has no remote pattern', remoteRulePattern('//etc/**') === null && remoteRulePattern('src/**') === null && remoteRulePattern('~/x') === null)
check('a local path has no remote forms', remoteRuleCandidates('/etc/hosts', 'deny') === null)
check('a host rule covers a file on the host', matches('ssh://web1/**', 'ssh://web1/etc/hosts'))
check('a host rule written without a path covers the host', matches('ssh://web1', 'ssh://web1/etc/hosts'))
check('a host rule covers the root and the home', matches('ssh://web1/**', 'ssh://web1/') && matches('ssh://web1/**', 'ssh://web1/~/x') && matches('ssh://web1/**', 'ssh://web1'))
check('a host rule does not cover another host', !matches('ssh://web1/**', 'ssh://web2/etc/hosts'))
check('an escaped @ in the host, which ssh would read as a user and a host, has no forms at all for a rule to miss', (remoteRuleCandidates('ssh://x%40web1/etc/hosts', 'deny') ?? ['unparsed']).length === 0 && (remoteRuleCandidates('ssh://x%40web1/etc/hosts', 'allow') ?? ['unparsed']).length === 0)
check('a host rule does not cover a folder of that name on another host', !matches('ssh://web1/**', 'ssh://web2/srv/web1/x'))
check('a folder rule covers the folder and nothing beside it', matches('ssh://web1/srv/**', 'ssh://web1/srv/app/x') && !matches('ssh://web1/srv/**', 'ssh://web1/etc/x') && !matches('ssh://web1/srv/**', 'ssh://web1/srv2/x'))
check('a host-only rule covers every user and port', matches('ssh://web1/**', 'ssh://root@web1:2222/x'))
check('a rule with a user covers that user only', matches('ssh://deploy@web1/**', 'ssh://deploy@web1/x') && !matches('ssh://deploy@web1/**', 'ssh://root@web1/x') && !matches('ssh://deploy@web1/**', 'ssh://web1/x'))
check('a rule with a port covers that port only', matches('ssh://web1:2222/**', 'ssh://web1:2222/x') && !matches('ssh://web1:2222/**', 'ssh://web1:22/x') && !matches('ssh://web1:2222/**', 'ssh://web1/x'))
check('any host: ssh://*/**/.env', matches('ssh://*/**/.env', 'ssh://web1/app/.env') && matches('ssh://*/**/.env', 'ssh://web2/.env') && !matches('ssh://*/**/.env', 'ssh://web1/app/x.env'))
check('a host pattern with a wildcard', matches('ssh://web*/**', 'ssh://web7/x') && !matches('ssh://web*/**', 'ssh://db1/x'))
check('a host name differing only by case is another destination', !matches('ssh://web1/**', 'ssh://WEB1/x') && !matches('ssh://Web1/**', 'ssh://web1/x') && matches('ssh://Web1/**', 'ssh://Web1/x'))
check('an IPv6 host is a literal, not a character class', matches('ssh://[::1]/**', 'ssh://[::1]/x') && !matches('ssh://[::1]/**', 'ssh://:/x') && !matches('ssh://[::1]/**', 'ssh://1/x'))
check('a rule for the home spelling covers the home spelling', matches('ssh://web1/~/secrets/**', 'ssh://web1/~/secrets/k') && !matches('ssh://web1/~/secrets/**', 'ssh://web1/~/notes/k'))
check('a path with .. is denied by what it is written under and by where it lands', matches('ssh://web1/etc/**', 'ssh://web1/srv/../etc/shadow') && matches('ssh://web1/srv/**', 'ssh://web1/srv/../etc/shadow'))
check('a path with .. is allowed by no rule', !matches('ssh://web1/srv/**', 'ssh://web1/srv/app/../../etc/shadow', 'allow') && !matches('ssh://web1/**', 'ssh://web1/srv/../x', 'allow'))
check('a path without .. is allowed by its rule', matches('ssh://web1/srv/**', 'ssh://web1/srv/app/x', 'allow'))
check('a malformed remote path matches no rule', (remoteRuleCandidates('ssh:///etc/hosts', 'deny') ?? ['x']).length === 0 && (remoteRuleCandidates('ssh://', 'deny') ?? ['x']).length === 0)
check('every form a path is matched by is a relative path the matcher takes', ['ssh://web1/x', 'ssh://.hidden@web1/x', 'ssh://web1/.env', 'ssh://web1/', 'ssh://web1/~', 'ssh://[::1]:22/a/../b'].every(path => (remoteRuleCandidates(path, 'deny') ?? []).every(candidate => ignore.isPathValid(candidate))))

section('§7 a configuration name and its real host are one host')
{
  check('before the host is resolved the two spellings are two hosts', !matches('ssh://web1/**', 'ssh://10.0.0.5/x') && !matches('ssh://10.0.0.5/**', 'ssh://web1/x'))
  noteResolvedAuthority({ host: 'web1' }, { hostname: '10.0.0.5', user: 'deploy', port: 2222 })
  noteResolvedAuthority({ host: '10.0.0.5' }, { hostname: '10.0.0.5', user: 'me', port: 22 })
  check('a rule for the name covers the address', matches('ssh://web1/**', 'ssh://10.0.0.5/x'))
  check('a rule for the address covers the name', matches('ssh://10.0.0.5/etc/**', 'ssh://web1/etc/x') && !matches('ssh://10.0.0.5/etc/**', 'ssh://web1/srv/x'))
  check('the user the configuration gives is the user a rule can name', matches('ssh://deploy@web1/**', 'ssh://web1/x') && !matches('ssh://root@web1/**', 'ssh://web1/x'))
  check('the port the configuration gives is the port a rule can name', matches('ssh://web1:2222/**', 'ssh://web1/x') && !matches('ssh://web1:22/**', 'ssh://web1/x'))
  check('a written user or port overrides the configuration', matches('ssh://root@web1/**', 'ssh://root@web1/x') && !matches('ssh://deploy@web1/**', 'ssh://root@web1/x'))
  check('another host stays another host', !matches('ssh://web1/**', 'ssh://10.0.0.6/x'))
  noteResolvedAuthority({ host: 'WEB1' }, { hostname: 'web1' })
  check('a name that resolves to a host called like the configuration name is not that configuration name', !matches('ssh://web1/**', 'ssh://WEB1/x', 'allow'))
}

section('§8 what an ask offers')
check('the session rule of a path is its host', remoteSessionRule('ssh://web1/etc/hosts') === 'ssh://web1/**' && remoteSessionRule('ssh://deploy@web1:2222/~/x') === 'ssh://deploy@web1:2222/**')
check('the label names the host as written', remoteHostLabel('ssh://web1/etc/hosts') === 'web1' && remoteHostLabel('ssh://deploy@[::1]:2200/x') === 'deploy@[::1]:2200')
check('a local path offers neither', remoteSessionRule('/etc/hosts') === null && remoteHostLabel('/etc/hosts') === null && remoteSessionRule('ssh://') === null)
check('the authority of a rule is read when it names one host', remoteRuleAuthority('ssh://deploy@web1:2222/srv/**')?.host === 'web1' && remoteRuleAuthority('ssh://*/**') === null && remoteRuleAuthority('src/**') === null)
check('the session rule covers the path it was offered for', matches(remoteSessionRule('ssh://deploy@web1:2222/~/x')!, 'ssh://deploy@web1:2222/~/x', 'allow'))

console.log(`\nremote path grammar: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)

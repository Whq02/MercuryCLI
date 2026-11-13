#!/usr/bin/env bun
import ignore from 'ignore'
import {
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
} from '../../src/services/remoteFiles/target.ts'

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
  ['ssh://user:secret@web1/x', /carries a password; ssh signs in with your keys and agent, so leave it out\.$/],
  ['ssh://web1:0/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:99999/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://web1:22x/x', /has a port that is not a number from 1 to 65535\.$/],
  ['ssh://-oProxyCommand=id/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://-l@web1/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://%2DoProxyCommand=id/x', /begins a host or a user with a dash, which ssh would read as an option\.$/],
  ['ssh://we b1/x', /names no host\.$/],
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

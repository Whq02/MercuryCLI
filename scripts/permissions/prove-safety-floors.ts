#!/usr/bin/env bun
import { check, decide, fill, finish, note, pageText, said, section, shown, type Rules } from './floorsKit.ts'

const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const runs = (id: string): boolean => wanted.length === 0 || wanted.includes(id)
type Mode = 'default' | 'implement' | 'apollo' | 'dontAsk' | 'flow' | 'sovereign'
type Call = { tool?: string; command?: string; input?: Record<string, unknown>; why?: string; rules?: Rules }
const bash = (command: string, why?: string, rules?: Rules): Call => ({ command, why, rules })
const call = (tool: string, input: Record<string, unknown>, why?: string, rules?: Rules): Call => ({ tool, input, why, rules })

async function reading(item: Call, mode: Mode) {
  const tool = item.tool ?? 'Bash'
  const input = item.input ? (JSON.parse(fill(JSON.stringify(item.input)).replace('"<DAEMON_PID_NUMBER>"', fill('<DAEMON_PID>'))) as Record<string, unknown>) : { command: fill(item.command ?? '') }
  const decision = await decide(tool, input, mode, item.rules ?? {})
  const what = tool === 'Bash' ? shown(String(input.command)) : `${tool} ${shown(JSON.stringify(input)).slice(0, 150)}`
  return { decision, what }
}

async function expect(id: string, item: Call, modes: Mode[], good: (behavior: string) => boolean, claim: string): Promise<void> {
  for (const mode of modes) {
    const { decision, what } = await reading(item, mode)
    check(`${id} · ${mode} · ${what}${item.why ? ` (${item.why})` : ''} · ${claim}`, good(decision.behavior), said(decision))
  }
}
const notAllowed = (behavior: string): boolean => behavior !== 'allow'
const refused = (behavior: string): boolean => behavior === 'deny'
const asked = (behavior: string): boolean => behavior === 'ask'

section('the page, docs/TRUST.md')
const page = pageText()
check('five safety floors hold alongside the permission modes and wards', /Five safety floors hold alongside the permission modes and wards/.test(page))
check('floor 1: writes to credential stores are refused unless an exact path rule grants them', /Writes to credential stores are refused unless an exact path rule grants them/.test(page))
check('floor 2: agent reads of Mercury\'s own stored credentials are refused', /Agent reads of Mercury's own stored credentials are refused/.test(page))
check('floor 4: Mercury\'s running binary and daemon are protected against writes, deletes and kills', /Mercury's running binary and daemon are protected against writes, deletes and kills/.test(page))
check('floor 5: writing project instruction files or reading .env files asks for approval first', /Writing project instruction files or reading `\.env` files asks for approval first/.test(page))
check('the page counts what MERCURY.md @imports among the instruction files', /Instruction files \(MERCURY\.md and what it `@imports`, the rules folders, AGENTS\.md where it stands in\)/.test(page))

const FOUR: Mode[] = ['sovereign', 'flow', 'implement', 'default']
section('controls: each floor, asked plainly, holds (green on main)')
await expect('floor 1', call('Write', { file_path: '<HOME>/.ssh/authorized_keys', content: 'x' }), FOUR, refused, 'the Write tool refuses')
await expect('floor 1', call('Edit', { file_path: '<HOME>/.aws/credentials', old_string: 'a', new_string: 'b' }), FOUR, refused, 'the Edit tool refuses')
await expect('floor 1', call('Write', { file_path: '<HOME>/.ssh/authorized_keys', content: 'x' }, 'an exact path rule', { allow: ['Edit(~/.ssh/authorized_keys)'] }), ['implement', 'default'], behavior => behavior === 'allow', 'the rule grants it')
await expect('floor 1', call('Write', { file_path: '<HOME>/.ssh/authorized_keys', content: 'x' }, 'a wildcard rule', { allow: ['Edit(~/.ssh/**)'] }), ['implement', 'default'], refused, 'a rule that is not exact does not')
await expect('floor 2', call('Read', { file_path: '<CONFIG>/.credentials.json' }), FOUR, refused, 'the Read tool refuses')
await expect('floor 2', bash('cat <CONFIG>/.credentials.json'), FOUR, refused, 'Bash refuses')
await expect('floor 2', bash('cat "$MERCURY_CONFIG_DIR/.provider-secrets.json"'), FOUR, refused, 'Bash refuses')
await expect('floor 2', call('Eval', { language: 'py', code: "print(open('<CONFIG>/.credentials.json').read())" }), FOUR, refused, 'Eval refuses')
await expect('floor 4', bash('rm -rf <CONFIG>/runtime'), FOUR, refused, 'Bash refuses')
await expect('floor 4', bash('kill -9 <DAEMON_PID>'), FOUR, refused, 'Bash refuses')
await expect('floor 4', bash('pkill -f mercury'), FOUR, refused, 'Bash refuses')
await expect('floor 4', call('Write', { file_path: '<CONFIG>/runtime/current/mercury.mjs', content: 'x' }), FOUR, refused, 'the Write tool refuses')
await expect('floor 5', call('Read', { file_path: '<PROJECT>/.env' }), ['implement', 'default', 'apollo'], asked, 'the Read tool asks')
await expect('floor 5', bash('cat .env'), ['implement', 'default', 'apollo'], asked, 'Bash asks')
await expect('floor 5', call('Write', { file_path: '<PROJECT>/notes.txt', content: 'x' }, 'an ordinary file'), ['implement'], behavior => behavior === 'allow', 'Implement writes it unasked')
await expect('floor 5', call('Write', { file_path: '<PROJECT>/MERCURY.md', content: 'x' }), ['implement', 'default'], asked, 'the Write tool asks')
await expect('floor 5', bash('echo x >> AGENTS.md'), ['implement', 'default'], asked, 'Bash asks')

if (runs('T-3.3')) {
  section('T-3.3 floor 1 through Bash under Sovereign: the page says refused; the Bash layer answers with an ask, and Sovereign answers every ask')
  const writes: Call[] = [
    bash('echo x >> ~/.ssh/authorized_keys', 'the plainest spelling'),
    bash('cp notes.txt ~/.ssh/authorized_keys'),
    bash('mv notes.txt ~/.ssh/authorized_keys'),
    bash('rm ~/.ssh/authorized_keys', 'a delete'),
    bash('rm -rf ~/.ssh'),
    bash('chmod 777 ~/.ssh/id_ed25519'),
    bash("sed -i '' 's/a/b/' ~/.ssh/authorized_keys"),
    bash('echo x | tee -a ~/.ssh/authorized_keys'),
    bash('echo x > ~/.aws/credentials'),
    bash('echo x >> ~/.netrc'),
    bash('echo x >> ~/.npmrc'),
    bash('echo x >> ~/.git-credentials'),
    bash('echo x >> ~/.gnupg/gpg.conf'),
    bash('echo x >> ~/.kube/config'),
    bash('echo x >> ~/.docker/config.json'),
    bash('echo x >> ~/.config/gh/hosts.yml'),
    bash('echo x >> ~/Library/Keychains/login.keychain-db'),
    bash('echo x >> /etc/sudoers'),
    bash('echo x >> /etc/sudoers.d/x'),
    bash('echo x >> /etc/passwd'),
    bash("python3 -c \"open('<HOME>/.ssh/authorized_keys','a').write('x')\"", 'another language'),
    bash('bash -c "echo x >> ~/.ssh/authorized_keys"', 'an inline shell'),
    bash('ssh-keygen -f ~/.ssh/id_new -N ""', 'not read as a credential-store write in any mode'),
    bash('curl -o ~/.ssh/authorized_keys https://example.invalid/k', 'not read as one in any mode'),
    bash('tar -xf a.tar -C ~/.ssh', 'not read as one in any mode'),
    bash('git config --file ~/.ssh/config x.y z', 'not read as one in any mode'),
  ]
  for (const item of writes) await expect('T-3.3', item, ['sovereign'], notAllowed, 'is not approved')
}

if (runs('T-3.3b')) {
  section('T-3.3b floor 1 through Bash in the modes that ask: a card (or a hostless denial) where the page says refused, and where the Write tool does refuse')
  const writes: Call[] = [bash('echo x >> /Users/<USER>/.ssh/authorized_keys', 'a home outside every temp folder, so Flow reads it as outside the project'), bash('cp notes.txt /Users/<USER>/.ssh/authorized_keys'), bash('echo x > /Users/<USER>/.aws/credentials'), bash('echo x >> /etc/sudoers')]
  for (const item of writes) await expect('T-3.3b', item, ['default', 'implement', 'flow'], refused, 'is refused, as through the Write tool')
  await expect('T-3.3b', bash('echo x >> /Users/<USER>/.ssh/authorized_keys', 'a Bash allow rule', { allow: ['Bash(echo *)'] }), ['default'], notAllowed, 'a Bash rule does not approve it (holds)')
}

if (runs('T-3.3c')) {
  section('T-3.3c floor 1, "unless an exact path rule grants them": under Sovereign and Flow the rule does not grant (stricter than the page)')
  await expect('T-3.3c', call('Write', { file_path: '<HOME>/.ssh/authorized_keys', content: 'x' }, 'allow Edit(~/.ssh/authorized_keys)', { allow: ['Edit(~/.ssh/authorized_keys)'] }), ['sovereign', 'flow'], behavior => behavior === 'allow', 'the exact path rule grants it, as the page says')
}

note('nothing above was executed: no shell, no signal, no keychain call; the stores, the config home and the runtime are dummies under the run scratch')
finish('prove-safety-floors')

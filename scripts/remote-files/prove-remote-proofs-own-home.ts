#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { underScratchHome } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}

const here = import.meta.dir
const own = 'prove-remote-proofs-own-home.ts'
const proofs = readdirSync(here).filter(name => /^prove-.*\.ts$/.test(name) && name !== own).sort()
check('there are proofs to read', proofs.length >= 5, String(proofs.length))
for (const name of proofs) {
  const source = readFileSync(join(here, name), 'utf8')
  const taken = source.indexOf('underScratchHome(import.meta.path)')
  const firstLoad = source.search(/import\(\s*['"]\.\.\/\.\.\/src\//)
  const loadedAtOnce = /^import (?!type )[^\n]*from ['"]\.\.\/\.\.\/src\//m.test(source)
  check(
    `${name} takes a home of its own before it loads a line of the product`,
    taken !== -1 && !loadedAtOnce && (firstLoad === -1 || taken < firstLoad),
    taken === -1 ? 'it never asks for one' : loadedAtOnce ? 'it imports the product before any line of its own runs' : 'it loads the product first',
  )
}
const kit = readFileSync(join(here, 'remoteKit.ts'), 'utf8')
check('the kit gives the home to a child in its environment, where the runtime reads it', /env: \{ \.\.\.process\.env, HOME: home, USERPROFILE: home, REMOTE_KIT_HOME: home \}/.test(kit))
check('and refuses to go on where the runtime did not take it', /if \(homedir\(\) === given\) return given\n[^\n]*\[FAIL\][^\n]*\n\s*process\.exit\(1\)/.test(kit))
check('the private sshd uses its own keys and runs neither the account\'s ssh rc nor an authorized-keys command', kit.includes("'PermitUserRC no',") && kit.includes("'PermitUserEnvironment no',") && kit.includes("'AuthorizedKeysCommand none',") && kit.includes('`AuthorizedKeysFile ${authorized}`') && kit.includes("const authorized = join(keys, 'authorized_keys')") && kit.includes('`HostKey ${hostKey}`') && kit.includes("`PidFile ${join(scratch, 'sshd.pid')}`"))
const scratchRoot = tmpdir().replace(/[\\/]+$/, '')
check('this run: the home the runtime answers is the scratch folder it was given, under the temporary folder, and holds no .ssh', homedir() === HOME && HOME.includes(`${sep}remote-files-home-`) && (HOME.startsWith(scratchRoot + sep) || HOME.startsWith(`/private${scratchRoot}${sep}`)) && !existsSync(join(HOME, '.ssh')), `${homedir()} against ${HOME} under ${scratchRoot}`)

console.log(`\nremote proofs, a home of their own: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)

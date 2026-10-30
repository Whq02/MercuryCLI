import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
assert.ok(read('CONTRIBUTING.md').includes('This repository takes issues, not pull requests.'))
const install = read('docs/INSTALL.md')
for (const sentence of ["Release archives are signed. Run `mercury health` to inspect the installed release's signature.", 'An archive without a release signature is marked unsigned. Install and update refuse it unless you pass `--allow-unsigned`.', 'Intel Mac release archives are available.']) assert.ok(install.includes(sentence), sentence)
assert.ok(read('docs/TRUST.md').includes('## Release signatures'))
assert.doesNotMatch(read('docs/TRUST.md'), /1\.0\.0-beta\.[23]/)
const translated = readdirSync(resolve(root, 'docs/translations')).filter(file => /^README\..*\.md$/.test(file))
assert.equal(translated.length, 21)
for (const file of translated) {
  const text = read(`docs/translations/${file}`)
  assert.doesNotMatch(text, /1\.0\.0-beta\.[23]\b/, file)
  assert.ok(text.split('`--allow-unsigned`').length >= 3, file)
}
const login = read('src/components/BootLoginsScreen.tsx')
assert.ok(login.includes('Opening sign-in…'))
assert.ok(login.includes('Finishing sign-in…'))
assert.ok(login.includes('Finish signing in in the browser.'))
assert.doesNotMatch(login, /Requesting a device code|Authorized.*storing|Authorized.*minting|loopback listener completes|waiting\$\{d\.polls/)
assert.ok(read('src/services/providers/gemini/geminiAccounts.ts').includes('If Google shows invalid_client, press esc and correct the client ID here.'))
assert.ok(read('src/services/privateChannel/artifactVerify.ts').includes('Run `mercury update`, or download a signed release from github.com/Whq02/MercuryCLI/releases.'))
assert.doesNotMatch(read('src/services/privateChannel/channelCore.ts'), /not marked prerelease/)
const update = read('src/services/privateChannel/updateService.ts')
assert.doesNotMatch(update, /progress\('verifying',/)
assert.ok(update.includes('signatureRefusal(provenance.verdict, allowUnsigned)'))
assert.ok(update.includes("provenance.verdict.state === 'unsigned' && allowUnsigned"))
console.log('PASS current release text, all 21 installation translations, sign-in words and unchanged signature refusal gates')

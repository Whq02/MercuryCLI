#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LICENCE_DOCUMENTS = ['LICENSE.md', 'NOTICE', 'TRADEMARKS.md']
export const LICENCE_FILE = 'LICENSE.md'
const APACHE_BODY_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
const COPYRIGHT = 'Copyright 2026 Waleed Al Qusous, trading as Mercury CLI'
const NOTICE = `Mercury CLI\n${COPYRIGHT}\n`
const LICENCE_NOTICE = `
${COPYRIGHT}

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
`

export function readLicenceParameters(text) {
  const notice = text.endsWith(LICENCE_NOTICE)
  const body = notice ? text.slice(0, -LICENCE_NOTICE.length) : text
  return { bodySha256: createHash('sha256').update(body).digest('hex'), notice }
}

export function checkReleaseDocuments({ root, archiveDir = null }) {
  const findings = []
  for (const name of LICENCE_DOCUMENTS) {
    if (!existsSync(join(root, name))) findings.push(`${name} is missing from ${root}`)
  }
  let parameters = null
  const licencePath = join(root, LICENCE_FILE)
  if (existsSync(licencePath)) {
    parameters = readLicenceParameters(readFileSync(licencePath, 'utf8'))
    if (parameters.bodySha256 !== APACHE_BODY_SHA256) findings.push(`${LICENCE_FILE} is not the verbatim Apache License 2.0 text (SHA-256 ${APACHE_BODY_SHA256})`)
    if (!parameters.notice) findings.push(`${LICENCE_FILE} must end with the copyright notice and Apache License 2.0 boilerplate`)
  }
  if (existsSync(join(root, 'NOTICE')) && readFileSync(join(root, 'NOTICE'), 'utf8') !== NOTICE) {
    findings.push('NOTICE must name Mercury CLI and its copyright holder')
  }
  const trademarks = join(root, 'TRADEMARKS.md')
  if (existsSync(trademarks)) {
    const holes = readFileSync(trademarks, 'utf8').match(/\[[A-Z]{2,}[^\]\n]*\]/g) ?? []
    if (holes.length > 0) findings.push(`TRADEMARKS.md still carries a bracketed placeholder: ${holes.join(', ')}`)
  }
  if (archiveDir !== null) {
    for (const name of LICENCE_DOCUMENTS) {
      const shipped = join(archiveDir, name)
      const source = join(root, name)
      if (!existsSync(shipped)) findings.push(`the archive is missing ${name}`)
      else if (existsSync(source) && !readFileSync(shipped).equals(readFileSync(source))) findings.push(`the archive's ${name} differs from the tree's`)
    }
  }
  return { ok: findings.length === 0, findings, parameters }
}

function cliMain() {
  const [verb, ...args] = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (!['--root', '--archive'].includes(key) || !value || value.startsWith('--')) {
      console.error(`unknown input: ${args.slice(i).join(' ')}`)
      process.exit(2)
    }
    options[key] = value
  }
  if (verb !== 'check') {
    console.error('usage: node scripts/release/releaseDocuments.mjs check [--root <dir>] [--archive <payload dir>]')
    process.exit(2)
  }
  const root = resolve(options['--root'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  const archiveDir = options['--archive'] ? resolve(options['--archive']) : null
  const result = checkReleaseDocuments({ root, archiveDir })
  if (result.ok) {
    console.log(`Apache License 2.0 — ${LICENCE_FILE}; NOTICE; TRADEMARKS.md`)
    process.exit(0)
  }
  for (const finding of result.findings) console.error(finding)
  process.exit(1)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) cliMain()

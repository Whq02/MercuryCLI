#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LICENCE_DOCUMENTS = ['LICENSE.md', 'TRADEMARKS.md', 'MERCURY-COMMUNITY-PRODUCTION-TERMS.md']
export const LICENCE_FILE = 'LICENSE.md'
export const TERMS_FILE = 'MERCURY-COMMUNITY-PRODUCTION-TERMS.md'
export const CHANGE_DATE_YEARS = 3

const VERSION_LINE = /^- \*\*Version:\*\* `([^`\n]*)`/m
const RELEASE_LINE = /^- \*\*Version Release Date:\*\* (.+?) \(published at (\S+)\)/m
const CHANGE_LINE = /^- \*\*Change Date:\*\* (.+?) \(/m
const TERMS_LINE = /^- \*\*Companion Production Terms:\*\* `([^`\n]+)`([^\n]*?)terms version (\S+), SHA-256 `([^`\n]*)`/m
const TERMS_VERSION_LINE = /^- \*\*Terms Version:\*\* (\S+)/m
const RELEASE_TAG_URL = /\/releases\/tag\/([^\s)]+)$/
const PLACEHOLDER = /\[[A-Z]{2,}[^\]\n]*\]/g
const REVIEW_BANNER = /\bDRAFT\b/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function readLicenceParameters(text) {
  const version = VERSION_LINE.exec(text)
  const release = RELEASE_LINE.exec(text)
  const change = CHANGE_LINE.exec(text)
  const terms = TERMS_LINE.exec(text)
  const tag = release ? RELEASE_TAG_URL.exec(release[2]) : null
  return {
    version: version ? version[1] : null,
    releaseDate: release ? release[1] : null,
    releaseUrl: release ? release[2] : null,
    releaseTag: tag ? tag[1] : null,
    changeDate: change ? change[1] : null,
    termsFile: terms ? terms[1] : null,
    termsVersion: terms ? terms[3] : null,
    termsSha256: terms ? terms[4] : null,
    placeholders: [...text.matchAll(PLACEHOLDER)].map(m => m[0]),
    reviewBanner: REVIEW_BANNER.test(text),
  }
}

export function readTermsVersion(text) {
  const m = TERMS_VERSION_LINE.exec(text)
  return m ? m[1] : null
}

function parseIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null
  return t
}

const isoOf = t => new Date(t).toISOString().slice(0, 10)

export function expectedChangeDate(releaseDate) {
  const t = parseIsoDate(releaseDate)
  if (t === null) return null
  const d = new Date(t)
  const y = d.getUTCFullYear() + CHANGE_DATE_YEARS
  const m = d.getUTCMonth()
  const day = d.getUTCDate()
  const candidate = new Date(Date.UTC(y, m, day))
  if (candidate.getUTCMonth() !== m) return isoOf(Date.UTC(y, m + 1, 0))
  return isoOf(candidate.getTime())
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function checkReleaseDocuments({ root, version, today = todayIso(), archiveDir = null }) {
  const findings = []
  for (const name of LICENCE_DOCUMENTS) {
    if (!existsSync(join(root, name))) findings.push(`${name} is missing from ${root}`)
  }
  let parameters = null
  const licencePath = join(root, LICENCE_FILE)
  if (existsSync(licencePath)) {
    const licence = readFileSync(licencePath, 'utf8')
    parameters = readLicenceParameters(licence)
    if (parameters.reviewBanner) findings.push(`${LICENCE_FILE} still carries the review banner (the word DRAFT)`)
    if (parameters.placeholders.length > 0) {
      findings.push(`${LICENCE_FILE} still carries a bracketed placeholder: ${parameters.placeholders.join(', ')}`)
    }
    const wantTag = `v${version}`
    if (parameters.version === null) findings.push(`${LICENCE_FILE} has no Version parameter line`)
    else if (parameters.version !== wantTag) findings.push(`${LICENCE_FILE} names version ${parameters.version}; this release is ${wantTag}`)
    if (parameters.releaseDate === null) findings.push(`${LICENCE_FILE} has no Version Release Date line`)
    else {
      const t = parseIsoDate(parameters.releaseDate)
      if (t === null) findings.push(`${LICENCE_FILE} release date ${parameters.releaseDate} is not a calendar date (YYYY-MM-DD)`)
      else if (parseIsoDate(today) !== null && t > parseIsoDate(today)) findings.push(`${LICENCE_FILE} release date ${parameters.releaseDate} is after today (${today})`)
      if (parameters.releaseTag !== wantTag) findings.push(`${LICENCE_FILE} release URL names ${parameters.releaseTag ?? 'no tag'}; this release is ${wantTag}`)
    }
    if (parameters.changeDate === null) findings.push(`${LICENCE_FILE} has no Change Date line`)
    else if (parameters.releaseDate !== null) {
      const want = expectedChangeDate(parameters.releaseDate)
      if (want !== null && parameters.changeDate !== want) {
        findings.push(`${LICENCE_FILE} change date ${parameters.changeDate} is not ${CHANGE_DATE_YEARS} years after the release date (${want})`)
      }
    }
    if (parameters.termsFile === null) findings.push(`${LICENCE_FILE} has no Companion Production Terms line`)
    else {
      if (parameters.termsFile !== TERMS_FILE) findings.push(`${LICENCE_FILE} names companion terms ${parameters.termsFile}; the shipped file is ${TERMS_FILE}`)
      const termsPath = join(root, TERMS_FILE)
      if (existsSync(termsPath)) {
        const termsBytes = readFileSync(termsPath)
        const actual = sha256(termsBytes)
        if (parameters.termsSha256 !== actual) {
          findings.push(`${LICENCE_FILE} states terms SHA-256 ${parameters.termsSha256}; ${TERMS_FILE} hashes to ${actual}`)
        }
        const termsVersion = readTermsVersion(termsBytes.toString('utf8'))
        if (termsVersion === null) findings.push(`${TERMS_FILE} has no Terms Version line`)
        else if (termsVersion !== parameters.termsVersion) {
          findings.push(`${LICENCE_FILE} names terms version ${parameters.termsVersion}; ${TERMS_FILE} says ${termsVersion}`)
        }
      }
    }
  }
  for (const name of [TERMS_FILE, 'TRADEMARKS.md']) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    const holes = [...text.matchAll(PLACEHOLDER)].map(m => m[0])
    if (holes.length > 0) findings.push(`${name} still carries a bracketed placeholder: ${holes.join(', ')}`)
  }
  if (archiveDir !== null) {
    for (const name of LICENCE_DOCUMENTS) {
      const shipped = join(archiveDir, name)
      const source = join(root, name)
      if (!existsSync(shipped)) {
        findings.push(`the archive is missing ${name}`)
        continue
      }
      if (existsSync(source) && !readFileSync(shipped).equals(readFileSync(source))) {
        findings.push(`the archive's ${name} differs from the tree's`)
      }
    }
    if (existsSync(join(archiveDir, LICENCE_FILE)) && existsSync(join(archiveDir, TERMS_FILE))) {
      const shippedParameters = readLicenceParameters(readFileSync(join(archiveDir, LICENCE_FILE), 'utf8'))
      const shippedTermsHash = sha256(readFileSync(join(archiveDir, TERMS_FILE)))
      if (shippedParameters.termsSha256 !== shippedTermsHash) {
        findings.push(`the archive's ${LICENCE_FILE} states terms SHA-256 ${shippedParameters.termsSha256}; its ${TERMS_FILE} hashes to ${shippedTermsHash}`)
      }
    }
  }
  return { ok: findings.length === 0, findings, parameters }
}

export function stampLicence(licence, { version, releaseDate, termsBytes }) {
  if (parseIsoDate(releaseDate) === null) throw new Error(`stamp: the release date must be a calendar date (YYYY-MM-DD), not ${releaseDate}`)
  const tag = `v${version}`
  const changeDate = expectedChangeDate(releaseDate)
  const termsVersion = readTermsVersion(termsBytes.toString('utf8'))
  if (termsVersion === null) throw new Error(`stamp: ${TERMS_FILE} has no Terms Version line`)
  const need = (re, what) => {
    if (!re.test(licence)) throw new Error(`stamp: ${LICENCE_FILE} has no ${what} line to fill`)
  }
  need(VERSION_LINE, 'Version')
  need(RELEASE_LINE, 'Version Release Date')
  need(CHANGE_LINE, 'Change Date')
  need(TERMS_LINE, 'Companion Production Terms')
  return licence
    .replace(VERSION_LINE, m => m.replace(/`[^`\n]*`/, `\`${tag}\``))
    .replace(RELEASE_LINE, (m, date, url) => m.replace(date, releaseDate).replace(url, url.replace(RELEASE_TAG_URL, `/releases/tag/${tag}`)))
    .replace(CHANGE_LINE, (m, date) => m.replace(date, changeDate))
    .replace(TERMS_LINE, (m, file, between, tv, hash) => `- **Companion Production Terms:** \`${TERMS_FILE}\`${between}terms version ${termsVersion}, SHA-256 \`${sha256(termsBytes)}\``)
}

function cliMain() {
  const args = process.argv.slice(2)
  const verb = args[0]
  const opt = name => {
    const i = args.indexOf(name)
    return i !== -1 && args[i + 1] ? args[i + 1] : null
  }
  const root = resolve(opt('--root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'))
  const version = opt('--version') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (verb === 'check') {
    const archiveDir = opt('--archive')
    const result = checkReleaseDocuments({ root, version, archiveDir: archiveDir ? resolve(archiveDir) : null })
    if (result.ok) {
      const p = result.parameters
      console.log(`release documents: ${LICENCE_FILE} names ${p.version}, released ${p.releaseDate}, change date ${p.changeDate}, terms version ${p.termsVersion} (hash matches)${archiveDir ? '; the archive carries all three documents verbatim' : ''}`)
      process.exit(0)
    }
    for (const f of result.findings) console.error(`✗ ${f}`)
    console.error(`release documents: ${result.findings.length} finding(s) — fix ${LICENCE_FILE} (node scripts/release/releaseDocuments.mjs stamp fills the version, the dates and the terms hash)`)
    process.exit(1)
  }
  if (verb === 'stamp') {
    const releaseDate = opt('--date') ?? todayIso()
    const licencePath = join(root, LICENCE_FILE)
    const before = readFileSync(licencePath, 'utf8')
    const after = stampLicence(before, { version, releaseDate, termsBytes: readFileSync(join(root, TERMS_FILE)) })
    if (after === before) {
      console.log(`${LICENCE_FILE} already names v${version} released ${releaseDate} — nothing to change`)
      process.exit(0)
    }
    writeFileSync(licencePath, after)
    const p = readLicenceParameters(after)
    console.log(`${LICENCE_FILE} stamped: ${p.version}, released ${p.releaseDate}, change date ${p.changeDate}, terms version ${p.termsVersion}, terms SHA-256 ${p.termsSha256}`)
    process.exit(0)
  }
  console.error('usage: node scripts/release/releaseDocuments.mjs check [--version <v>] [--root <dir>] [--archive <payload dir>]\n       node scripts/release/releaseDocuments.mjs stamp [--version <v>] [--date YYYY-MM-DD] [--root <dir>]')
  process.exit(2)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) cliMain()

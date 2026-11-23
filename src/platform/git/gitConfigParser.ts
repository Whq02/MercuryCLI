import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isENOENT } from '../errors/errors.js'


function matchesSectionHeader(line: string, section: string, subsection: string | null): boolean {
  let index = 1
  let name = ''
  while (index < line.length) {
    const char = line[index] as string
    if (char === ']' || char === '"' || char === ' ' || char === '\t') break
    name += char
    index++
  }
  if (name.toLowerCase() !== section.toLowerCase()) return false

  if (subsection === null) {
    return line[index] === ']'
  }

  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index++
  if (line[index] !== '"') return false
  index++
  let parsed = ''
  while (index < line.length) {
    const char = line[index] as string
    if (char === '\\') {
      const next = line[index + 1]
      if (next === undefined) return false
      parsed += next
      index += 2
      continue
    }
    if (char === '"') break
    parsed += char
    index++
  }
  if (line[index] !== '"') return false
  if (line[index + 1] !== ']') return false
  return parsed === subsection
}

function parseValueText(text: string): string {
  let value = ''
  let inQuotes = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (!inQuotes && (char === '#' || char === ';')) break
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1] as string
      if (inQuotes) {
        if (next === 'n') value += '\n'
        else if (next === 't') value += '\t'
        else if (next === 'b') value += '\b'
        else if (next === '"') value += '"'
        else if (next === '\\') value += '\\'
        else value += next
        index++
        continue
      }
      if (next === '\\') {
        value += '\\'
        index++
        continue
      }
      value += char
      continue
    }
    value += char
  }
  if (!inQuotes) {
    value = value.replace(/[ \t]+$/, '')
  }
  return value
}

function parseKeyValueLine(line: string, key: string): string | null {
  const keyMatch = line.match(/^[A-Za-z0-9-]+/)
  if (!keyMatch || keyMatch[0] === '') return null
  if (keyMatch[0].toLowerCase() !== key.toLowerCase()) return null
  let index = keyMatch[0].length
  while (line[index] === ' ' || line[index] === '\t') index++
  if (line[index] !== '=') return null
  index++
  while (line[index] === ' ' || line[index] === '\t') index++
  return parseValueText(line.slice(index))
}

function parseGitConfigString(
  content: string,
  section: string,
  subsection: string | null,
  key: string,
): string | null {
  const lines = content.split(/\r?\n/)
  let inSection = false
  let found: string | null = null
  for (let i = 0; i < lines.length; i++) {
    let trimmed = lines[i]!.trimStart()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    if (trimmed.startsWith('[')) {
      inSection = matchesSectionHeader(trimmed, section, subsection)
      continue
    }
    if (!inSection) continue
    while (trimmed.endsWith('\\') && i + 1 < lines.length) {
      let backslashes = 0
      for (let j = trimmed.length - 1; j >= 0 && trimmed[j] === '\\'; j--) backslashes++
      if (backslashes % 2 === 0) break
      i++
      trimmed = trimmed.slice(0, -1) + lines[i]!
    }
    const parsed = parseKeyValueLine(trimmed, key)
    if (parsed !== null) {
      found = parsed
    }
  }
  return found
}

export async function parseGitConfigValue(
  gitDir: string,
  section: string,
  subsection: string | null,
  key: string,
): Promise<string | null> {
  let content: string
  try {
    content = await readFile(join(gitDir, 'config'), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return null
    throw error
  }
  return parseGitConfigString(content, section, subsection, key)
}

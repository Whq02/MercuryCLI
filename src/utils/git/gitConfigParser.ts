import { readFile } from 'node:fs/promises'
import { join } from 'node:path'


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

export function parseConfigString(
  config: string,
  section: string,
  subsection: string | null,
  key: string,
): string | null {
  let inMatchingSection = false
  for (const rawLine of config.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line[0] === '#' || line[0] === ';') continue
    if (line[0] === '[') {
      inMatchingSection = matchesSectionHeader(line, section, subsection)
      continue
    }
    if (!inMatchingSection) continue
    const value = parseKeyValueLine(line, key)
    if (value !== null) return value
  }
  return null
}

export async function parseGitConfigValue(
  gitDir: string,
  section: string,
  subsection: string | null,
  key: string,
): Promise<string | null> {
  try {
    const content = await readFile(join(gitDir, 'config'), 'utf8')
    return parseConfigString(content, section, subsection, key)
  } catch {
    return null
  }
}

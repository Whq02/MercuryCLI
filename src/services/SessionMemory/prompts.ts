import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'


function overridePath(fileName: string): string {
  return join(getMercuryHome(), 'session-memory', 'config', fileName)
}

function loadOverrideOr(fileName: string, fallback: string): string {
  const fs = getFsImplementation()
  const path = overridePath(fileName)
  if (!fs.existsSync(path)) return fallback
  try {
    return fs.readFileSync(path, { encoding: 'utf-8' })
  } catch (error) {
    logError(`session memory: override ${fileName} read failed: ${String(error)}`)
    return fallback
  }
}


const DEFAULT_SESSION_MEMORY_TEMPLATE = `# Session Title

# Current State

# Task specification

# Files and Functions

# Workflow

# Errors & Corrections

# Codebase and System Documentation

# Learnings

# Key results

# Worklog
`

const MAX_SECTION_CHARS = 8000
const TRUNCATION_MARKER = '_[section truncated for length]_'

export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = loadOverrideOr('template.md', DEFAULT_SESSION_MEMORY_TEMPLATE)
  return content.trim() === template.trim()
}

export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const lines = content.split('\n')
  const firstHeadingIndex = lines.findIndex(line => /^#\s/.test(line))
  if (firstHeadingIndex === -1) {
    return { truncatedContent: content, wasTruncated: false }
  }

  const out: string[] = lines.slice(0, firstHeadingIndex)
  let wasTruncated = false
  let sectionChars = 0
  let sectionTruncated = false

  for (let i = firstHeadingIndex; i < lines.length; i++) {
    const line = lines[i]!
    if (/^#\s/.test(line)) {
      out.push(line)
      sectionChars = 0
      sectionTruncated = false
      continue
    }
    if (sectionTruncated) continue
    const cost = line.length + 1
    if (sectionChars + cost > MAX_SECTION_CHARS) {
      out.push(TRUNCATION_MARKER)
      sectionTruncated = true
      wasTruncated = true
      continue
    }
    out.push(line)
    sectionChars += cost
  }

  return {
    truncatedContent: out.join('\n'),
    wasTruncated,
  }
}

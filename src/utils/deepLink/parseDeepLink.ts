import { partiallySanitizeUnicode } from '../sanitization.js'

/**
 * Parses and builds the custom URI scheme. `mercury` is the ONE scheme —
 * Mercury registers, emits and parses only it.
 *
 * Everything here — decoding, Unicode sanitising, control-character
 * rejection, length caps — is layered defence that NARROWS the input. The
 * real injection boundary is the launcher's quoting downstream; do not
 * weaken it on the strength of these checks.
 */

export const DEEP_LINK_PROTOCOL = 'mercury'

export type DeepLinkAction = {
  query?: string
  cwd?: string
  repo?: string
}

const MAX_CWD_LENGTH = 4096
// The practical ceiling for the Windows command-shell fallback launcher's
// 8191-character command-string limit after wrapping and percent-escaping.
const MAX_QUERY_LENGTH = 5000

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

function assertNoControlCharacters(value: string, field: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    throw new Error(`Deep link ${field} contains disallowed control characters`)
  }
}

export function parseDeepLink(uri: string): DeepLinkAction {
  let normalized = uri

  // Accept both `mercury://…` and `mercury:…`.
  if (normalized.startsWith(`${DEEP_LINK_PROTOCOL}:`) && !normalized.startsWith(`${DEEP_LINK_PROTOCOL}://`)) {
    normalized = `${DEEP_LINK_PROTOCOL}://${normalized.slice(DEEP_LINK_PROTOCOL.length + 1)}`
  }
  if (!normalized.startsWith(`${DEEP_LINK_PROTOCOL}://`)) {
    throw new Error(`Deep link must use the ${DEEP_LINK_PROTOCOL}:// scheme; got: ${uri}`)
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error(`Deep link could not be parsed as a URL: ${uri}`)
  }

  if (url.host !== 'open') {
    throw new Error(`Deep link names an unknown action: ${url.host}`)
  }

  const action: DeepLinkAction = {}
  const cwd = url.searchParams.get('cwd')
  const repo = url.searchParams.get('repo')
  const query = url.searchParams.get('q')

  if (cwd !== null) {
    // Must be absolute (a leading slash or a drive-letter prefix).
    if (!(cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd))) {
      throw new Error(`Deep link cwd must be an absolute path; got: ${cwd}`)
    }
    // Control characters can act as shell command separators.
    assertNoControlCharacters(cwd, 'cwd')
    if (cwd.length > MAX_CWD_LENGTH) {
      throw new Error(`Deep link cwd exceeds the ${MAX_CWD_LENGTH}-character limit (${cwd.length})`)
    }
    action.cwd = cwd
  }

  if (repo !== null) {
    // Exactly <owner>/<name>; anything looser becomes a traversal vector.
    // Resolution against configured repository paths happens elsewhere —
    // this parser stays pure.
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`Deep link repo must look like owner/name; got: ${repo}`)
    }
    action.repo = repo
  }

  if (query !== null && query.trim() !== '') {
    // Strip hidden characters used for ASCII smuggling / hidden prompt
    // injection, then REJECT (never truncate — truncation changes meaning).
    const sanitized = partiallySanitizeUnicode(query.trim())
    assertNoControlCharacters(sanitized, 'query')
    if (sanitized.length > MAX_QUERY_LENGTH) {
      throw new Error(`Deep link query exceeds the ${MAX_QUERY_LENGTH}-character limit (${sanitized.length})`)
    }
    action.query = sanitized
  }

  return action
}

/** Builds a canonical-scheme link with host `open` and only the supplied parameters, in q/cwd/repo order. */
export function buildDeepLink(action: DeepLinkAction): string {
  const url = new URL(`${DEEP_LINK_PROTOCOL}://open`)
  if (action.query !== undefined) url.searchParams.set('q', action.query)
  if (action.cwd !== undefined) url.searchParams.set('cwd', action.cwd)
  if (action.repo !== undefined) url.searchParams.set('repo', action.repo)
  return url.toString()
}

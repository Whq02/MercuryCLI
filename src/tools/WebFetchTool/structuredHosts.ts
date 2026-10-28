import axios from 'axios'
import { AbortError } from '../../utils/errors.js'
import { decodeHtmlEntities, htmlToText, readAttribute } from '../../services/search/htmlText.js'
import { webUserAgent } from '../../utils/webUserAgent.js'
import { FetchRefusedError } from './fetchErrors.js'
import { FetchPacing } from './fetchPacing.js'
import { permittedFetchRedirect } from './fetchTransport.js'
import { metadataSafeAddresses } from './privateHost.js'

type StructuredResult = {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  notice: string
}

type StructuredTarget =
  | { source: 'github'; kind: 'repo'; owner: string; repo: string }
  | { source: 'github'; kind: 'issue'; owner: string; repo: string; number: string }
  | { source: 'github'; kind: 'pull'; owner: string; repo: string; number: string }
  | { source: 'npm'; pkg: string; version?: string }
  | { source: 'pypi'; project: string; version?: string }
  | { source: 'crates'; crate: string; version?: string }
  | { source: 'arxiv'; paperId: string }
  | { source: 'stackoverflow'; questionId: string }

type StructuredSource = StructuredTarget['source']

const MAX_API_BYTES = 2 * 1024 * 1024
const MAX_API_REDIRECTS = 3
const MAX_BODY_CHARS = 16_000
const MAX_README_CHARS = 24_000
const MAX_COMMENT_CHARS = 4_000
const MAX_LIST_ITEMS = 20
const MAX_COMMENTS = 5

const SOURCE_INTERVAL_MS: Record<StructuredSource, number> = {
  github: 1_000,
  npm: 1_000,
  pypi: 1_000,
  crates: 1_000,
  arxiv: 3_000,
  stackoverflow: 1_000,
}

const SOURCE_LABEL: Record<StructuredSource, string> = {
  github: 'GitHub REST API',
  npm: 'npm registry API',
  pypi: 'PyPI JSON API',
  crates: 'crates.io API',
  arxiv: 'arXiv export API',
  stackoverflow: 'Stack Exchange API',
}

const SOURCE_TERMS: Record<StructuredSource, string> = {
  github: 'structured via GitHub REST API (keyless public metadata; repository content keeps its own licence)',
  npm: 'structured via npm registry API (keyless public metadata; https://docs.npmjs.com/policies/open-source-terms/)',
  pypi: 'structured via PyPI JSON API (keyless public metadata; https://policies.python.org/pypi.org/Acceptable-Use-Policy/)',
  crates: 'structured via crates.io API (keyless public metadata, 1 req/s; https://crates.io/data-access)',
  arxiv: 'structured via arXiv export API (keyless OAI/Atom metadata; thank arXiv in derived work: https://info.arxiv.org/help/api/tou.html)',
  stackoverflow: 'structured via Stack Exchange API (keyless public Q&A; CC BY-SA attribution required: https://stackexchange.com/legal/api-terms-of-use)',
}

const sourcePacing = new Map<StructuredSource, FetchPacing>()

function pacingFor(source: StructuredSource): FetchPacing {
  let pace = sourcePacing.get(source)
  if (!pace) {
    pace = new FetchPacing()
    sourcePacing.set(source, pace)
  }
  return pace
}

export function resetStructuredFetchPacing(): void {
  sourcePacing.clear()
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function clip(text: string, limit: number): string {
  const cleaned = text.replace(/\r\n/g, '\n').trim()
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}\n… [truncated at ${limit} characters]` : cleaned
}

function decodeSafePath(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    if (decoded.includes('\0') || decoded.includes('\\') || /(?:^|\/)\.\.(?:\/|$)/.test(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

function classifyStructuredFetchUrl(rawUrl: string): StructuredTarget | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.port !== '') return null
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const decodedPath = decodeSafePath(parsed.pathname)
  if (decodedPath === null) return null
  const parts = decodedPath.split(/\/+/).filter(Boolean)

  if (host === 'github.com') {
    const RESERVED = new Set([
      'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact', 'customer-stories',
      'dashboard', 'developers', 'discussions', 'enterprise', 'events', 'explore', 'features',
      'gist', 'gists', 'git-guides', 'join', 'login', 'logout', 'new', 'notifications',
      'orgs', 'organizations', 'pricing', 'pulls', 'issues', 'readme', 'search', 'security',
      'session', 'settings', 'signup', 'site', 'sponsors', 'topics', 'trending', 'users', 'watching',
    ])
    if (parts.length >= 2) {
      const owner = parts[0]!
      const repo = parts[1]!.replace(/\.git$/i, '')
      if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || RESERVED.has(owner.toLowerCase())) {
        return null
      }
      if (parts.length === 2) {
        return { source: 'github', kind: 'repo', owner, repo }
      }
      if (parts.length === 4 && (parts[2] === 'issues' || parts[2] === 'pull') && /^\d+$/.test(parts[3]!)) {
        return {
          source: 'github',
          kind: parts[2] === 'issues' ? 'issue' : 'pull',
          owner,
          repo,
          number: parts[3]!,
        }
      }
    }
    return null
  }

  if (host === 'npmjs.com') {
    if (parts[0] !== 'package' || parts.length < 2) return null
    if (parts[1]!.startsWith('@')) {
      if (parts.length === 3 && /^@[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[1]!) && /^[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[2]!)) {
        return { source: 'npm', pkg: `${parts[1]}/${parts[2]}` }
      }
      if (parts.length === 5 && parts[3] === 'v' && /^@[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[1]!) && /^[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[2]!) && /^[A-Za-z0-9.+_-]+$/.test(parts[4]!)) {
        return { source: 'npm', pkg: `${parts[1]}/${parts[2]}`, version: parts[4]! }
      }
      return null
    }
    if (parts.length === 2 && /^[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[1]!)) {
      return { source: 'npm', pkg: parts[1]! }
    }
    if (parts.length === 4 && parts[2] === 'v' && /^[a-z0-9-~][a-z0-9-._~]*$/i.test(parts[1]!) && /^[A-Za-z0-9.+_-]+$/.test(parts[3]!)) {
      return { source: 'npm', pkg: parts[1]!, version: parts[3]! }
    }
    return null
  }

  if (host === 'pypi.org') {
    if ((parts[0] === 'project' || parts[0] === 'pypi') && parts.length >= 2 && parts.length <= 3) {
      const project = parts[1]!
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return null
      if (parts.length === 2) return { source: 'pypi', project }
      if (parts[2] === 'json') return null
      if (/^[A-Za-z0-9.+!_-]+$/.test(parts[2]!)) return { source: 'pypi', project, version: parts[2]! }
    }
    return null
  }

  if (host === 'crates.io') {
    if (parts[0] === 'crates' && parts.length >= 2 && parts.length <= 3) {
      const crate = parts[1]!
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(crate)) return null
      if (parts.length === 2) return { source: 'crates', crate }
      if (/^[A-Za-z0-9.+_-]+$/.test(parts[2]!)) return { source: 'crates', crate, version: parts[2]! }
    }
    return null
  }

  if (host === 'arxiv.org') {
    if (parts[0] === 'abs' && parts.length >= 2 && parts.length <= 3) {
      const rawId = parts.slice(1).join('/').replace(/\.pdf$/i, '')
      if (/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.test(rawId)) {
        return { source: 'arxiv', paperId: rawId }
      }
    }
    return null
  }

  if (host === 'stackoverflow.com') {
    if ((parts[0] === 'questions' || parts[0] === 'q') && parts.length >= 2 && /^\d+$/.test(parts[1]!)) {
      return { source: 'stackoverflow', questionId: parts[1]! }
    }
    return null
  }

  return null
}

export function arxivPaperUrl(rawUrl: string): string | null {
  const parsed = new URL(rawUrl)
  if (!parsed.pathname.startsWith('/pdf/')) return null
  parsed.pathname = parsed.pathname.replace(/^\/pdf\//, '/abs/')
  const target = classifyStructuredFetchUrl(parsed.href)
  return target?.source === 'arxiv' ? `${parsed.origin}/pdf/${target.paperId}` : null
}

type ApiReadResult =
  | { ok: true; status: number; statusText: string; bytes: number; text: string; contentType: string; headers: Record<string, unknown> }
  | { ok: false; fallThrough: true; oversize?: true }

type ApiReadMode = 'required' | 'optional' | 'registry'

async function fetchApiEndpoint(
  source: StructuredSource,
  apiUrl: string,
  signal: AbortSignal,
  accept: string,
  mode: ApiReadMode = 'required',
  redirects = 0,
): Promise<ApiReadResult> {
  if (signal.aborted) throw new AbortError()
  const addresses = await metadataSafeAddresses(apiUrl)
  const pace = pacingFor(source)
  const outcome = await pace.run<ApiReadResult | { redirectTo: string }>(SOURCE_INTERVAL_MS[source], signal, async waitMs => {
    if (signal.aborted) throw new AbortError()
    if (waitMs > 0) {
      throw new FetchRefusedError(
        429,
        `${SOURCE_LABEL[source]} is cooling down for ${Math.ceil(waitMs / 1000)}s; no request was sent. Search for another source and do not retry before the wait ends.`,
      )
    }
    let response
    try {
      response = await axios.get<ArrayBuffer>(apiUrl, {
        signal,
        lookup: async () => [addresses],
        timeout: 20_000,
        maxRedirects: 0,
        responseType: 'arraybuffer',
        maxContentLength: MAX_API_BYTES,
        headers: {
          Accept: accept,
          'User-Agent': webUserAgent(),
          ...(source === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
        },
      })
    } catch (error) {
      if (signal.aborted) throw new AbortError()
      if (error instanceof FetchRefusedError) throw error
      if (axios.isAxiosError(error)) {
        if (error.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' || /maxContentLength/i.test(error.message)) {
          if (mode !== 'required') return { ok: false, fallThrough: true, oversize: true }
          throw new FetchRefusedError(
            413,
            `${SOURCE_LABEL[source]} returned a response larger than ${MAX_API_BYTES} bytes; refused before decoding.`,
          )
        }
        if (error.response) {
          response = error.response
        } else {
          return { ok: false, fallThrough: true }
        }
      } else {
        return { ok: false, fallThrough: true }
      }
    }

    const status = response.status
    const headers = (response.headers ?? {}) as Record<string, unknown>
    if (status === 403 && headers['x-proxy-error'] === 'blocked-by-allowlist') {
      return { ok: false, fallThrough: true }
    }
    if (status >= 300 && status < 400) {
      const loc = typeof headers.location === 'string' ? headers.location : ''
      let nextHost = ''
      let next = ''
      try {
        next = new URL(loc, apiUrl).toString()
        nextHost = new URL(next).hostname
      } catch {
        nextHost = 'unknown'
      }
      if (next !== '') await metadataSafeAddresses(next)
      if (next !== '' && permittedFetchRedirect(apiUrl, next)) {
        if (redirects >= MAX_API_REDIRECTS) {
          throw new FetchRefusedError(status, `${SOURCE_LABEL[source]} redirected more than ${MAX_API_REDIRECTS} times; search for another source.`)
        }
        return { redirectTo: next }
      }
      throw new FetchRefusedError(
        status,
        `${SOURCE_LABEL[source]} redirected (${status}${nextHost ? ` to ${nextHost}` : ''}); structured API endpoints do not follow redirects. Search for another source.`,
      )
    }
    if (status === 429 || status === 503 || status === 403) {
      const retryAfter = headers['retry-after']
      const resetHeader = headers['x-ratelimit-reset']
      let retryArg: unknown = retryAfter
      if (retryArg === undefined && typeof resetHeader === 'string' && /^\d+$/.test(resetHeader)) {
        const waitSec = Math.max(1, Number(resetHeader) - Math.floor(pace.clock.now() / 1000))
        retryArg = String(waitSec)
      }
      const delay = pace.refuse(retryArg)
      throw new FetchRefusedError(
        status,
        `${SOURCE_LABEL[source]} ${status === 403 ? 'refused or rate-limited' : 'is rate-limiting'} requests; backed off for ${Math.ceil(delay / 1000)}s. Search for another source and do not retry before the wait ends.`,
      )
    }
    if (status === 404 && mode !== 'optional') {
      return { ok: false, fallThrough: true }
    }
    if (status < 200 || status >= 300) {
      if (mode === 'optional') return { ok: false, fallThrough: true }
      throw new FetchRefusedError(
        status,
        `${SOURCE_LABEL[source]} could not serve this request (${status}); search for another source — do not retry this URL.`,
      )
    }
    const buf = Buffer.from(response.data)
    if (buf.byteLength > MAX_API_BYTES) {
      if (mode !== 'required') return { ok: false, fallThrough: true, oversize: true }
      throw new FetchRefusedError(
        413,
        `${SOURCE_LABEL[source]} returned a response larger than ${MAX_API_BYTES} bytes; refused before decoding.`,
      )
    }
    if (pace.remaining() === 0) pace.answered()
    return {
      ok: true,
      status,
      statusText: response.statusText || 'OK',
      bytes: buf.byteLength,
      text: buf.toString('utf8'),
      contentType: String(headers['content-type'] ?? '').toLowerCase(),
      headers,
    }
  })
  if ('redirectTo' in outcome) return fetchApiEndpoint(source, outcome.redirectTo, signal, accept, mode, redirects + 1)
  return outcome
}

function parseJsonBody(source: StructuredSource, res: Extract<ApiReadResult, { ok: true }>): Record<string, unknown> {
  if (res.contentType.includes('text/html') || /^\s*</.test(res.text)) {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL[source]} returned HTML instead of JSON; no structured content was guessed.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.text)
  } catch {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL[source]} returned invalid JSON; no structured content was guessed.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL[source]} returned an unexpected JSON shape; no structured content was guessed.`,
    )
  }
  return parsed as Record<string, unknown>
}

function parseJsonArrayOrObject(source: StructuredSource, res: Extract<ApiReadResult, { ok: true }>): unknown {
  if (res.contentType.includes('text/html') || /^\s*</.test(res.text)) {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL[source]} returned HTML instead of JSON; no structured content was guessed.`,
    )
  }
  try {
    return JSON.parse(res.text)
  } catch {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL[source]} returned invalid JSON; no structured content was guessed.`,
    )
  }
}

async function fetchGitHubStructured(
  target: Extract<StructuredTarget, { source: 'github' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const base = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  if (target.kind === 'repo') {
    const repoRes = await fetchApiEndpoint('github', base, signal, 'application/vnd.github+json')
    if (!repoRes.ok) return null
    const repo = parseJsonBody('github', repoRes)
    const fullName = str(repo.full_name) || `${target.owner}/${target.repo}`
    const desc = str(repo.description)
    const stars = num(repo.stargazers_count)
    const forks = num(repo.forks_count)
    const issues = num(repo.open_issues_count)
    const lang = str(repo.language)
    const branch = str(repo.default_branch)
    const license = str(obj(repo.license).spdx_id) || str(obj(repo.license).name)
    const homepage = str(repo.homepage)
    const topics = Array.isArray(repo.topics)
      ? repo.topics.filter((t): t is string => typeof t === 'string').slice(0, MAX_LIST_ITEMS)
      : []
    const archived = repo.archived === true

    let readmeText = ''
    let readmeBytes = 0
    const readmeRes = await fetchApiEndpoint('github', `${base}/readme`, signal, 'application/vnd.github+json', 'optional')
    if (readmeRes.ok) {
      readmeBytes = readmeRes.bytes
      try {
        const readmeJson = parseJsonBody('github', readmeRes)
        const encoded = str(readmeJson.content)
        const encoding = str(readmeJson.encoding).toLowerCase()
        if (encoded && encoding === 'base64') {
          const decoded = Buffer.from(encoded.replace(/\s+/g, ''), 'base64')
          if (decoded.byteLength <= MAX_API_BYTES) {
            readmeText = clip(decoded.toString('utf8'), MAX_README_CHARS)
          }
        }
      } catch {
        readmeText = ''
      }
    }

    const lines: string[] = [`# ${fullName}`]
    if (desc) lines.push('', desc)
    const meta: string[] = []
    if (lang) meta.push(`Language: ${lang}`)
    if (license) meta.push(`License: ${license}`)
    if (branch) meta.push(`Default branch: ${branch}`)
    if (stars !== undefined) meta.push(`Stars: ${stars}`)
    if (forks !== undefined) meta.push(`Forks: ${forks}`)
    if (issues !== undefined) meta.push(`Open issues: ${issues}`)
    if (archived) meta.push('Status: archived')
    if (homepage) meta.push(`Homepage: ${homepage}`)
    if (topics.length > 0) meta.push(`Topics: ${topics.join(', ')}`)
    if (meta.length > 0) lines.push('', ...meta.map(m => `- ${m}`))
    if (readmeText) lines.push('', '## README', '', readmeText)

    const content = lines.join('\n')
    return {
      bytes: repoRes.bytes + readmeBytes,
      code: repoRes.status,
      codeText: repoRes.statusText,
      content,
      contentType: 'application/json',
      notice: SOURCE_TERMS.github,
    }
  }

  const endpoint = target.kind === 'pull' ? `${base}/pulls/${target.number}` : `${base}/issues/${target.number}`
  const itemRes = await fetchApiEndpoint('github', endpoint, signal, 'application/vnd.github+json')
  if (!itemRes.ok) return null
  const item = parseJsonBody('github', itemRes)
  const title = str(item.title) || `${target.kind === 'pull' ? 'Pull request' : 'Issue'} #${target.number}`
  const state = str(item.state) || 'unknown'
  const author = str(obj(item.user).login)
  const created = str(item.created_at)
  const merged = item.merged === true
  const draft = item.draft === true
  const labels = Array.isArray(item.labels)
    ? item.labels.map(l => (typeof l === 'string' ? l : str(obj(l).name))).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : []
  const body = clip(str(item.body), MAX_BODY_CHARS)

  const lines: string[] = [
    `# ${title} (${target.owner}/${target.repo}#${target.number})`,
    '',
    `- Kind: ${target.kind === 'pull' ? 'Pull request' : 'Issue'}`,
    `- State: ${merged ? 'merged' : draft ? `${state} (draft)` : state}`,
  ]
  if (author) lines.push(`- Author: ${author}`)
  if (created) lines.push(`- Created: ${created}`)
  if (target.kind === 'pull') {
    const head = str(obj(item.head).label) || str(obj(item.head).ref)
    const baseRef = str(obj(item.base).label) || str(obj(item.base).ref)
    if (head && baseRef) lines.push(`- Branches: ${head} -> ${baseRef}`)
    const commits = num(item.commits)
    const additions = num(item.additions)
    const deletions = num(item.deletions)
    const changedFiles = num(item.changed_files)
    if (commits !== undefined || changedFiles !== undefined) {
      lines.push(`- Diff: ${commits ?? 0} commits, ${changedFiles ?? 0} files (+${additions ?? 0} / -${deletions ?? 0})`)
    }
  }
  if (labels.length > 0) lines.push(`- Labels: ${labels.join(', ')}`)
  if (body) lines.push('', '## Description', '', body)

  let commentBytes = 0
  const commentsCount = num(item.comments) ?? 0
  if (commentsCount > 0) {
    const commentsUrl = `${base}/issues/${target.number}/comments?per_page=${MAX_COMMENTS}`
    const commentsRes = await fetchApiEndpoint('github', commentsUrl, signal, 'application/vnd.github+json', 'optional')
    if (commentsRes.ok) {
      commentBytes = commentsRes.bytes
      try {
        const rawComments = parseJsonArrayOrObject('github', commentsRes)
        if (Array.isArray(rawComments) && rawComments.length > 0) {
          lines.push('', '## Comments')
          for (const raw of rawComments.slice(0, MAX_COMMENTS)) {
            const c = obj(raw)
            const who = str(obj(c.user).login) || 'user'
            const when = str(c.created_at)
            const cBody = clip(str(c.body), MAX_COMMENT_CHARS)
            if (cBody) lines.push('', `### ${who}${when ? ` (${when})` : ''}`, '', cBody)
          }
        }
      } catch {
        commentBytes = 0
      }
    }
  }

  return {
    bytes: itemRes.bytes + commentBytes,
    code: itemRes.status,
    codeText: itemRes.statusText,
    content: lines.join('\n'),
    contentType: 'application/json',
    notice: SOURCE_TERMS.github,
  }
}

async function fetchNpmStructured(
  target: Extract<StructuredTarget, { source: 'npm' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const slash = target.pkg.indexOf('/')
  const encodedPkg = target.pkg.startsWith('@') && slash > 0
    ? `@${encodeURIComponent(target.pkg.slice(1, slash))}%2F${encodeURIComponent(target.pkg.slice(slash + 1))}`
    : encodeURIComponent(target.pkg)
  const apiUrl = `https://registry.npmjs.org/${encodedPkg}`
  let res = await fetchApiEndpoint('npm', apiUrl, signal, 'application/json', 'registry')
  let packument: Record<string, unknown>
  if (!res.ok && res.oversize) {
    res = await fetchApiEndpoint('npm', `${apiUrl}/${encodeURIComponent(target.version ?? 'latest')}`, signal, 'application/json')
    if (!res.ok) return null
    const doc = parseJsonBody('npm', res)
    const docVersion = str(doc.version)
    packument = { name: doc.name, 'dist-tags': target.version ? {} : { latest: docVersion }, versions: { [docVersion]: doc }, readme: doc.readme }
  } else {
    if (!res.ok) return null
    packument = parseJsonBody('npm', res)
  }
  const name = str(packument.name) || target.pkg
  const distTags = obj(packument['dist-tags'])
  const latest = str(distTags.latest)
  const chosenVer = target.version ?? (latest || Object.keys(obj(packument.versions)).pop() || '')
  const versions = obj(packument.versions)
  const verObj = chosenVer ? obj(versions[chosenVer]) : {}
  const desc = str(verObj.description) || str(packument.description)
  const license = typeof verObj.license === 'string'
    ? verObj.license
    : typeof packument.license === 'string'
      ? packument.license
      : str(obj(verObj.license).type) || str(obj(packument.license).type)
  const homepage = str(verObj.homepage) || str(packument.homepage)
  const repoObj = obj(verObj.repository ?? packument.repository)
  const repoUrl = str(repoObj.url) || (typeof (verObj.repository ?? packument.repository) === 'string' ? str(verObj.repository ?? packument.repository) : '')
  const keywords = Array.isArray(verObj.keywords)
    ? verObj.keywords.filter((k): k is string => typeof k === 'string').slice(0, MAX_LIST_ITEMS)
    : Array.isArray(packument.keywords)
      ? packument.keywords.filter((k): k is string => typeof k === 'string').slice(0, MAX_LIST_ITEMS)
      : []
  const deps = Object.keys(obj(verObj.dependencies)).slice(0, MAX_LIST_ITEMS)
  const readme = clip(str(verObj.readme) || str(packument.readme), MAX_README_CHARS)

  const lines: string[] = [`# ${name}${chosenVer ? ` (${chosenVer})` : ''}`]
  if (desc) lines.push('', desc)
  const meta: string[] = []
  if (chosenVer) meta.push(`Version: ${chosenVer}`)
  if (latest && latest !== chosenVer) meta.push(`Latest: ${latest}`)
  if (license) meta.push(`License: ${license}`)
  if (homepage) meta.push(`Homepage: ${homepage}`)
  if (repoUrl) meta.push(`Repository: ${repoUrl}`)
  if (keywords.length > 0) meta.push(`Keywords: ${keywords.join(', ')}`)
  if (deps.length > 0) meta.push(`Dependencies (${Object.keys(obj(verObj.dependencies)).length}): ${deps.join(', ')}`)
  if (meta.length > 0) lines.push('', ...meta.map(m => `- ${m}`))
  if (readme) lines.push('', '## README', '', readme)

  return {
    bytes: res.bytes,
    code: res.status,
    codeText: res.statusText,
    content: lines.join('\n'),
    contentType: 'application/json',
    notice: SOURCE_TERMS.npm,
  }
}

async function fetchPypiStructured(
  target: Extract<StructuredTarget, { source: 'pypi' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const apiUrl = target.version
    ? `https://pypi.org/pypi/${encodeURIComponent(target.project)}/${encodeURIComponent(target.version)}/json`
    : `https://pypi.org/pypi/${encodeURIComponent(target.project)}/json`
  const res = await fetchApiEndpoint('pypi', apiUrl, signal, 'application/json', 'registry')
  if (!res.ok) return null
  const body = parseJsonBody('pypi', res)
  const info = obj(body.info)
  const name = str(info.name) || target.project
  const version = str(info.version) || target.version || ''
  const summary = str(info.summary)
  const license = str(info.license_expression) || str(info.license)
  const requiresPython = str(info.requires_python)
  const homePage = str(info.home_page) || str(info.project_url)
  const projectUrls = obj(info.project_urls)
  const requiresDist = Array.isArray(info.requires_dist)
    ? info.requires_dist.filter((r): r is string => typeof r === 'string').slice(0, MAX_LIST_ITEMS)
    : []
  const description = clip(str(info.description), MAX_README_CHARS)

  const lines: string[] = [`# ${name}${version ? ` (${version})` : ''}`]
  if (summary) lines.push('', summary)
  const meta: string[] = []
  if (version) meta.push(`Version: ${version}`)
  if (license) meta.push(`License: ${license}`)
  if (requiresPython) meta.push(`Requires Python: ${requiresPython}`)
  if (homePage) meta.push(`Homepage: ${homePage}`)
  for (const [label, url] of Object.entries(projectUrls).slice(0, 6)) {
    if (typeof url === 'string' && url.trim()) meta.push(`${label}: ${url.trim()}`)
  }
  if (requiresDist.length > 0) meta.push(`Dependencies: ${requiresDist.join('; ')}`)
  if (meta.length > 0) lines.push('', ...meta.map(m => `- ${m}`))
  if (description) lines.push('', '## Description', '', description)

  return {
    bytes: res.bytes,
    code: res.status,
    codeText: res.statusText,
    content: lines.join('\n'),
    contentType: 'application/json',
    notice: SOURCE_TERMS.pypi,
  }
}

async function fetchCratesStructured(
  target: Extract<StructuredTarget, { source: 'crates' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const apiUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(target.crate)}`
  const res = await fetchApiEndpoint('crates', apiUrl, signal, 'application/json')
  if (!res.ok) return null
  const body = parseJsonBody('crates', res)
  const crate = obj(body.crate)
  const versions = Array.isArray(body.versions) ? body.versions.map(obj) : []
  const name = str(crate.name) || str(crate.id) || target.crate
  const latest = str(crate.max_stable_version) || str(crate.max_version) || str(crate.newest_version)
  const chosenVer = target.version ?? latest
  const verObj = versions.find(v => str(v.num) === chosenVer) ?? versions[0] ?? {}
  const desc = str(crate.description)
  const license = str(verObj.license)
  const repo = str(crate.repository)
  const homepage = str(crate.homepage)
  const docs = str(crate.documentation) || (name ? `https://docs.rs/${encodeURIComponent(name)}` : '')
  const downloads = num(crate.downloads)
  const categories = Array.isArray(body.categories)
    ? body.categories.map(c => str(obj(c).category) || str(obj(c).id)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : []
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map(k => str(obj(k).keyword) || str(obj(k).id)).filter(Boolean).slice(0, MAX_LIST_ITEMS)
    : []

  const lines: string[] = [`# ${name}${chosenVer ? ` (${chosenVer})` : ''}`]
  if (desc) lines.push('', desc)
  const meta: string[] = []
  if (chosenVer) meta.push(`Version: ${chosenVer}`)
  if (latest && latest !== chosenVer) meta.push(`Latest: ${latest}`)
  if (license) meta.push(`License: ${license}`)
  if (repo) meta.push(`Repository: ${repo}`)
  if (homepage) meta.push(`Homepage: ${homepage}`)
  if (docs) meta.push(`Documentation: ${docs}`)
  if (downloads !== undefined) meta.push(`Downloads: ${downloads}`)
  if (categories.length > 0) meta.push(`Categories: ${categories.join(', ')}`)
  if (keywords.length > 0) meta.push(`Keywords: ${keywords.join(', ')}`)
  if (meta.length > 0) lines.push('', ...meta.map(m => `- ${m}`))

  return {
    bytes: res.bytes,
    code: res.status,
    codeText: res.statusText,
    content: lines.join('\n'),
    contentType: 'application/json',
    notice: SOURCE_TERMS.crates,
  }
}

function xmlTagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return m ? decodeHtmlEntities(m[1]!.replace(/\s+/g, ' ').trim()) : ''
}

async function fetchArxivStructured(
  target: Extract<StructuredTarget, { source: 'arxiv' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(target.paperId)}`
  const res = await fetchApiEndpoint('arxiv', apiUrl, signal, 'application/atom+xml, application/xml, text/xml')
  if (!res.ok) return null
  if (!/<feed\b/i.test(res.text)) {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL.arxiv} did not return an Atom XML feed; no structured content was guessed.`,
    )
  }
  const entryMatch = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(res.text)
  if (!entryMatch) return null
  const entry = entryMatch[1]!
  const title = xmlTagText(entry, 'title')
  const summary = clip(
    decodeHtmlEntities((/<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(entry)?.[1] ?? '').trim()),
    MAX_BODY_CHARS,
  )
  if (!title && !summary) return null
  const published = xmlTagText(entry, 'published')
  const updated = xmlTagText(entry, 'updated')
  const comment = xmlTagText(entry, 'arxiv:comment')
  const journalRef = xmlTagText(entry, 'arxiv:journal_ref')
  const doi = xmlTagText(entry, 'arxiv:doi')
  const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map(m => decodeHtmlEntities(m[1]!.replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS)
  const categories = [...entry.matchAll(/<category\b([^>]*)\/?>/gi)]
    .map(m => readAttribute(m[1]!, 'term') ?? '')
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS)

  const lines: string[] = [`# ${title || `arXiv:${target.paperId}`}`]
  const meta: string[] = [`arXiv ID: ${target.paperId}`, `PDF: https://arxiv.org/pdf/${target.paperId}`]
  if (authors.length > 0) meta.push(`Authors: ${authors.join(', ')}`)
  if (published) meta.push(`Published: ${published}`)
  if (updated && updated !== published) meta.push(`Updated: ${updated}`)
  if (categories.length > 0) meta.push(`Categories: ${categories.join(', ')}`)
  if (comment) meta.push(`Comment: ${comment}`)
  if (journalRef) meta.push(`Journal reference: ${journalRef}`)
  if (doi) meta.push(`DOI: ${doi}`)
  lines.push('', ...meta.map(m => `- ${m}`))
  if (summary) lines.push('', '## Abstract', '', summary)

  return {
    bytes: res.bytes,
    code: res.status,
    codeText: res.statusText,
    content: lines.join('\n'),
    contentType: 'application/atom+xml',
    notice: SOURCE_TERMS.arxiv,
  }
}

async function fetchStackOverflowStructured(
  target: Extract<StructuredTarget, { source: 'stackoverflow' }>,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const qUrl = `https://api.stackexchange.com/2.3/questions/${encodeURIComponent(target.questionId)}?site=stackoverflow&filter=withbody`
  const qRes = await fetchApiEndpoint('stackoverflow', qUrl, signal, 'application/json')
  if (!qRes.ok) return null
  const qBody = parseJsonBody('stackoverflow', qRes)
  if (typeof qBody.backoff === 'number' && qBody.backoff > 0) {
    pacingFor('stackoverflow').refuse(String(qBody.backoff))
  }
  if (qBody.error_id !== undefined) {
    throw new FetchRefusedError(
      502,
      `${SOURCE_LABEL.stackoverflow} refused the request (${str(qBody.error_message) || String(qBody.error_id)}); search for another source.`,
    )
  }
  const items = Array.isArray(qBody.items) ? qBody.items.map(obj) : []
  if (items.length === 0) return null
  const q = items[0]!
  const title = htmlToText(str(q.title)) || `Question ${target.questionId}`
  const score = num(q.score) ?? 0
  const answerCount = num(q.answer_count) ?? 0
  const isAnswered = q.is_answered === true
  const author = htmlToText(str(obj(q.owner).display_name))
  const tags = Array.isArray(q.tags)
    ? q.tags.filter((t): t is string => typeof t === 'string').slice(0, MAX_LIST_ITEMS)
    : []
  const richToText = (raw: string): string => {
    const blocks: string[] = []
    const withPlaceholders = raw.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_w, c: string) => {
      const idx = blocks.length
      blocks.push(`\n\`\`\`\n${decodeHtmlEntities(c.replace(/<[^>]*>/g, '').trim())}\n\`\`\`\n`)
      return ` __CODE_BLOCK_${idx}__ `
    })
    return htmlToText(withPlaceholders).replace(/__CODE_BLOCK_(\d+)__/g, (_w, i: string) => blocks[Number(i)] ?? '')
  }
  const questionText = clip(richToText(str(q.body)), MAX_BODY_CHARS)

  const lines: string[] = [
    `# ${title}`,
    '',
    `- Question ID: ${target.questionId}`,
    `- Score: ${score}`,
    `- Answers: ${answerCount}${isAnswered ? ' (answered)' : ''}`,
  ]
  if (author) lines.push(`- Asked by: ${author}`)
  if (tags.length > 0) lines.push(`- Tags: ${tags.join(', ')}`)
  if (questionText) lines.push('', '## Question', '', questionText)

  let ansBytes = 0
  if (answerCount > 0) {
    const aUrl = `https://api.stackexchange.com/2.3/questions/${encodeURIComponent(target.questionId)}/answers?order=desc&sort=votes&site=stackoverflow&pagesize=3&filter=withbody`
    const aRes = await fetchApiEndpoint('stackoverflow', aUrl, signal, 'application/json', 'optional')
    if (aRes.ok) {
      ansBytes = aRes.bytes
      try {
        const aBody = parseJsonBody('stackoverflow', aRes)
        if (typeof aBody.backoff === 'number' && aBody.backoff > 0) {
          pacingFor('stackoverflow').refuse(String(aBody.backoff))
        }
        const answers = Array.isArray(aBody.items) ? aBody.items.map(obj) : []
        if (answers.length > 0) {
          lines.push('', '## Top Answers')
          for (const ans of answers.slice(0, 3)) {
            const aScore = num(ans.score) ?? 0
            const accepted = ans.is_accepted === true
            const aAuthor = htmlToText(str(obj(ans.owner).display_name)) || 'user'
            const aText = clip(richToText(str(ans.body)), MAX_COMMENT_CHARS)
            if (aText) {
              lines.push('', `### ${accepted ? 'Accepted Answer' : 'Answer'} (Score: ${aScore}, by ${aAuthor})`, '', aText)
            }
          }
        }
      } catch {
        ansBytes = 0
      }
    }
  }

  return {
    bytes: qRes.bytes + ansBytes,
    code: qRes.status,
    codeText: qRes.statusText,
    content: lines.join('\n'),
    contentType: 'application/json',
    notice: SOURCE_TERMS.stackoverflow,
  }
}

export async function tryStructuredFetch(
  url: string,
  signal: AbortSignal,
): Promise<StructuredResult | null> {
  const target = classifyStructuredFetchUrl(url)
  if (!target) return null
  switch (target.source) {
    case 'github':
      return fetchGitHubStructured(target, signal)
    case 'npm':
      return fetchNpmStructured(target, signal)
    case 'pypi':
      return fetchPypiStructured(target, signal)
    case 'crates':
      return fetchCratesStructured(target, signal)
    case 'arxiv':
      return fetchArxivStructured(target, signal)
    case 'stackoverflow':
      return fetchStackOverflowStructured(target, signal)
  }
}

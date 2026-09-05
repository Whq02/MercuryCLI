import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { armInactivityDeadline, isDeadlineExceeded, type InactivityDeadline } from '../../utils/deadline.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { projectReleases, rateLimitResetMinutes, resolveChannelRepo, type ChannelRelease } from './channelCore.js'
import { downloadReleaseAssets, ghRepoAccess, ghSignIn, listReleases as ghListReleases, type DownloadResult } from './ghRelease.js'

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const LISTING_SILENCE_MS = 30_000
const DOWNLOAD_SILENCE_MS = 90_000
const MAX_LISTING_BYTES = 20 * 1024 * 1024

const packagedRepoUrl = (): string | undefined =>
  typeof MACRO !== 'undefined' && typeof MACRO.PACKAGE_URL === 'string' ? MACRO.PACKAGE_URL : undefined
const runningVersion = (): string => (typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string' ? MACRO.VERSION : 'dev')

export function channelRepo(): ReturnType<typeof resolveChannelRepo> {
  return resolveChannelRepo(flagEnv('MERCURY_UPDATE_CHANNEL_REPO'), packagedRepoUrl())
}

export function channelRepoSlug(): string {
  return channelRepo().slug
}

export function channelApiBaseUrl(): string {
  const pinned = flagEnv('MERCURY_UPDATE_API_BASE_URL')?.trim()
  return (pinned && /^https?:\/\//.test(pinned) ? pinned : DEFAULT_API_BASE_URL).replace(/\/+$/, '')
}


export type ChannelRoadName = 'gh' | 'anonymous'

export type ChannelRoad =
  | { road: 'gh' }
  | { road: 'anonymous'; ghState: 'gh-missing' | 'not-signed-in' | 'not-asked'; ghNote: string }

export function channelRoadFirst(source: ReturnType<typeof resolveChannelRepo>['source']): ChannelRoadName {
  return source === 'override' ? 'gh' : 'anonymous'
}

export async function resolveChannelRoad(): Promise<ChannelRoad> {
  if (channelRoadFirst(channelRepo().source) === 'anonymous') {
    return { road: 'anonymous', ghState: 'not-asked', ghNote: 'the public home needs no sign-in' }
  }
  return ghRoadOrAnonymous()
}

async function ghRoadOrAnonymous(): Promise<ChannelRoad> {
  const signIn = await ghSignIn()
  if (signIn.state === 'ok') return { road: 'gh' }
  return { road: 'anonymous', ghState: signIn.state, ghNote: signIn.note }
}

async function roadAfterRefusal(road: ChannelRoad, access: ChannelAccessRefusal): Promise<ChannelRoad | null> {
  if (road.road !== 'anonymous' || road.ghState !== 'not-asked') return null
  if (access.state !== 'not-visible' && access.state !== 'rate-limited') return null
  return ghRoadOrAnonymous()
}

export function describeChannelRoad(road: ChannelRoadName): string {
  return road === 'gh' ? 'read through your signed-in GitHub CLI' : 'read anonymously — no sign-in needed'
}


export type ChannelAccess =
  | { state: 'ok'; road: ChannelRoadName }
  | { state: 'no-repo-access'; road: 'gh'; note: string; remedy: string }
  | { state: 'not-visible'; road: 'anonymous'; note: string; remedy: string }
  | { state: 'rate-limited'; road: 'anonymous'; note: string; remedy: string; resetMinutes: number | null }
  | { state: 'unreachable'; road: ChannelRoadName; note: string; remedy: string }
  | { state: 'malformed-listing'; road: ChannelRoadName; note: string; remedy: string }

export type ChannelAccessRefusal = Exclude<ChannelAccess, { state: 'ok' }>

const RAISE_LIMIT_REMEDY = 'sign in the GitHub CLI to raise the limit (install gh, then `gh auth login`), or retry after the reset'

type RateLimitedAccess = Extract<ChannelAccess, { state: 'rate-limited' }>
type NotVisibleAccess = Extract<ChannelAccess, { state: 'not-visible' }>
type UnreachableAccess = Extract<ChannelAccess, { state: 'unreachable' }>

function rateLimited(headers: Headers, nowMs: number): RateLimitedAccess {
  const resetMinutes = rateLimitResetMinutes({ rateLimitReset: headers.get('x-ratelimit-reset'), retryAfter: headers.get('retry-after') }, nowMs)
  const when = resetMinutes === null ? 'within the hour' : `in ${resetMinutes} minute${resetMinutes === 1 ? '' : 's'}`
  return {
    state: 'rate-limited',
    road: 'anonymous',
    note: `GitHub's anonymous request limit for this address is used up — it resets ${when}`,
    remedy: RAISE_LIMIT_REMEDY,
    resetMinutes,
  }
}

const isRateLimitStatus = (response: Response): boolean =>
  response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after') !== null))

const discardBody = (response: Response): void => {
  void response.body?.cancel().catch(() => {})
}

function notVisible(slug: string, road: Extract<ChannelRoad, { road: 'anonymous' }>): NotVisibleAccess {
  return {
    state: 'not-visible',
    road: 'anonymous',
    note: `${slug} is not visible without a sign-in — a private channel, or a repository that does not exist (${road.ghNote})`,
    remedy: 'install the GitHub CLI and run `gh auth login` with an account that can see it, then retry; check MERCURY_UPDATE_CHANNEL_REPO if you set one',
  }
}

function unreachable(what: string, error: unknown): UnreachableAccess {
  return {
    state: 'unreachable',
    road: 'anonymous',
    note: isDeadlineExceeded(error) ? error.message : `GitHub could not be reached for the ${what}: ${describeFetchError(error)}`,
    remedy: 'check your network (and any proxy) and rerun `mercury update`',
  }
}

function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  if (cause && typeof cause.code === 'string') return cause.code
  if (cause && typeof cause.message === 'string') return cause.message.slice(0, 120)
  return error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
}


const anonymousHeaders = (accept: string): Record<string, string> => ({
  accept,
  'user-agent': `mercury/${runningVersion()}`,
  'x-github-api-version': '2022-11-28',
})

interface AnonymousGet {
  seam: string
  advice: string
  limitMs: number
  accept: string
}

async function anonymousGet(url: string, opts: AnonymousGet): Promise<{ response: Response; deadline: InactivityDeadline }> {
  const controller = new AbortController()
  const deadline = armInactivityDeadline({
    seam: opts.seam,
    limitMs: opts.limitMs,
    advice: opts.advice,
    onExpire: error => controller.abort(error),
  })
  try {
    const response = await Promise.race([
      getApiFetch()(url, { method: 'GET', headers: anonymousHeaders(opts.accept), redirect: 'follow', signal: controller.signal, ...getProxyFetchOptions() } as RequestInit),
      deadline.expiry,
    ])
    deadline.touch()
    return { response, deadline }
  } catch (error) {
    deadline.cancel()
    throw error
  }
}

async function readBoundedText(response: Response, deadline: InactivityDeadline, maxBytes: number): Promise<string> {
  const body = response.body
  if (!body) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline.expiry])
      if (next.done) break
      deadline.touch()
      total += next.value.byteLength
      if (total > maxBytes) throw new Error(`the release listing exceeds ${maxBytes} bytes`)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

type AnonymousListing = { state: 'ok'; releases: ChannelRelease[] } | { state: 'refused'; access: ChannelAccessRefusal }

async function anonymousListReleases(slug: string, road: Extract<ChannelRoad, { road: 'anonymous' }>): Promise<AnonymousListing> {
  const url = `${channelApiBaseUrl()}/repos/${slug}/releases?per_page=50`
  let got: { response: Response; deadline: InactivityDeadline }
  try {
    got = await anonymousGet(url, { seam: 'release listing', advice: 'check your network and rerun `mercury update`', limitMs: LISTING_SILENCE_MS, accept: 'application/vnd.github+json' })
  } catch (error) {
    return { state: 'refused', access: unreachable('release listing', error) }
  }
  const { response, deadline } = got
  try {
    if (response.status !== 200) discardBody(response)
    if (isRateLimitStatus(response)) return { state: 'refused', access: rateLimited(response.headers, Date.now()) }
    if (response.status === 404) return { state: 'refused', access: notVisible(slug, road) }
    if (response.status !== 200) {
      return {
        state: 'refused',
        access: { state: 'unreachable', road: 'anonymous', note: `GitHub answered HTTP ${response.status} for the release listing of ${slug}`, remedy: 'retry in a moment; if it repeats, report it' },
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(await readBoundedText(response, deadline, MAX_LISTING_BYTES))
    } catch (error) {
      if (isDeadlineExceeded(error)) return { state: 'refused', access: unreachable('release listing', error) }
      raw = undefined
    }
    const releases = projectReleases(raw)
    if (releases === null) {
      return {
        state: 'refused',
        access: { state: 'malformed-listing', road: 'anonymous', note: `the release listing for ${slug} is not a release array`, remedy: 'retry; if it repeats, report it' },
      }
    }
    return { state: 'ok', releases }
  } finally {
    deadline.cancel()
  }
}

export async function checkChannelAccess(slug: string): Promise<ChannelAccess> {
  const road = await resolveChannelRoad()
  if (road.road === 'gh') return ghChannelAccess(slug)
  const probed = await anonymousChannelAccess(slug, road)
  if (probed.state === 'ok') return probed
  const retry = await roadAfterRefusal(road, probed)
  if (retry === null) return probed
  if (retry.road === 'gh') return ghChannelAccess(slug)
  return probed.state === 'not-visible' ? notVisible(slug, retry) : probed
}

async function ghChannelAccess(slug: string): Promise<ChannelAccess> {
  const repo = await ghRepoAccess(slug)
  return repo.state === 'ok' ? { state: 'ok', road: 'gh' } : { state: 'no-repo-access', road: 'gh', note: repo.note, remedy: repo.remedy }
}

async function anonymousChannelAccess(slug: string, road: Extract<ChannelRoad, { road: 'anonymous' }>): Promise<ChannelAccess> {
  let got: { response: Response; deadline: InactivityDeadline }
  try {
    got = await anonymousGet(`${channelApiBaseUrl()}/repos/${slug}`, { seam: 'channel probe', advice: 'check your network', limitMs: LISTING_SILENCE_MS, accept: 'application/vnd.github+json' })
  } catch (error) {
    return unreachable('channel probe', error)
  }
  const { response, deadline } = got
  try {
    discardBody(response)
    if (isRateLimitStatus(response)) return rateLimited(response.headers, Date.now())
    if (response.status === 404) return notVisible(slug, road)
    if (response.status !== 200) {
      return { state: 'unreachable', road: 'anonymous', note: `GitHub answered HTTP ${response.status} for ${slug}`, remedy: 'retry in a moment; if it repeats, report it' }
    }
    return { state: 'ok', road: 'anonymous' }
  } finally {
    deadline.cancel()
  }
}


export type ChannelListing = { state: 'ok'; road: ChannelRoadName; releases: ChannelRelease[] } | { state: 'refused'; access: ChannelAccessRefusal }

export async function listChannelReleases(slug: string): Promise<ChannelListing> {
  const road = await resolveChannelRoad()
  if (road.road === 'anonymous') {
    const listed = await anonymousListReleases(slug, road)
    if (listed.state === 'ok') return { state: 'ok', road: 'anonymous', releases: listed.releases }
    const retry = await roadAfterRefusal(road, listed.access)
    if (retry === null) return listed
    if (retry.road === 'anonymous') {
      return listed.access.state === 'not-visible' ? { state: 'refused', access: notVisible(slug, retry) } : listed
    }
  }
  const repo = await ghRepoAccess(slug)
  if (repo.state !== 'ok') return { state: 'refused', access: { state: 'no-repo-access', road: 'gh', note: repo.note, remedy: repo.remedy } }
  const listed = await ghListReleases(slug)
  if (listed.state !== 'ok') return { state: 'refused', access: { state: 'unreachable', road: 'gh', note: listed.note, remedy: listed.remedy } }
  return { state: 'ok', road: 'gh', releases: listed.releases }
}

export interface ChannelAsset {
  name: string
  url: string | null
}

async function anonymousDownloadAsset(asset: ChannelAsset, destDir: string): Promise<DownloadResult> {
  if (!asset.url) {
    return {
      state: 'failed',
      note: `the release record names no download URL for ${asset.name}`,
      remedy: 'the release publication is incomplete — report it; nothing was activated',
    }
  }
  let got: { response: Response; deadline: InactivityDeadline }
  try {
    got = await anonymousGet(asset.url, { seam: `download of ${asset.name}`, advice: 'check your network and rerun `mercury update`', limitMs: DOWNLOAD_SILENCE_MS, accept: 'application/octet-stream' })
  } catch (error) {
    const why = isDeadlineExceeded(error) ? error.message : `GitHub could not be reached: ${describeFetchError(error)}`
    return { state: 'failed', note: `download of ${asset.name} failed: ${why}`, remedy: 'check your network and rerun `mercury update` — nothing was activated' }
  }
  const { response, deadline } = got
  try {
    if (response.status !== 200) discardBody(response)
    if (isRateLimitStatus(response)) {
      const limited = rateLimited(response.headers, Date.now())
      return { state: 'failed', note: `download of ${asset.name} refused: ${limited.note}`, remedy: limited.remedy }
    }
    if (response.status !== 200 || !response.body) {
      return { state: 'failed', note: `download of ${asset.name} answered HTTP ${response.status}`, remedy: 'the release publication may be incomplete — rerun `mercury update`; if it repeats, report it' }
    }
    const source = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>)
    source.on('data', () => deadline.touch())
    await Promise.race([pipeline(source, createWriteStream(join(destDir, asset.name))), deadline.expiry])
    return { state: 'ok' }
  } catch (error) {
    const why = isDeadlineExceeded(error) ? error.message : describeFetchError(error)
    return { state: 'failed', note: `download of ${asset.name} failed: ${why}`, remedy: 'check your network and rerun `mercury update` — nothing was activated' }
  } finally {
    deadline.cancel()
  }
}

export async function downloadChannelAssets(road: ChannelRoadName, slug: string, tag: string, assets: ChannelAsset[], destDir: string): Promise<DownloadResult> {
  if (road === 'gh') return downloadReleaseAssets(slug, tag, assets.map(a => a.name), destDir)
  for (const asset of assets) {
    const one = await anonymousDownloadAsset(asset, destDir)
    if (one.state !== 'ok') return one
  }
  return { state: 'ok' }
}

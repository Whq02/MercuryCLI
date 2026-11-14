import type { Device, Frame, Page, Viewport } from 'puppeteer-core'
import { resolveBrowserSecret } from './browserSecrets.js'
import { driverVersion, originOf, pageKitOf, type PageIdentity, type PageKit } from './browserSession.js'

const NETWORK_PRESETS = { slow3g: 'Slow 3G', fast3g: 'Fast 3G', slow4g: 'Slow 4G', fast4g: 'Fast 4G' } as const
type NetworkPreset = keyof typeof NETWORK_PRESETS
interface NetworkNumbers {
  download: number
  upload: number
  latency: number
}
interface Geolocation {
  latitude: number
  longitude: number
  accuracy?: number
}
type ColorScheme = 'dark' | 'light' | 'no-preference'
interface Credentials {
  username: string
  password?: string
  secret?: string
}

interface Fields {
  device?: string
  width?: number
  height?: number
  scale?: number
  userAgent?: string
  mobile?: boolean
  touch?: boolean
  landscape?: boolean
  timezone?: string
  locale?: string
  cpuSlowdown?: number
  network?: NetworkPreset | NetworkNumbers
  offline?: boolean
  geolocation?: Geolocation
  colorScheme?: ColorScheme
  reducedMotion?: boolean
  headers?: Record<string, string>
  credentials?: Credentials & { origin: string }
}

type FieldName = keyof Fields
type RequestName = Exclude<FieldName, 'width' | 'height' | 'scale'>
type EmulationRequest = { [K in Exclude<RequestName, 'credentials'>]?: Fields[K] | null } & {
  credentials?: Credentials | null
  reset?: boolean
}

interface EmulationSize {
  width?: number
  height?: number
  scale?: number
}

const FIELD_SHAPES: Record<RequestName | 'reset', string> = {
  device: 'a name from op:"devices"',
  userAgent: 'a string',
  mobile: 'true or false',
  touch: 'true or false',
  landscape: 'true or false',
  timezone: 'a zone name such as Europe/Paris',
  locale: 'a locale such as fr-FR',
  cpuSlowdown: 'a slowdown factor, 1 or more',
  network: `${Object.keys(NETWORK_PRESETS).join(', ')} or {download, upload, latency} in bytes/s and ms`,
  offline: 'true or false',
  geolocation: '{latitude, longitude, accuracy} in degrees and metres',
  colorScheme: 'dark, light or no-preference',
  reducedMotion: 'true or false',
  headers: '{name: value} with string values',
  credentials: "{username, password} or {username, secret} with a registered secret's name",
  reset: 'true',
}
const REQUEST_NAMES = Object.keys(FIELD_SHAPES) as Array<RequestName | 'reset'>

export const EMULATION_FIELD_WORDS = `device (a name from devices), userAgent, mobile, touch, landscape, timezone, locale, cpuSlowdown, network (${Object.keys(NETWORK_PRESETS).join(', ')} or {download, upload, latency} in bytes/s and ms), offline, geolocation {latitude, longitude, accuracy}, colorScheme (dark, light, no-preference), reducedMotion, headers (every request, including other origins), credentials {username, password or secret (a registered name)}, reset`

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function fieldFits(name: RequestName | 'reset', value: unknown): boolean {
  switch (name) {
    case 'device':
    case 'userAgent':
    case 'timezone':
    case 'locale':
      return typeof value === 'string' && value !== ''
    case 'mobile':
    case 'touch':
    case 'landscape':
    case 'offline':
    case 'reducedMotion':
      return typeof value === 'boolean'
    case 'reset':
      return value === true || value === false
    case 'cpuSlowdown':
      return isNumber(value)
    case 'network':
      return (
        (typeof value === 'string' && Object.hasOwn(NETWORK_PRESETS, value)) ||
        (isRecord(value) && isNumber(value.download) && isNumber(value.upload) && isNumber(value.latency) && Object.keys(value).length === 3)
      )
    case 'geolocation':
      return (
        isRecord(value) &&
        isNumber(value.latitude) &&
        isNumber(value.longitude) &&
        (value.accuracy === undefined || isNumber(value.accuracy)) &&
        Object.keys(value).every(key => key === 'latitude' || key === 'longitude' || key === 'accuracy')
      )
    case 'colorScheme':
      return value === 'dark' || value === 'light' || value === 'no-preference'
    case 'headers':
      return isRecord(value) && Object.entries(value).every(([key, held]) => key !== '' && typeof held === 'string')
    case 'credentials':
      return (
        isRecord(value) &&
        typeof value.username === 'string' &&
        value.username !== '' &&
        (typeof value.password === 'string') !== (typeof value.secret === 'string') &&
        Object.keys(value).length === 2
      )
  }
}

export function parseEmulation(raw: unknown): { request: EmulationRequest } | { refusal: string } {
  if (!isRecord(raw)) return { refusal: `emulation takes an object of ${REQUEST_NAMES.join(', ')}` }
  const unknown = Object.keys(raw).filter(key => !Object.hasOwn(FIELD_SHAPES, key))
  if (unknown.length > 0) {
    return { refusal: `emulation takes ${REQUEST_NAMES.join(', ')} — not ${unknown.map(key => JSON.stringify(key)).join(', ')}` }
  }
  for (const name of REQUEST_NAMES) {
    const value = raw[name]
    if (value === undefined || (value === null && name !== 'reset')) continue
    if (!fieldFits(name, value)) return { refusal: `emulation.${name} takes ${FIELD_SHAPES[name]}${name === 'reset' ? '' : ', or null to clear it'}` }
  }
  return { request: raw as EmulationRequest }
}

type Aspect = 'identity' | 'locale' | 'viewport' | 'timezone' | 'cpu' | 'media' | 'network' | 'geolocation' | 'headers' | 'credentials'
const ASPECTS: readonly Aspect[] = ['identity', 'locale', 'timezone', 'cpu', 'media', 'network', 'geolocation', 'headers', 'credentials', 'viewport']
const ASPECT_FIELDS: Record<Aspect, readonly FieldName[]> = {
  identity: ['device', 'userAgent', 'locale'],
  locale: ['locale'],
  viewport: ['device', 'width', 'height', 'scale', 'mobile', 'touch', 'landscape'],
  timezone: ['timezone'],
  cpu: ['cpuSlowdown'],
  media: ['colorScheme', 'reducedMotion'],
  network: ['network', 'offline'],
  geolocation: ['geolocation'],
  headers: ['headers'],
  credentials: ['credentials'],
}
const ASPECT_WORDS: Record<Aspect, string> = {
  identity: 'user agent',
  locale: 'locale',
  viewport: 'viewport',
  timezone: 'timezone',
  cpu: 'cpu',
  media: 'media',
  network: 'network',
  geolocation: 'geolocation',
  headers: 'headers',
  credentials: 'credentials',
}

interface Environment {
  viewport: Viewport
  identity: PageIdentity | null
  languages: string[]
  locale: string | null
  timezone: string
  cpu: number
  media: Array<{ name: string; value: string }>
  network: NetworkNumbers & { offline: boolean }
  geolocation: Geolocation | null
  headers: Record<string, string> | null
  credentials: (Credentials & { origin: string }) | null
}

interface PageEmulation {
  fields: Fields
  environment: Environment | null
  unsettled: Set<Aspect>
  grants: Set<string>
  regrant: ((frame: Frame) => void) | null
  answering: boolean
  credentials: Environment['credentials']
  answered: Set<string>
  usedFor: Set<string>
}

export interface EmulationOutcome {
  refusal?: string
  reloaded: boolean
  stale: boolean
  lines: string[]
  failures: string[]
  notes: string[]
}

const LAUNCH_VIEWPORT = { width: 1280, height: 800 } as const
const emulations = new WeakMap<Page, PageEmulation>()
const grantHolders = new WeakMap<object, Map<string, Set<Page>>>()

function stateOf(page: Page): PageEmulation {
  let state = emulations.get(page)
  if (state === undefined) {
    state = { fields: {}, environment: null, unsettled: new Set(), grants: new Set(), regrant: null, answering: false, credentials: null, answered: new Set(), usedFor: new Set() }
    emulations.set(page, state)
  }
  return state
}

type Catalogue = Readonly<Record<string, Device>>
let driverTables: Promise<{ devices: Catalogue; networks: Readonly<Record<string, NetworkNumbers>> }> | null = null
function tables(): Promise<{ devices: Catalogue; networks: Readonly<Record<string, NetworkNumbers>> }> {
  driverTables ??= import('puppeteer-core').then(driver => ({
    devices: driver.KnownDevices as Catalogue,
    networks: driver.PredefinedNetworkConditions as Readonly<Record<string, NetworkNumbers>>,
  }))
  return driverTables
}

export async function deviceNames(): Promise<string[]> {
  return Object.keys((await tables()).devices).sort()
}

type Metadata = NonNullable<PageIdentity['userAgentMetadata']>

function chromiumHints(
  userAgent: string,
  base: PageIdentity | null,
  platform: string,
  platformVersion: string,
  model: string,
  mobile: boolean,
  architecture: string,
  bitness: string,
): Metadata | undefined {
  const full = /Chrome\/(\d+(?:\.\d+){0,3})/.exec(userAgent)?.[1]
  if (full === undefined || /Version\/|Edge\//.test(userAgent)) return undefined
  const major = full.split('.')[0]!
  if (Number(major) < 89) return undefined
  const fullVersion = full.split('.').length === 4 ? full : `${major}.0.0.0`
  const grease = base?.userAgentMetadata?.brands?.[0] ?? { brand: 'Not(A:Brand', version: '24' }
  const greaseFull = base?.userAgentMetadata?.fullVersionList?.[0] ?? { brand: grease.brand, version: `${grease.version}.0.0.0` }
  const product = /Edg[A-Za-z]*\//.test(userAgent) ? 'Microsoft Edge' : /OPR\//.test(userAgent) ? 'Opera' : 'Google Chrome'
  return {
    brands: [grease, { brand: 'Chromium', version: major }, { brand: product, version: major }],
    fullVersionList: [greaseFull, { brand: 'Chromium', version: fullVersion }, { brand: product, version: fullVersion }],
    fullVersion,
    platform,
    platformVersion,
    architecture,
    bitness,
    model,
    mobile,
    wow64: false,
  }
}

function threeParts(version: string | undefined, fallback: string): string {
  const parts = (version ?? '').split(/[._]/).filter(part => part !== '')
  if (parts.length === 0) return fallback
  while (parts.length < 3) parts.push('0')
  return parts.slice(0, 3).join('.')
}

function derivedIdentity(userAgent: string, base: PageIdentity | null): { platform?: string; userAgentMetadata?: Metadata } {
  const apple = /\b(iPhone|iPad|iPod)\b/.exec(userAgent)?.[1]
  if (apple !== undefined) return { platform: apple }
  if (/Windows Phone|IEMobile/.test(userAgent)) return { platform: 'Win32' }
  const android = /Android ?([\d.]*)/.exec(userAgent)
  if (android !== null) {
    const model = /Android [^;)]*; ([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(userAgent)?.[1]?.trim() ?? ''
    const userAgentMetadata = chromiumHints(userAgent, base, 'Android', threeParts(android[1], '0.0.0'), model, /Mobile/.test(userAgent), '', '')
    return { platform: 'Linux armv81', ...(userAgentMetadata !== undefined ? { userAgentMetadata } : {}) }
  }
  if (/Windows/.test(userAgent)) {
    const userAgentMetadata = chromiumHints(userAgent, base, 'Windows', '10.0.0', '', false, 'x86', '64')
    return { platform: 'Win32', ...(userAgentMetadata !== undefined ? { userAgentMetadata } : {}) }
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) {
    const version = threeParts(/Mac OS X ([\d_.]+)/.exec(userAgent)?.[1], '10.15.7')
    const userAgentMetadata = chromiumHints(userAgent, base, 'macOS', version, '', false, 'arm', '64')
    return { platform: 'MacIntel', ...(userAgentMetadata !== undefined ? { userAgentMetadata } : {}) }
  }
  if (/CrOS|Linux|X11/.test(userAgent)) {
    const arm = /aarch64|armv/.test(userAgent)
    const userAgentMetadata = chromiumHints(userAgent, base, /CrOS/.test(userAgent) ? 'Chrome OS' : 'Linux', '6.5.0', '', false, arm ? 'arm' : 'x86', '64')
    return { platform: arm ? 'Linux aarch64' : 'Linux x86_64', ...(userAgentMetadata !== undefined ? { userAgentMetadata } : {}) }
  }
  return {}
}

function languagesOf(locale: string): string[] {
  const base = locale.split('-')[0]!
  return base === locale ? [locale] : [locale, base]
}

function environmentOf(fields: Fields, kit: PageKit, devices: Catalogue, networks: Readonly<Record<string, NetworkNumbers>>): Environment {
  const device = fields.device !== undefined ? devices[fields.device] : undefined
  const scale = fields.scale ?? device?.viewport.deviceScaleFactor
  const viewport: Viewport = {
    width: fields.width ?? device?.viewport.width ?? LAUNCH_VIEWPORT.width,
    height: fields.height ?? device?.viewport.height ?? LAUNCH_VIEWPORT.height,
    ...(scale !== undefined ? { deviceScaleFactor: scale } : {}),
    ...((fields.mobile ?? device?.viewport.isMobile ?? false) ? { isMobile: true } : {}),
    ...((fields.touch ?? device?.viewport.hasTouch ?? false) ? { hasTouch: true } : {}),
    ...((fields.landscape ?? device?.viewport.isLandscape ?? false) ? { isLandscape: true } : {}),
  }
  const languages = fields.locale !== undefined ? languagesOf(fields.locale) : kit.languages
  const acceptLanguage = fields.locale !== undefined ? languages.join(',') : (kit.identity?.acceptLanguage ?? languages.join(','))
  const userAgent = fields.userAgent ?? device?.userAgent
  const identity: PageIdentity | null =
    userAgent === undefined || userAgent === kit.identity?.userAgent
      ? kit.identity === null
        ? null
        : { ...kit.identity, acceptLanguage }
      : { userAgent, acceptLanguage, ...derivedIdentity(userAgent, kit.identity) }
  const media: Array<{ name: string; value: string }> = []
  if (fields.colorScheme !== undefined) media.push({ name: 'prefers-color-scheme', value: fields.colorScheme })
  if (fields.reducedMotion !== undefined) media.push({ name: 'prefers-reduced-motion', value: fields.reducedMotion ? 'reduce' : 'no-preference' })
  const numbers =
    fields.network === undefined
      ? { download: -1, upload: -1, latency: 0 }
      : typeof fields.network === 'string'
        ? networks[NETWORK_PRESETS[fields.network]]!
        : fields.network
  return {
    viewport,
    identity,
    languages,
    locale: fields.locale ?? null,
    timezone: fields.timezone ?? kit.timeZone,
    cpu: fields.cpuSlowdown ?? 1,
    media,
    network: { download: numbers.download, upload: numbers.upload, latency: numbers.latency, offline: fields.offline ?? false },
    geolocation: fields.geolocation ?? null,
    headers: fields.headers ?? null,
    credentials: fields.credentials ?? null,
  }
}

function sliceOf(aspect: Aspect, environment: Environment): unknown {
  switch (aspect) {
    case 'identity':
      return environment.identity
    case 'locale':
      return environment.locale
    case 'viewport':
      return environment.viewport
    case 'timezone':
      return environment.timezone
    case 'cpu':
      return environment.cpu
    case 'media':
      return environment.media
    case 'network':
      return environment.network
    case 'geolocation':
      return environment.geolocation
    case 'headers':
      return environment.headers
    case 'credentials':
      return environment.credentials
  }
}

function ownSession(kit: PageKit): NonNullable<PageKit['cdp']> {
  if (kit.cdp === null) throw new Error('this page has no protocol session of its own')
  return kit.cdp
}

async function setGrant(page: Page, origin: string, state: 'granted' | 'prompt'): Promise<void> {
  const context = typeof page.browserContext === 'function' ? page.browserContext() : null
  if (context === null || typeof context.setPermission !== 'function') return
  await context.setPermission(origin, { permission: { name: 'geolocation' }, state })
}

async function grantLocation(page: Page, state: PageEmulation): Promise<void> {
  const origin = originOf(page.url())
  if (!origin.startsWith('http') || state.grants.has(origin)) return
  const context: object = typeof page.browserContext === 'function' ? page.browserContext() : page
  const byOrigin = grantHolders.get(context) ?? new Map<string, Set<Page>>()
  grantHolders.set(context, byOrigin)
  const holders = byOrigin.get(origin) ?? new Set<Page>()
  byOrigin.set(origin, holders)
  if (holders.size === 0) await setGrant(page, origin, 'granted')
  holders.add(page)
  state.grants.add(origin)
}

async function releaseLocation(page: Page, state: PageEmulation): Promise<void> {
  const context: object = typeof page.browserContext === 'function' ? page.browserContext() : page
  const byOrigin = grantHolders.get(context)
  for (const origin of state.grants) {
    const holders = byOrigin?.get(origin)
    holders?.delete(page)
    if (holders !== undefined && holders.size === 0) {
      byOrigin!.delete(origin)
      await setGrant(page, origin, 'prompt').catch(() => undefined)
    }
  }
  state.grants.clear()
  if (state.regrant !== null) {
    page.off('framenavigated', state.regrant)
    state.regrant = null
  }
}

type AuthAnswer = { response: 'CancelAuth' } | { response: 'ProvideCredentials'; username: string; password: string }

function authAnswer(state: PageEmulation, requestId: string, challenge: { source?: string; origin: string }): AuthAnswer {
  const held = state.credentials
  if (held === null || challenge.source === 'Proxy' || originOf(challenge.origin) !== held.origin) return { response: 'CancelAuth' }
  if (state.answered.has(requestId)) return { response: 'CancelAuth' }
  state.answered.add(requestId)
  if (state.answered.size > 256) state.answered.delete(state.answered.values().next().value!)
  let password = held.password
  if (password === undefined) {
    const resolved = resolveBrowserSecret(held.secret!, { origin: held.origin })
    if (resolved.state !== 'ok') return { response: 'CancelAuth' }
    password = resolved.value
  }
  state.usedFor.add(held.origin)
  return { response: 'ProvideCredentials', username: held.username, password }
}

async function answerChallenges(kit: PageKit, state: PageEmulation, on: boolean): Promise<void> {
  const own = ownSession(kit)
  kit.fetchHeld = on
  if (!on) {
    if (state.answering) await own.send('Fetch.disable')
    return
  }
  if (!state.answering) {
    own.on('Fetch.requestPaused', event => {
      void own.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => undefined)
    })
    own.on('Fetch.authRequired', event => {
      void own
        .send('Fetch.continueWithAuth', { requestId: event.requestId, authChallengeResponse: authAnswer(state, event.requestId, event.authChallenge) })
        .catch(() => undefined)
    })
    state.answering = true
  }
  await own.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] })
}

async function applyAspect(aspect: Aspect, page: Page, kit: PageKit, environment: Environment, state: PageEmulation): Promise<boolean> {
  switch (aspect) {
    case 'headers':
      await page.setExtraHTTPHeaders(environment.headers ?? {})
      return false
    case 'credentials':
      state.credentials = environment.credentials
      await answerChallenges(kit, state, environment.credentials !== null)
      return false
    case 'identity':
      if (environment.identity !== null) await ownSession(kit).send('Emulation.setUserAgentOverride', environment.identity)
      return false
    case 'locale':
      await ownSession(kit).send('Emulation.setLocaleOverride', environment.locale === null ? {} : { locale: environment.locale })
      return false
    case 'viewport': {
      let navigated = false
      const watch = (frame: Frame): void => {
        if (frame.parentFrame() === null) navigated = true
      }
      page.on('framenavigated', watch)
      try {
        await page.setViewport(environment.viewport)
      } catch (err) {
        if (/Emulation\./.test((err as Error).message ?? '')) throw err
        throw Object.assign(new Error(`the size is set, and the reload the browser needs for mobile and touch failed: ${(err as Error).message} — op:"reload" tries it again`), { settled: true })
      } finally {
        page.off('framenavigated', watch)
      }
      return navigated
    }
    case 'timezone':
      await ownSession(kit).send('Emulation.setTimezoneOverride', { timezoneId: '' })
      await ownSession(kit).send('Emulation.setTimezoneOverride', { timezoneId: environment.timezone })
      return false
    case 'cpu':
      await ownSession(kit).send('Emulation.setCPUThrottlingRate', { rate: environment.cpu })
      return false
    case 'media':
      await ownSession(kit).send('Emulation.setEmulatedMedia', { features: environment.media })
      return false
    case 'network':
      await page.emulateNetworkConditions(environment.network)
      return false
    case 'geolocation': {
      if (environment.geolocation === null) {
        await ownSession(kit).send('Emulation.clearGeolocationOverride')
        await releaseLocation(page, state)
        return false
      }
      const { latitude, longitude, accuracy = 0 } = environment.geolocation
      await ownSession(kit).send('Emulation.setGeolocationOverride', { latitude, longitude, accuracy })
      await grantLocation(page, state)
      if (state.regrant === null) {
        state.regrant = (frame: Frame): void => {
          if (frame.parentFrame() === null) void grantLocation(page, state).catch(() => undefined)
        }
        page.on('framenavigated', state.regrant)
        page.once('close', () => void releaseLocation(page, state).catch(() => undefined))
      }
      return false
    }
  }
}

function browserWords(err: unknown): string {
  const message = (err as Error)?.message ?? String(err)
  return message.replace(/^Protocol error \([A-Za-z.]+\): /, '')
}

function networkWords(fields: Fields, environment: Environment): string {
  const { download, upload, latency, offline } = environment.network
  const throttle =
    fields.network === undefined
      ? null
      : `${typeof fields.network === 'string' ? `${fields.network}: ` : ''}${download} B/s down, ${upload} B/s up, ${latency} ms latency`
  return [throttle, offline ? 'offline' : fields.offline === false ? 'online' : null].filter(Boolean).join(' · ')
}

function identityWords(identity: PageIdentity): string {
  const hints = identity.userAgentMetadata
  const hintWords =
    hints === undefined
      ? 'client hints not sent'
      : `client hints ${hints.platform}${hints.mobile ? ', mobile' : ''}${hints.model ? `, model ${hints.model}` : ''}`
  return `${identity.userAgent} — platform ${identity.platform ?? "the browser's own"}; ${hintWords}`
}

function describe(state: PageEmulation, kit: PageKit | null): string[] {
  const { fields, environment } = state
  if (environment === null) return []
  const lines: string[] = []
  if (fields.device !== undefined) lines.push(`device: ${fields.device} (puppeteer-core ${driverVersion()})`)
  if (environment.identity !== null && environment.identity.userAgent !== kit?.identity?.userAgent) {
    lines.push(`user agent: ${identityWords(environment.identity)}`)
  }
  if (fields.timezone !== undefined) lines.push(`timezone: ${fields.timezone}`)
  if (fields.locale !== undefined) lines.push(`locale: ${fields.locale} (languages ${environment.languages.join(', ')})`)
  if (fields.cpuSlowdown !== undefined) lines.push(`cpu: ${fields.cpuSlowdown}x slowdown`)
  if (fields.network !== undefined || fields.offline !== undefined) lines.push(`network: ${networkWords(fields, environment)}`)
  if (fields.geolocation !== undefined) {
    const { latitude, longitude, accuracy } = fields.geolocation
    lines.push(
      `geolocation: ${latitude}, ${longitude}${accuracy !== undefined ? ` (±${accuracy} m)` : ''}; the browser's own location permission is granted to ${
        state.grants.size > 0 ? [...state.grants].join(', ') : 'no web origin yet'
      }`,
    )
  }
  if (environment.media.length > 0) lines.push(`media: ${environment.media.map(feature => `${feature.name} ${feature.value}`).join('; ')}`)
  if (fields.headers !== undefined) lines.push(`headers: ${Object.keys(fields.headers).map(name => name.toLowerCase()).join(', ') || 'none'}`)
  if (fields.credentials !== undefined) {
    const { username, origin, secret } = fields.credentials
    lines.push(`credentials: ${username} answers ${origin} only (${secret !== undefined ? `secret ${secret}` : 'password withheld'})`)
  }
  return lines
}

function fieldWords(name: FieldName, value: unknown): string {
  if (name === 'credentials') return value === undefined ? 'credentials cleared' : `credentials of ${(value as Credentials).username}`
  if (name === 'headers') return value === undefined ? 'headers cleared' : `headers ${Object.keys(value as object).join(', ')}`
  return `${name} ${JSON.stringify(value ?? null)}`
}

const GEOMETRY: readonly FieldName[] = ['width', 'height', 'scale', 'mobile', 'touch', 'landscape', 'userAgent']

function merged(before: Fields, request: EmulationRequest, size: EmulationSize, origin: string): Fields {
  const next: Fields = request.reset === true ? {} : { ...before }
  if (typeof request.device === 'string') {
    for (const name of GEOMETRY) delete next[name]
    next.device = request.device
  }
  for (const name of Object.keys(request) as Array<RequestName | 'reset'>) {
    if (name === 'reset' || name === 'device') continue
    const value = request[name]
    if (value === null) delete next[name]
    else if (value !== undefined) (next as Record<string, unknown>)[name] = name === 'credentials' ? { ...(value as Credentials), origin } : value
  }
  if (request.device === null) delete next.device
  if (size.width !== undefined) next.width = size.width
  if (size.height !== undefined) next.height = size.height
  if (size.scale !== undefined) next.scale = size.scale
  return next
}

async function settle(page: Page, kit: PageKit, state: PageEmulation, next: Fields, held: ReadonlySet<Aspect> = new Set()): Promise<EmulationOutcome> {
  const { devices, networks } = await tables()
  const before = state.fields
  const from = state.environment ?? environmentOf(before, kit, devices, networks)
  const differs = (aspect: Aspect, environment: Environment): boolean =>
    JSON.stringify(sliceOf(aspect, environment)) !== JSON.stringify(sliceOf(aspect, from))
  const target = environmentOf(next, kit, devices, networks)
  const pending: Aspect[] = ASPECTS.filter(aspect => !held.has(aspect) && (state.unsettled.has(aspect) || differs(aspect, target)))
  for (const aspect of held) {
    if (differs(aspect, target)) state.unsettled.add(aspect)
  }
  const tried = new Set<Aspect>()
  const failures: string[] = []
  let reloaded = false
  while (pending.length > 0) {
    const aspect = pending.shift()!
    const environment = environmentOf(next, kit, devices, networks)
    try {
      reloaded = (await applyAspect(aspect, page, kit, environment, state)) || reloaded
      state.unsettled.delete(aspect)
    } catch (err) {
      if ((err as { settled?: boolean }).settled === true) {
        failures.push((err as Error).message)
        continue
      }
      if (tried.has(aspect)) {
        state.unsettled.add(aspect)
        failures.push(`${ASPECT_WORDS[aspect]}: the earlier value could not be put back either (${browserWords(err)}) — the next emulation call applies it again`)
        continue
      }
      tried.add(aspect)
      const reverted = ASPECT_FIELDS[aspect].filter(name => JSON.stringify(next[name]) !== JSON.stringify(before[name]))
      failures.push(
        `${ASPECT_WORDS[aspect]} NOT applied (${reverted.map(name => fieldWords(name, next[name])).join(', ') || 'unchanged fields'}): ${browserWords(err)} — the earlier value stays`,
      )
      for (const name of reverted) {
        if (before[name] === undefined) delete next[name]
        else (next as Record<string, unknown>)[name] = before[name]
      }
      for (const other of ASPECTS) {
        if (pending.includes(other)) continue
        if (other === aspect || ASPECT_FIELDS[other].some(name => reverted.includes(name))) pending.push(other)
      }
    }
  }
  state.fields = next
  state.environment = environmentOf(next, kit, devices, networks)
  kit.presented = { identity: state.environment.identity, languages: state.environment.languages, timeZone: state.environment.timezone, locale: state.environment.locale }
  const stale = !reloaded && originOf(page.url()).startsWith('http') && state.environment.identity?.userAgent !== from.identity?.userAgent
  const notes: string[] = []
  const earlier = before.credentials
  if (earlier !== undefined && state.usedFor.has(earlier.origin) && JSON.stringify(earlier) !== JSON.stringify(next.credentials)) {
    notes.push(
      `${next.credentials === undefined ? 'no challenge is answered from now on' : 'new challenges get the new credentials'}; what the browser already answered for ${earlier.origin} stays answered until this browser closes`,
    )
  }
  return { reloaded, stale, lines: describe(state, kit), failures, notes }
}

export async function applyEmulation(page: Page, request: EmulationRequest, size: EmulationSize, origin = ''): Promise<EmulationOutcome> {
  const kit = pageKitOf(page)
  if (kit === null) return { refusal: 'this page was not prepared for emulation', reloaded: false, stale: false, lines: [], failures: [], notes: [] }
  if (typeof request.device === 'string') {
    const names = await deviceNames()
    if (!names.includes(request.device)) {
      const head = request.device.toLowerCase().split(/\s+/)[0] ?? ''
      const near = head === '' ? [] : names.filter(name => name.toLowerCase().includes(head)).slice(0, 6)
      return {
        refusal: `no device named ${JSON.stringify(request.device)} in puppeteer-core ${driverVersion()}${near.length > 0 ? ` (near: ${near.join(', ')})` : ''} — op:"devices" lists the ${names.length} names`,
        reloaded: false,
        stale: false,
        lines: [],
        failures: [],
        notes: [],
      }
    }
  }
  const state = stateOf(page)
  return settle(page, kit, state, merged(state.fields, request, size, origin))
}

export function notePlainSize(page: Page, width: number, height: number, scale: number | undefined): void {
  const state = stateOf(page)
  state.fields = { ...state.fields, width, height }
  if (scale === undefined) delete state.fields.scale
  else state.fields.scale = scale
  if (state.environment !== null) {
    state.environment = { ...state.environment, viewport: { width, height, ...(scale !== undefined ? { deviceScaleFactor: scale } : {}) } }
  }
}

export function heldDevice(page: Page): { device: string | null } | null {
  const fields = emulations.get(page)?.fields
  if (fields === undefined) return null
  if (fields.device !== undefined) return { device: fields.device }
  return fields.mobile !== undefined || fields.touch !== undefined || fields.landscape !== undefined ? { device: null } : null
}

export function emulationActive(page: Page): boolean {
  const fields = emulations.get(page)?.fields
  if (fields === undefined) return false
  return (Object.keys(fields) as FieldName[]).some(name => name !== 'width' && name !== 'height' && name !== 'scale')
}

export function emulationLines(page: Page): string[] {
  const state = emulations.get(page)
  return state === undefined ? [] : describe(state, pageKitOf(page))
}

export function emulationSummary(page: Page): string {
  const fields = emulations.get(page)?.fields ?? {}
  const parts: string[] = []
  if (fields.device !== undefined) parts.push(`device ${fields.device}`)
  if (fields.userAgent !== undefined) parts.push('user agent')
  for (const name of ['mobile', 'touch', 'landscape', 'offline', 'reducedMotion'] as const) {
    if (fields[name] !== undefined) parts.push(`${name} ${String(fields[name])}`)
  }
  for (const name of ['timezone', 'locale', 'colorScheme'] as const) {
    if (fields[name] !== undefined) parts.push(`${name} ${fields[name]}`)
  }
  if (fields.cpuSlowdown !== undefined) parts.push(`cpu ${fields.cpuSlowdown}x`)
  if (fields.network !== undefined) parts.push(`network ${typeof fields.network === 'string' ? fields.network : 'custom'}`)
  if (fields.geolocation !== undefined) parts.push(`geolocation ${fields.geolocation.latitude}, ${fields.geolocation.longitude}`)
  if (fields.headers !== undefined) parts.push('headers')
  if (fields.credentials !== undefined) parts.push(`credentials for ${fields.credentials.origin}`)
  return parts.join(', ')
}

export async function carryEmulation(from: Page, to: Page): Promise<EmulationOutcome | null> {
  const earlier = emulations.get(from)
  const kit = pageKitOf(to)
  if (earlier === undefined || kit === null || !emulationActive(from)) return null
  return settle(to, kit, stateOf(to), { ...earlier.fields })
}

export async function inheritEmulation(from: Page, to: Page, reloadSafe: boolean): Promise<EmulationOutcome | null> {
  const earlier = emulations.get(from)
  const kit = pageKitOf(to)
  if (earlier === undefined || kit === null || !emulationActive(from)) return null
  const { devices, networks } = await tables()
  const state = stateOf(to)
  const next: Fields = { ...earlier.fields }
  const baseline = environmentOf({}, kit, devices, networks)
  const born = kit.born
  state.environment = born === null ? baseline : { ...baseline, identity: born.identity, languages: born.languages, locale: born.locale, timezone: born.timeZone }
  const wanted = environmentOf(next, kit, devices, networks).viewport
  const reloads = Boolean(wanted.isMobile) !== Boolean(baseline.viewport.isMobile) || Boolean(wanted.hasTouch) !== Boolean(baseline.viewport.hasTouch)
  if (reloadSafe || !reloads) return settle(to, kit, state, next)
  const outcome = await settle(to, kit, state, next, new Set<Aspect>(['viewport']))
  outcome.notes.push('its size, mobile and touch did not come: this tab holds the answer to a form post, and applying them reloads the page, which would send the form again — op:"viewport" on this tab applies them when that is safe')
  return outcome
}

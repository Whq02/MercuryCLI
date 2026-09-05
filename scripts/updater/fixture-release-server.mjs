#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

export function startFixtureReleaseServer(opts) {
  const fixtures = opts.fixtures
  const log = opts.log ?? null
  const visibility = opts.visibility ?? 'public'
  const rateLimit = opts.rateLimit === true
  const rateResetSeconds = Number.isFinite(opts.rateResetSeconds) ? opts.rateResetSeconds : 1500
  const skipSums = opts.skipSums === true

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (log) {
      const auth = req.headers.authorization ? 'present' : 'absent'
      appendFileSync(log, `${req.method} ${path}${url.search} authorization=${auth} user-agent=${req.headers['user-agent'] ?? '(none)'}\n`)
    }
    if (req.method !== 'GET') return sendJson(res, 405, { message: 'method not allowed' })
    const segments = path.split('/').filter(Boolean).map(s => decodeURIComponent(s))

    if (segments[0] === 'repos' && segments.length >= 3) {
      if (rateLimit) {
        const reset = Math.floor(Date.now() / 1000) + rateResetSeconds
        return sendJson(
          res,
          403,
          { message: 'API rate limit exceeded for this address. (fixture)', documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting' },
          { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60', 'x-ratelimit-reset': String(reset) },
        )
      }
      if (visibility === 'private') return sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })
      const owner = segments[1]
      const repo = segments[2]
      if (segments.length === 3) return sendJson(res, 200, { full_name: `${owner}/${repo}`, private: false })
      if (segments.length === 4 && segments[3] === 'releases') {
        const file = join(fixtures, 'releases.json')
        if (!existsSync(file)) return sendJson(res, 404, { message: 'Not Found' })
        let releases
        try {
          releases = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          return sendJson(res, 500, { message: 'fixture releases.json unreadable' })
        }
        const host = req.headers.host ?? `127.0.0.1:${server.address().port}`
        const base = `http://${host}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download`
        const projected = (Array.isArray(releases) ? releases : []).map(r => ({
          ...r,
          assets: (r.assets ?? []).map(a => ({
            ...a,
            browser_download_url: `${base}/${encodeURIComponent(r.tag_name ?? '')}/${encodeURIComponent(a.name ?? '')}`,
          })),
        }))
        return sendJson(res, 200, projected, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' })
      }
      return sendJson(res, 404, { message: 'Not Found' })
    }

    if (segments.length === 6 && segments[2] === 'releases' && segments[3] === 'download') {
      const tag = segments[4]
      const name = segments[5]
      res.writeHead(302, { location: `/objects/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` })
      return res.end()
    }

    if (segments.length === 3 && segments[0] === 'objects') {
      const tag = segments[1]
      const name = segments[2]
      if (!SAFE_SEGMENT.test(tag) || !SAFE_SEGMENT.test(name)) return sendJson(res, 400, { message: 'bad asset path' })
      if (skipSums && name === 'SHA256SUMS.txt') return sendJson(res, 404, { message: 'Not Found' })
      const file = join(fixtures, 'assets', tag, name)
      if (!existsSync(file)) return sendJson(res, 404, { message: 'Not Found' })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(statSync(file).size) })
      return createReadStream(file).pipe(res)
    }

    return sendJson(res, 404, { message: 'Not Found' })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const arg = name => {
    const i = process.argv.indexOf(name)
    return i !== -1 ? process.argv[i + 1] : undefined
  }
  const fixtures = arg('--fixtures')
  if (!fixtures) {
    console.error('usage: node fixture-release-server.mjs --fixtures <dir> [--port N] [--log <file>]')
    process.exit(2)
  }
  const started = await startFixtureReleaseServer({
    fixtures,
    port: Number(arg('--port') ?? 0),
    log: arg('--log') ?? process.env.FIXTURE_LOG,
    visibility: process.env.FIXTURE_VISIBILITY === 'private' ? 'private' : 'public',
    rateLimit: process.env.FIXTURE_RATE_LIMIT === '1',
    rateResetSeconds: Number(process.env.FIXTURE_RATE_RESET_S ?? 1500),
    skipSums: process.env.FIXTURE_SKIP_SUMS === '1',
  })
  console.log(started.url)
}

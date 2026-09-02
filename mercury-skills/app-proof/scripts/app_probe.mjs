#!/usr/bin/env node
// Readiness and page probes for a running web app, with no dependencies.
//
//   app_probe.mjs wait <url> [--timeout-ms 60000] [--interval-ms 500]
//   app_probe.mjs page <url>
//   app_probe.mjs --self-test
//
// `wait` exits 0 once the URL answers with any HTTP status below 500, 1 on
// timeout. `page` prints status, title, counts and the first visible error
// text, exiting 0 for 2xx/3xx and 1 otherwise.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

export async function waitForReady(url, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.min(5000, intervalMs * 4)) })
      if (res.status < 500) return { ready: true, status: res.status }
      lastError = `HTTP ${res.status}`
    } catch (e) {
      lastError = e?.cause?.code ?? e?.name ?? String(e)
    }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return { ready: false, lastError }
}

export function summarizeHtml(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
  const forms = (html.match(/<form\b/gi) ?? []).length
  const links = (html.match(/<a\b[^>]*href=/gi) ?? []).length
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  const error = /\b(error|exception|cannot|failed|not found)\b[^.\n]{0,80}/i.exec(text)?.[0]?.replace(/\s+/g, ' ').trim() ?? ''
  return { title, forms, links, error }
}

export async function probePage(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const html = await res.text()
  return { status: res.status, finalUrl: res.url, ...summarizeHtml(html) }
}

async function selfTest() {
  const server = createServer((req, res) => {
    if (req.url === '/boom') {
      res.writeHead(500, { 'content-type': 'text/html' })
      res.end('<html><title>Oops</title><body>Internal error: database unavailable</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><head><title>Notes</title></head><body><form></form><a href="/a">a</a><a href="/b">b</a></body></html>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const w = await waitForReady(base, { timeoutMs: 5000, intervalMs: 50 })
    const ok = await probePage(base)
    const bad = await probePage(`${base}/boom`)
    const dead = await waitForReady('http://127.0.0.1:9/', { timeoutMs: 400, intervalMs: 100 })
    const pass =
      w.ready && ok.status === 200 && ok.title === 'Notes' && ok.forms === 1 && ok.links === 2 && ok.error === '' &&
      bad.status === 500 && /database unavailable/.test(bad.error) && dead.ready === false
    console.log(`self-test: ${pass ? 'PASS' : 'FAIL'}`)
    if (!pass) console.log(JSON.stringify({ w, ok, bad, dead }, null, 2))
    return pass ? 0 : 1
  } finally {
    server.close()
  }
}

function opt(argv, name, fallback) {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : Number(argv[i + 1])
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  if (argv.includes('--self-test')) process.exit(await selfTest())
  const [mode, url] = argv
  if (!url || !['wait', 'page'].includes(mode)) {
    console.error('usage: app_probe.mjs wait|page <url> [--timeout-ms N] [--interval-ms N]')
    process.exit(2)
  }
  if (mode === 'wait') {
    const r = await waitForReady(url, { timeoutMs: opt(argv, '--timeout-ms', 60000), intervalMs: opt(argv, '--interval-ms', 500) })
    console.log(r.ready ? `ready: ${url} (HTTP ${r.status})` : `not ready: ${url} (${r.lastError})`)
    process.exit(r.ready ? 0 : 1)
  }
  try {
    const p = await probePage(url)
    console.log(`status: ${p.status}${p.finalUrl !== url ? ` (→ ${p.finalUrl})` : ''}`)
    console.log(`title: ${p.title || '(none)'}`)
    console.log(`forms: ${p.forms}  links: ${p.links}`)
    if (p.error) console.log(`first error text: ${p.error}`)
    process.exit(p.status < 400 ? 0 : 1)
  } catch (e) {
    console.error(`page probe failed: ${e.message}`)
    process.exit(1)
  }
}

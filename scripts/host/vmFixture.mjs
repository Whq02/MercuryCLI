import { createServer } from 'node:http'

export async function vmFixture(vendor, prefix, route) {
  const key = 'fixture-' + vendor + '-key'
  const requests = []
  const state = { noStock: false, createStatus: 0, creates: 0, deletes: 0, keyCreates: 0, pods: new Map(), keys: [], bootReads: 1, holdTerminate: false, badRead: false, badList: false, ambiguousCreate: false, mismatchKey: false, pageSize: 1, failNext: null }
  const server = createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      const url = new URL(req.url, 'http://127.0.0.1')
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, body, headers: req.headers })
      const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
      const text = (value = '', status = 200) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(value) }
      const fail = (status, message) => json({ message: message + ' ' + key }, status)
      const failure = state.failNext
      if (failure && failure.route === req.method + ' ' + url.pathname && failure.times-- > 0) { fail(failure.status, 'fixture refusal'); return }
      await route({ req, res, url, path: url.pathname, method: req.method, body, json, text, fail, key, state })
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  return { key, requests, state, origin, baseUrl: origin + prefix, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

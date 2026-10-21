import { createServer } from 'node:http'

export const videoBytes = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAE4gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAqB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAE4gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAABOIAACAAAABAAAAAAIYbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABw21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYNzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMiBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UlsBEAAAAMAQAAAAwCDxIllgAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAE0AAAAAAAAAAYc3R0cwAAAAAAAAABAAAABQAAQAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAADhjdHRzAAAAAAAAAAUAAAABAACAAAAAAAEAAUAAAAAAAQAAgAAAAAABAAAAAAAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAFAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAAC0QAAAA0AAAAMAAAADAAAAAwAAAAUc3RjbwAAAAAAAAABAAADpQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDIAAAAIZnJlZQAAAwptZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAcZYiEABf//u6CvgU3X8QPwzzx+tAhXPjk9cR/wQAAAAlBmiRsQV/+1uAAAAAIQZ5CeILfGzEAAAAIAZ5hdEFfHDAAAAAIAZ5jakFfHDE=', 'base64')

export async function startVideoFixture() {
  const jobs = new Map()
  const requests = []
  const downloads = []
  const polls = []
  let baseUrl
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, baseUrl)
    if (url.pathname.startsWith('/files/')) {
      downloads.push({ path: url.pathname, authorization: req.headers.authorization })
      if (url.pathname.endsWith('/expired')) { res.writeHead(403); res.end('signed URL expired'); return }
      res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(videoBytes); return
    }
    if (req.headers.authorization !== 'Bearer video-proof-key') {
      json(res, 401, { type: 'error', error: { type: 'authorized_error', message: 'fixture authentication refused (1004)', http_code: '401' } }); return
    }
    if (url.pathname === '/v2/video_generation' && req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const id = `task-${jobs.size + 1}`
      requests.push(body)
      jobs.set(id, { body, queries: 0, times: [Date.now()] })
      json(res, 200, { task_id: id }); return
    }
    if (url.pathname.startsWith('/v2/query/video_generation/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1))
      const job = jobs.get(id)
      if (!job) { json(res, 400, { error: { message: 'invalid task_id' } }); return }
      job.queries++
      job.times.push(Date.now())
      polls.push(id)
      const prompt = job.body.content[0].text
      if (prompt === 'pending forever') { json(res, 200, { task: { id, status: 'running' } }); return }
      if (job.queries === 1) { json(res, 200, { task: { id, status: 'queued' } }); return }
      if (prompt === 'vendor failure') { json(res, 200, { task: { id, status: 'failed', error: { code: '1026', message: 'video description contains sensitive content' } } }); return }
      const expired = prompt === 'expired URL' && job.queries === 2
      json(res, 200, { task: { id, model: job.body.model, status: 'succeeded', content: { url: `${baseUrl}/files/${id}/${expired ? 'expired' : 'fresh'}` }, duration: job.body.duration, resolution: job.body.resolution, ratio: job.body.ratio, usage: { total_seconds: job.body.duration, input_seconds: 0, output_seconds: job.body.duration, input_image_count: job.body.content.filter(item => item.type === 'image_url').length } } }); return
    }
    json(res, 404, { error: { message: 'fixture route not found' } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, jobs, requests, downloads, polls, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

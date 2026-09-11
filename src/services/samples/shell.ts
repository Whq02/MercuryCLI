import { sampleStateWord, type SampleShellInput } from './contracts.js'

export function renderSampleShell(input: SampleShellInput): string {
  const { record, versions, token } = input
  const inline = input.inline === true
  const latest = record.latestVersion
  const title = escapeHtml(record.title)
  const ordered = [...versions].sort((a, b) => b.n - a.n)
  const links = ordered
    .map(v =>
      inline
        ? `<a href="#v${v.n}">v${v.n}</a>`
        : `<a href="/s/${escapeHtml(record.id)}/v/${v.n}.html?t=${escapeHtml(token ?? '')}">v${v.n}</a>`,
    )
    .join(' ')
  const frames = inline
    ? ordered
        .map(v => {
          const html = input.versionHtml?.[v.n] ?? ''
          return [
            `<section id="v${v.n}">`,
            `<h2>version ${v.n}</h2>`,
            `<iframe title="${title} v${v.n}" srcdoc="${escapeHtml(html)}"></iframe>`,
            '</section>',
          ].join('\n')
        })
        .join('\n')
    : `<iframe title="${title} v${latest}" src="/s/${escapeHtml(record.id)}/v/${latest}.html?t=${escapeHtml(token ?? '')}"></iframe>`
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title} · Samples</title>`,
    '<style>',
    'body { margin: 0; font: 14px/1.4 system-ui, sans-serif; }',
    'header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid #8884; }',
    'header h1 { font-size: 15px; margin: 0; }',
    'header nav a { margin-right: 8px; }',
    'section h2 { font-size: 13px; margin: 10px 14px 4px; }',
    'iframe { display: block; width: 100%; height: calc(100vh - 48px); border: 0; background: #fff; }',
    '</style>',
    '</head>',
    '<body>',
    `<header><h1>${title}</h1><span>version ${latest} · ${escapeHtml(sampleStateWord(record.state))}</span><nav>${links}</nav></header>`,
    frames,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

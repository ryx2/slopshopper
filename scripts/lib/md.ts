// A small, safe Markdown-to-HTML converter for community READMEs. Raw HTML in
// the source is escaped, except <img> tags, which become images with http(s)
// sources only. Relative links and images resolve against a base URL pair.

import { esc } from './render'

export type MdOptions = { rawBase?: string; blobBase?: string }

const safeUrl = (u: string) => (/^(https?:)?\/\//i.test(u) || /^(mailto:|#)/.test(u) ? u : null)

function resolveUrl(u: string, base: string | undefined): string | null {
  const trimmed = u.trim().replace(/^<|>$/g, '')
  const ok = safeUrl(trimmed)
  if (ok) return ok
  if (/^[a-z]+:/i.test(trimmed)) return null
  if (!base) return null
  return base.replace(/\/$/, '') + '/' + trimmed.replace(/^\.\//, '').replace(/^\//, '')
}

function inline(s: string, o: MdOptions): string {
  // escape first; the patterns below only ever insert tags we wrote
  let out = esc(s)
  out = out.replace(/&lt;img\s+[^&]*?src=(?:&quot;|')([^&']+)(?:&quot;|')[^&]*?&gt;/gi, (_, src) => {
    const u = resolveUrl(String(src), o.rawBase)
    return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : ''
  })
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, src) => {
    const u = resolveUrl(String(src), o.rawBase)
    return u ? `<img src="${esc(u)}" alt="${alt}" loading="lazy">` : alt
  })
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, href) => {
    const u = resolveUrl(String(href), o.blobBase)
    return u ? `<a href="${esc(u)}" rel="nofollow noopener" target="_blank">${text}</a>` : text
  })
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
  out = out.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/(^|\s)(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_, pre, url) => `${pre}<a href="${esc(url)}" rel="nofollow noopener" target="_blank">${esc(url)}</a>`)
  return out
}

export function markdown(src: string, o: MdOptions = {}): string {
  const lines = src.replace(/\r/g, '').split('\n')
  const out: string[] = []
  let i = 0
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), o)}</p>`)
    para = []
  }
  while (i < lines.length) {
    const l = lines[i]!
    const fence = /^\s*(```|~~~)\s*([\w-]*)/.exec(l)
    if (fence) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) code.push(lines[i++]!)
      i++
      out.push(`<pre><code${fence[2] ? ` class="lang-${esc(fence[2])}"` : ''}>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(l)
    if (h) {
      flush()
      const n = Math.min(6, h[1]!.length + 1)
      out.push(`<h${n}>${inline(h[2]!, o)}</h${n}>`)
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush()
      out.push('<hr>')
      i++
      continue
    }
    if (/^\s*>/.test(l)) {
      flush()
      const q: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) q.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${markdown(q.join('\n'), o)}</blockquote>`)
      continue
    }
    if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      flush()
      const ordered = /^\s*\d+[.)]\s+/.test(l)
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]!) || /^\s*\d+[.)]\s+/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const cur = lines[i]!
        if (/^\s*[-*+]\s+/.test(cur) || /^\s*\d+[.)]\s+/.test(cur)) items.push(cur.replace(/^\s*([-*+]|\d+[.)])\s+/, ''))
        else items[items.length - 1] += ' ' + cur.trim()
        i++
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li>${inline(it.replace(/^\[([ x])\]\s*/i, (_, c) => (c === ' ' ? '☐ ' : '☑ ')), o)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush()
      const header = l.split('|').slice(1, -1).map(c => c.trim())
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(lines[i++]!.split('|').slice(1, -1).map(c => c.trim()))
      out.push(`<table><thead><tr>${header.map(c => `<th>${inline(c, o)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c, o)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    if (/^\s*<(details|summary|\/details|\/summary|p|\/p|div|\/div|br|center|\/center|picture|\/picture|source)\b/i.test(l)) {
      // layout-only HTML: keep images inside, drop the tag
      const imgs = inline(l, o)
      if (imgs.includes('<img')) {
        flush()
        out.push(`<p>${imgs.replace(/&lt;[^&]*&gt;/g, '')}</p>`)
      }
      i++
      continue
    }
    if (l.trim() === '') {
      flush()
      i++
      continue
    }
    para.push(l.trim())
    i++
  }
  flush()
  return out.join('\n')
}

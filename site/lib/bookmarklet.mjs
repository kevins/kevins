// Finding the bookmarklet a repository ships, and checking it before it becomes the href of a drag button.
//
// A bookmarklet file holds one javascript: URL, as the tools' own build scripts write it (percent-encoded where a URL
// needs it). The site uses that text as it is: the button's href is exactly the file's content, so dragging the
// button saves the same favourite as pasting the file. The only change ever made is percent-encoding a raw control
// character (tab, line break), which a browser would otherwise delete from the URL and so change the code.

/** Chromium caps URLs at 2 MiB; Edge runs favourites up to about 2,040,000 characters. */
export const MAX_BOOKMARKLET_CHARS = 2_000_000

const EXCLUDED_DIRS = /(^|\/)(node_modules|\.github|\.vscode|src|source|test|tests|__tests__|spec|vendor|fixtures|examples?)\//i
const NOT_BOOKMARKLETS = /(^|\/)(license|licence|changelog|readme|notice|third-party[^/]*|requirements|robots|security|contributing|package(-lock)?|tsconfig[^/]*|[^/]*\.config|\.[^/]*rc|gulpfile|gruntfile|webpack[^/]*|rollup[^/]*|vite[^/]*|jest[^/]*|babel[^/]*|eslint[^/]*|prettier[^/]*)\.(txt|js|mjs|cjs|json)$/i

/**
 * Orders the files of a repository tree by how likely each one is to be its bookmarklet, best first.
 * @param {{path: string, type: string, size?: number}[]} tree  entries of GET /git/trees/{sha}?recursive=1
 * @param {number} limit  how many candidates to return (each one costs a download)
 */
export function bookmarkletCandidates(tree, limit = 6) {
  const scored = []
  for (const entry of tree) {
    if (entry.type !== 'blob') continue
    const path = entry.path
    if (entry.size !== undefined && (entry.size < 20 || entry.size > MAX_BOOKMARKLET_CHARS * 1.1)) continue
    if (EXCLUDED_DIRS.test(path) || NOT_BOOKMARKLETS.test(path)) continue
    const name = path.split('/').pop()
    const depth = path.split('/').length - 1
    const inBuildDir = /^(dist|build|out|release|bookmarklet)\//i.test(path)
    let score = 0
    if (/\.bookmarklet\.(txt|js|url)$/i.test(name)) score = 100
    else if (/^bookmarklet\.(txt|js|url)$/i.test(name)) score = 90
    else if (/bookmarklet/i.test(name) && /\.(txt|url)$/i.test(name)) score = 80
    else if (/bookmarklet/i.test(name) && /\.m?js$/i.test(name) && !/\.min\.m?js$/i.test(name)) score = 70
    else if (depth === 0 && /\.(txt|js)$/i.test(name) && !/\.min\.js$/i.test(name)) score = 20 // e.g. SQLAdvancedFind.js at the root
    if (!score) continue
    if (depth === 0 || inBuildDir) score += 5
    scored.push({ path, score: score - depth })
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) // no locale: the same everywhere
  return scored.slice(0, limit).map((c) => c.path)
}

/**
 * Percent-decodes a URL the way a browser does before running a javascript: URL: %XX sequences become bytes, anything
 * else stays, and the bytes are read as UTF-8. Unlike decodeURIComponent it never throws on a stray %.
 */
export function percentDecode(text) {
  const bytes = []
  const utf8 = new TextEncoder()
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else if (c.charCodeAt(0) < 0x80) {
      bytes.push(c.charCodeAt(0))
    } else {
      const point = text.codePointAt(i)
      if (point > 0xffff) i++
      bytes.push(...utf8.encode(String.fromCodePoint(point)))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * True when the browser's URL parser keeps the bookmarklet's code: the parsed URL may be encoded differently (Chrome
 * writes ' as %27 after a ?), but once percent-decoded, as the browser does before running it, it must be the same.
 */
export function survivesUrlParser(href) {
  try {
    return percentDecode(new URL(href).href) === percentDecode(href)
  } catch {
    return false
  }
}

/**
 * Checks a downloaded file and returns the href to use, or why it is not a bookmarklet.
 * @returns {{ok: true, href: string, encodedControlChars: number} | {ok: false, reason: string}}
 */
export function parseBookmarklet(text) {
  let href = String(text).replace(/^﻿/, '').trim()
  if (!/^javascript:/i.test(href)) return { ok: false, reason: 'it does not start with javascript:' }
  if (href.length <= 'javascript:'.length + 2) return { ok: false, reason: 'it is empty' }
  let encodedControlChars = 0
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be encoded
  href = href.replace(/[\x00-\x1f\x7f]/g, (c) => {
    encodedControlChars++
    return `%${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`
  })
  if (href.length > MAX_BOOKMARKLET_CHARS) return { ok: false, reason: `it is ${href.length} characters, over the ${MAX_BOOKMARKLET_CHARS} a favourite can hold` }
  return { ok: true, href, encodedControlChars }
}

// Images and videos for the tool cards: reading pixel sizes (so the page reserves their space before they load) and
// finding a repository's showcase image in its README when the config names none.
import { percentDecode } from './bookmarklet.mjs'
import { isPublicHttps } from './text.mjs'

/** Pixel size of a PNG, GIF, JPEG or WebP, or null for anything else. Reads only the file header. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null
  // PNG: signature, then the IHDR chunk with width and height.
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'image/png' }
  // GIF: logical screen size, little endian.
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'image/gif' }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), type: 'image/webp' }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), type: 'image/webp' }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, type: 'image/webp' }
    return null
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const marker = buf[i + 1]
      const length = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'image/jpeg' }
      i += 2 + length
    }
  }
  return null
}

const BADGE = /shields\.io|badgen\.net|badge|capsule-render|img\.shields|\/workflows\/.+\/badge|codecov|coveralls|travis-ci|gitter/i

/**
 * Finds the first real image in a README (markdown or HTML), skipping badges, and resolves a relative path against
 * the README's folder. Returns {src, alt, repoPath} where repoPath is set when the image is a file of the repository.
 */
export function firstReadmeImage(markdown, readmePath = 'README.md') {
  const text = String(markdown).replace(/<!--[\s\S]*?-->/g, '')
  const found = []
  // Bounded quantifiers: a README can't make these regular expressions slow.
  for (const m of text.matchAll(/!\[([^\]\n]{0,300})\]\(\s*<?([^)\s>]{1,2000})>?(?:\s+"[^"\n]{0,300}")?\s*\)/g)) found.push({ index: m.index, alt: m[1], src: m[2] })
  for (const m of text.matchAll(/<img\b[^>]{0,2000}>/gi)) {
    const src = m[0].match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const alt = m[0].match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    if (src) found.push({ index: m.index, alt: alt ? (alt[1] ?? alt[2]) : '', src: src[1] ?? src[2] ?? src[3] })
  }
  found.sort((a, b) => a.index - b.index)
  for (const image of found) {
    const src = image.src.replace(/&amp;/g, '&').trim()
    if (!src || BADGE.test(src) || /\.svg(\?|#|$)/i.test(src) || src.startsWith('data:')) continue
    if (/^https:\/\//i.test(src)) {
      if (isPublicHttps(src)) return { src, alt: image.alt.trim(), repoPath: '' }
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) continue // http:, other schemes
    const base = readmePath.includes('/') ? readmePath.slice(0, readmePath.lastIndexOf('/') + 1) : ''
    let resolved
    try {
      resolved = new URL(src.replace(/^\.\//, ''), `https://repo.invalid/${base}`)
    } catch {
      continue
    }
    if (resolved.host !== 'repo.invalid') continue
    // percentDecode, unlike decodeURIComponent, never throws: "docs/50%off.png" stays as it is.
    return { src: '', alt: image.alt.trim(), repoPath: percentDecode(resolved.pathname.slice(1)) }
  }
  return null
}

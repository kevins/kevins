// Small text helpers shared by the build: HTML escaping, names, slugs, dates and numbers.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** Escapes text for HTML element content and double- or single-quoted attribute values. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])

/** Reverses esc() (and the few named entities a browser would decode the same way). Used by the build's self-check. */
export const unesc = (value) =>
  String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])

/**
 * Turns a repository name into a display name:
 * "SQLAdvancedFind" -> "SQL Advanced Find", "LevelUpBookmarklet" -> "Level Up Bookmarklet", "my-tool_v2" -> "My tool v2".
 */
export function titleFromRepoName(name) {
  return String(name)
    .replace(/[-_.]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
}

/** "Unmanaged Layer Scanner" -> "unmanaged-layer-scanner". Always returns a usable id. */
export function slugify(text) {
  const slug = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'tool'
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** "2026-11-02T10:28:01Z" -> "Nov 2, 2026" (UTC, so the output never depends on the build machine). */
export const formatDate = (iso) => (iso ? DATE.format(new Date(iso)) : '')

/** 297606 -> "297,606" */
export const formatNumber = (n) => Number(n).toLocaleString('en-US')

/** 297606 -> "291 KB", 1613591 -> "1.5 MB" (binary units, as file managers show them). */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Strips a leading "v" from a tag ("v1.0.3" -> "1.0.3") and rejects anything that does not look like a version. */
export function cleanVersion(value) {
  const v = String(value ?? '').trim().replace(/^v(?=\d)/i, '')
  return /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(v) ? v : ''
}

/** Accepts only absolute http(s) URLs, so nothing from a README or the API can inject another scheme into a link. */
export function safeUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : ''
  } catch {
    return ''
  }
}

/**
 * True for an https URL on a public host name: not plain http, not localhost or a .local/.internal name, not a bare
 * IP address. Pictures named in a README are downloaded (and linked) only from such addresses.
 */
export function isPublicHttps(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    return false
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || !host.includes('.')) return false
  if (host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host)) return false
  return !/^[\d.]+$/.test(host) && !host.includes(':')
}

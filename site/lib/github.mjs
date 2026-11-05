// A small GitHub REST client for the build: authentication, retries with backoff, pagination and file downloads.
// Only Node's built-in fetch is used, so the build has no dependencies to install.
//
// Repository files are read through the REST API (contents endpoint, raw media type) rather than
// raw.githubusercontent.com: the API is authenticated with the workflow's token, pinned to a commit, and has a
// documented rate limit, while raw.githubusercontent.com answers 404 to a token it does not accept.

import { isPublicHttps } from './text.mjs'

const API_VERSION = '2022-11-28'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class HttpError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} answered ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
    this.status = status
    this.url = url
  }
}

/** An error that retrying cannot fix (too big, not allowed): get() passes it straight on. */
const final = (message) => Object.assign(new Error(message), { final: true })

export class GitHub {
  /**
   * @param {object} options
   * @param {string} [options.apiUrl]  REST API root (GitHub Actions sets GITHUB_API_URL)
   * @param {string} [options.token]   GITHUB_TOKEN in Actions; optional locally (60 requests/hour without one)
   * @param {typeof fetch} [options.fetch]
   */
  constructor({ apiUrl = 'https://api.github.com', token = '', fetch: fetchImpl = globalThis.fetch, retries = 3, timeoutMs = 60_000, log = () => {}, sleep: sleepImpl = sleep } = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.token = token
    this.fetch = fetchImpl
    this.sleep = sleepImpl
    this.retries = retries
    this.timeoutMs = timeoutMs
    this.log = log
    this.requests = 0
    // The token goes to the API only (same scheme, host and port): never to an image host named in a README.
    this.apiOrigin = new URL(this.apiUrl).origin
  }

  isApi(url) {
    return new URL(url).origin === this.apiOrigin
  }

  /**
   * GET with retries on network errors, 5xx, 429 and rate limits. `read` turns the response into the result, inside
   * the retries, so a connection that drops or stalls while the body downloads is retried as well.
   * A status listed in allowStatus is handed to `read` like a success.
   */
  async get(url, { accept, allowStatus = [], read = (res) => res } = {}) {
    const headers = { 'User-Agent': 'kv-toolkit-site-build', 'X-GitHub-Api-Version': API_VERSION }
    if (accept) headers.Accept = accept
    if (this.token && this.isApi(url)) headers.Authorization = `Bearer ${this.token}`
    for (let attempt = 1; ; attempt++) {
      let res
      try {
        this.requests++
        res = await this.fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) })
        if (res.ok || allowStatus.includes(res.status)) return await read(res)
      } catch (error) {
        if (error.final) throw error
        const reason = error.cause ? `${error.message} (${error.cause.code || error.cause.message})` : error.message
        if (attempt <= this.retries) {
          this.log(`  retrying ${url} after ${reason}`)
          await this.sleep(backoff(attempt))
          continue
        }
        throw new Error(`GET ${url} failed: ${reason}`)
      }
      const wait = retryDelay(res, attempt)
      if (wait !== null && attempt <= this.retries) {
        await res.body?.cancel()
        this.log(`  ${url} answered ${res.status}; retrying in ${Math.round(wait / 1000)} s`)
        await this.sleep(wait)
        continue
      }
      // Only GitHub's own error text is kept: another host's answer could be anything, and warnings are published.
      const body = this.isApi(url) ? await res.text().catch(() => '') : (await res.body?.cancel(), '')
      throw new HttpError('GET', url, res.status, body)
    }
  }

  /** GET an API path (or absolute URL) as JSON. With allow404, a missing resource gives null. */
  async json(path, { allow404 = false } = {}) {
    const url = path.startsWith('http') ? path : this.apiUrl + path
    return this.get(url, {
      accept: 'application/vnd.github+json',
      allowStatus: allow404 ? [404] : [],
      read: async (res) => {
        if (res.status === 404) {
          await res.body?.cancel()
          return null
        }
        return res.json()
      },
    })
  }

  /** Follows the Link: rel="next" headers of a list endpoint and returns every item. */
  async paginate(path, { maxPages = 20 } = {}) {
    let url = path.startsWith('http') ? path : this.apiUrl + path
    const items = []
    for (let page = 0; url && page < maxPages; page++) {
      const { data, link } = await this.get(url, { accept: 'application/vnd.github+json', read: async (res) => ({ data: await res.json(), link: res.headers.get('link') }) })
      if (!Array.isArray(data)) throw new Error(`${url} did not return a list`)
      items.push(...data)
      url = nextLink(link)
    }
    return items
  }

  /** API URL of a file at an exact commit; each path segment is encoded, so spaces and # are safe. */
  fileUrl(owner, repo, ref, path) {
    return `${this.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  }

  /** A repository file's text at a commit (files up to 100 MB). */
  async fileText(owner, repo, ref, path) {
    return this.get(this.fileUrl(owner, repo, ref, path), { accept: 'application/vnd.github.raw+json', read: (res) => res.text() })
  }

  /**
   * Downloads a repository file at a commit (an API URL), or a picture on another public https host, as a Buffer.
   * Stops reading as soon as the body passes maxBytes, whatever the server declares.
   */
  async download(url, { maxBytes = 25 * 1024 * 1024 } = {}) {
    const api = this.isApi(url)
    if (!api && !isPublicHttps(url)) throw final('only public https addresses are downloaded')
    return this.get(url, {
      accept: api ? 'application/vnd.github.raw+json' : undefined,
      read: async (res) => {
        const declared = Number(res.headers.get('content-length') || 0)
        if (declared > maxBytes) {
          await res.body?.cancel()
          throw final(`${url} is ${declared} bytes, over the ${maxBytes} byte limit`)
        }
        const chunks = []
        let size = 0
        if (res.body) {
          for await (const chunk of res.body) {
            size += chunk.length
            if (size > maxBytes) throw final(`${url} is over the ${maxBytes} byte limit`) // leaving the loop cancels the body
            chunks.push(chunk)
          }
        }
        return { buffer: Buffer.concat(chunks), contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), finalUrl: res.url || url }
      },
    })
  }
}

/** Throws unless the URL is https on a public host (see isPublicHttps). */
export function assertPublicHttps(url) {
  if (!isPublicHttps(url)) throw final('only public https addresses are downloaded')
}

export function nextLink(header) {
  if (!header) return null
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/)
    if (match) return match[1]
  }
  return null
}

const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250)

/** How long to wait before retrying a failed response, or null when retrying cannot help. */
function retryDelay(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'))
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (res.status === 429 || (res.status === 403 && (retryAfter || remaining === '0'))) {
    if (retryAfter) return retryAfter <= 120 ? retryAfter * 1000 : null
    if (remaining === '0' && reset) {
      const wait = reset * 1000 - Date.now() + 1000
      return wait <= 120_000 ? Math.max(wait, 1000) : null
    }
    return backoff(attempt)
  }
  if (res.status >= 500) return backoff(attempt)
  return null
}

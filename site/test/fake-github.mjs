// A configurable fake GitHub for the robustness tests: repositories, files, and the awkward cases (no commits yet,
// renamed, truncated file lists) plus a hook to answer any request differently.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from '../build.mjs'
import { GitHub } from '../lib/github.mjs'

export const OWNER = 'octo'
export const BM = 'javascript:void(document.title="x")'

export function png(width, height) {
  const b = Buffer.alloc(40)
  b.writeUInt32BE(0x89504e47, 0)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

/** The first bytes of an MP4 file: an ftyp box. */
export const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)])

export const repo = (name, extra = {}) => ({
  id: extra.id ?? Math.abs([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)),
  name,
  full_name: `${OWNER}/${name}`,
  owner: { login: OWNER, id: 4242 },
  html_url: `https://github.com/${OWNER}/${name}`,
  description: null,
  default_branch: 'main',
  language: 'JavaScript',
  private: false,
  fork: false,
  archived: false,
  disabled: false,
  size: 10,
  license: { spdx_id: 'MIT' },
  ...extra,
})

export const config = (tools = {}, extra = {}) => ({
  owner: OWNER,
  site: { title: 'T', author: 'A', eyebrow: 'E', headline: 'H', intro: 'I', description: 'D', bookmarkletsIntro: 'B', moreToolsIntro: 'M', disclaimer: 'X', url: 'https://octo.github.io/octo/' },
  exclude: [],
  order: [],
  tools,
  ...extra,
})

/** One repository with a bookmarklet file, and its config entry. */
export const single = (name, extraFiles = {}, cfg = { bookmarklet: { path: 'x.bookmarklet.txt' } }) => ({
  config: config({ [name]: cfg }),
  repos: [repo(name)],
  files: { [name]: { 'x.bookmarklet.txt': BM, ...extraFiles } },
})

/**
 * @param {object} options
 * repos: listing items; files: { repoName: { path: body } }; empty: names with no commits; renamed: { oldName: newName };
 * truncated: names whose file list comes back truncated; hooks: (url, URL) => Response | undefined, asked first
 */
export function fakeGitHub({ repos, files = {}, empty = new Set(), renamed = {}, truncated = new Set(), hooks } = {}) {
  const requests = []
  const sleeps = []
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  const sha = (name) => `${name.toLowerCase().replace(/[^a-z]/g, '').padEnd(8, 'x').slice(0, 8)}${'0'.repeat(32)}`
  const fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization })
    const u = new URL(url)
    if (hooks) {
      const answer = await hooks(url, u, init)
      if (answer) return answer
    }
    if (u.host !== 'api.github.com') return new Response('no', { status: 404 })
    const p = decodeURIComponent(u.pathname)
    if (p === `/users/${OWNER}/repos`) return json(repos)
    let m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/)
    if (m) {
      const found = repos.find((x) => x.name === (renamed[m[2]] || m[2]))
      return found ? json(found) : json({ message: 'Not Found' }, 404)
    }
    m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/)
    if (!m) return json({}, 404)
    const [, , name, rest] = m
    const repoFiles = files[name] || {}
    if (empty.has(name)) return json({ message: rest.startsWith('branches/') ? 'Branch not found' : 'Not Found' }, 404)
    if (rest.startsWith('branches/')) return json({ name: 'main', commit: { sha: sha(name), commit: { committer: { date: '2026-09-01T10:00:00Z' } } } })
    if (rest.startsWith('git/trees/')) {
      let entries = Object.entries(repoFiles).map(([path, body]) => ({ path, type: 'blob', size: Buffer.byteLength(body) }))
      if (truncated.has(name)) entries = entries.slice(0, 1)
      return json({ sha: sha(name), truncated: truncated.has(name), tree: entries })
    }
    if (rest.startsWith('contents/')) {
      const filePath = rest.slice('contents/'.length)
      return filePath in repoFiles ? new Response(repoFiles[filePath], { status: 200 }) : json({ message: 'Not Found' }, 404)
    }
    if (rest === 'commits') return json([{ sha: sha(name), html_url: `https://github.com/${OWNER}/${name}/commit/${sha(name)}`, commit: { committer: { date: '2026-09-01T10:00:00Z' } } }])
    if (rest === 'releases/latest') return json({ message: 'Not Found' }, 404)
    if (rest === 'readme') return repoFiles['README.md'] ? json({ path: 'README.md', content: Buffer.from(repoFiles['README.md']).toString('base64') }) : json({ message: 'Not Found' }, 404)
    return json({}, 404)
  }
  return { github: new GitHub({ token: 't', fetch, sleep: async (ms) => sleeps.push(ms) }), requests, sleeps }
}

/** Runs the real build against the fake. Never throws: { ok, error, tools, html, contentHash, warnings, ... }. */
export async function runBuild({ config: siteConfig, ...fakeOptions }) {
  const out = await mkdtemp(path.join(tmpdir(), 'kv-site-'))
  const { github, requests, sleeps } = fakeGitHub(fakeOptions)
  try {
    const result = await build({ out, config: siteConfig, github, only: [], siteUrl: '', log: () => {}, annotate: false, ownerId: 0, summaryFile: '' })
    return { ok: true, ...result, requests, sleeps }
  } catch (error) {
    return { ok: false, error, requests, sleeps }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

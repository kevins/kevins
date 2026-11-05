// End-to-end test of the build against a fake GitHub: no network, the real code path from the repository listing to
// the written page. Run with: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from '../build.mjs'
import { GitHub } from '../lib/github.mjs'
import { unesc } from '../lib/text.mjs'

const API = 'https://api.github.com'
const OWNER = 'octo'
const OWNER_ID = 4242

// A bookmarklet with everything that must survive HTML escaping: & " < > ' and entity-like text, percent escapes,
// and a character outside ASCII.
const ALPHA = `javascript:(()=>{const s="a&amp;b<c>'d' &copy; &#65; %25 %23 café";alert(s)})()`
const BETA = 'javascript:void(document.title="beta")'

function png(width, height) {
  const b = Buffer.alloc(40)
  b.writeUInt32BE(0x89504e47, 0)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const repo = (name, extra = {}) => ({
  name,
  full_name: `${OWNER}/${name}`,
  owner: { login: OWNER, id: OWNER_ID },
  html_url: `https://github.com/${OWNER}/${name}`,
  description: null,
  default_branch: 'main',
  language: 'TypeScript',
  private: false,
  fork: false,
  archived: false,
  disabled: false,
  license: { spdx_id: 'MIT' },
  ...extra,
})

const REPOS = [
  repo('AlphaTool', { description: 'Alpha from GitHub.' }),
  repo(OWNER), // the profile repository
  repo('ForkedThing', { fork: true }),
  repo('OldThing', { archived: true }),
  repo('HiddenThing'),
  repo('beta-helper', { language: 'JavaScript' }),
  repo('GammaControl', { description: 'A PCF control.' }),
  repo('EmptyRepo'), // created, nothing pushed yet
]

const FILES = {
  AlphaTool: {
    'dist/alpha.bookmarklet.txt': `${ALPHA}\n`,
    'dist/alpha.min.js': '(()=>{})()',
    'package.json': JSON.stringify({ version: '2.1.0' }),
    'docs/thumb.png': png(1280, 800),
    'docs/demo.mp4': Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(16)]), // an MP4's first bytes
    'src/index.ts': 'export {}',
  },
  'beta-helper': {
    'bookmarklet.txt': BETA,
    'README.md': '# Beta helper\n\n[![badge](https://img.shields.io/badge/a-b-c)](x)\n\nBeta helper adds a small, useful button to every Dataverse form you open.\n\n![Beta in use](docs/shot.png)\n',
    'docs/shot.png': png(800, 1600),
  },
  GammaControl: {
    'README.md': '# Gamma',
    'Bookmarklet.txt': 'javascript:void(0)',
  },
  HiddenThing: { 'bookmarklet.txt': 'javascript:void(1)' },
}

const CONFIG = {
  owner: OWNER,
  site: { title: 'Test Toolkit', author: 'T', eyebrow: 'E', headline: 'H', intro: 'I', description: 'D', bookmarkletsIntro: 'B', moreToolsIntro: 'M', disclaimer: 'X', url: 'https://octo.github.io/octo/' },
  exclude: ['HiddenThing'],
  order: ['GammaControl', 'AlphaTool'],
  tools: {
    AlphaTool: {
      name: 'Alpha',
      tagline: 'Alpha <does> "things" & more.',
      icon: 'star',
      bookmarklet: { path: 'dist/alpha.bookmarklet.txt', label: 'Alpha & Co' },
      image: { path: 'docs/thumb.png', alt: 'Alpha screenshot' },
      video: { path: 'docs/demo.mp4' },
      credit: 'Alpha is based on Something (MIT).',
    },
    GammaControl: {
      bookmarklet: false,
      image: { url: 'https://images.example.com/gamma.png', alt: 'Gamma' },
    },
    GoneTool: { tagline: 'No longer public' },
  },
}

function fakeGitHub({ files = FILES, failOnce = true } = {}) {
  const requests = []
  let failed = !failOnce
  const json = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...init.headers } })
  const sha = (name) => `${name.toLowerCase().replace(/[^a-z]/g, '').padEnd(8, 'x').slice(0, 8)}${'0'.repeat(32)}`
  const fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization, accept: init.headers.Accept })
    const u = new URL(url)
    if (u.host === 'images.example.com') return new Response(png(975, 597), { status: 200, headers: { 'content-type': 'image/png' } })
    if (u.host !== 'api.github.com') return new Response('no', { status: 404 })
    const p = decodeURIComponent(u.pathname)
    // Page 1 of the listing fails once with a 502, then works; the listing has two pages.
    if (p === `/users/${OWNER}/repos`) {
      if (!failed) {
        failed = true
        return new Response('bad gateway', { status: 502 })
      }
      if (u.searchParams.get('page') === '2') return json(REPOS.slice(4))
      return json(REPOS.slice(0, 4), { headers: { link: `<${API}/users/${OWNER}/repos?type=owner&per_page=100&page=2>; rel="next"` } })
    }
    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/)
    if (!m) return new Response('{}', { status: 404 })
    const [, , name, rest] = m
    const repoFiles = files[name] || {}
    if (rest.startsWith('branches/') && name === 'EmptyRepo') return new Response('{"message":"Branch not found"}', { status: 404 })
    if (rest.startsWith('branches/')) return json({ name: 'main', commit: { sha: sha(name), commit: { committer: { date: name === 'AlphaTool' ? '2026-10-01T10:00:00Z' : '2026-09-01T10:00:00Z' } } } })
    if (rest.startsWith('git/trees/')) return json({ sha: sha(name), truncated: false, tree: Object.entries(repoFiles).map(([path, body]) => ({ path, type: 'blob', size: Buffer.byteLength(body) })) })
    if (rest.startsWith('contents/')) {
      const filePath = rest.slice('contents/'.length)
      if (!(filePath in repoFiles)) return new Response('{"message":"Not Found"}', { status: 404 })
      assert.equal(u.searchParams.get('ref'), sha(name), 'files are read at the pinned commit')
      return new Response(repoFiles[filePath], { status: 200 })
    }
    if (rest === 'commits') return json([{ sha: sha(name), html_url: `https://github.com/${OWNER}/${name}/commit/${sha(name)}`, commit: { committer: { date: '2026-10-02T09:00:00Z' } } }])
    if (rest === 'releases/latest') {
      if (name === 'GammaControl') return json({ tag_name: 'v3.0.0', name: 'Gamma 3', html_url: `https://github.com/${OWNER}/${name}/releases/tag/v3.0.0`, published_at: '2026-08-01T00:00:00Z', assets: [{ name: 'Gamma_managed.zip', size: 100, browser_download_url: 'https://example.com/g.zip' }] })
      return new Response('{"message":"Not Found"}', { status: 404 })
    }
    if (rest === 'readme') {
      if (!repoFiles['README.md']) return new Response('{}', { status: 404 })
      return json({ path: 'README.md', content: Buffer.from(repoFiles['README.md']).toString('base64') })
    }
    return new Response('{}', { status: 404 })
  }
  return { github: new GitHub({ token: 'test-token', fetch, sleep: async () => {} }), requests }
}

async function run(options = {}) {
  const out = await mkdtemp(path.join(tmpdir(), 'kv-site-'))
  const { github, requests } = fakeGitHub(options)
  const lines = []
  const result = await build({ out, config: options.config || CONFIG, github, only: [], siteUrl: '', log: (l) => lines.push(l), annotate: options.annotate || false, fragment: options.fragment || false, ownerId: options.ownerId ?? OWNER_ID, summaryFile: '' })
  return { ...result, requests, lines, out }
}

test('the build writes the page from the repositories', async (t) => {
  const { out, html, tools, warnings, requests, contentHash } = await run()
  t.after(() => rm(out, { recursive: true, force: true }))

  // Which repositories are shown, and in which order.
  assert.deepEqual(tools.map((x) => x.repo), ['GammaControl', 'AlphaTool', 'beta-helper'])
  for (const hidden of ['ForkedThing', 'OldThing', 'HiddenThing', `>${OWNER}<`]) assert.ok(!html.includes(hidden), `${hidden} is not shown`)

  // The drag button holds the bookmarklet exactly, and its text is exactly the favourite's name.
  const alpha = html.match(/<a class="bm" id="bm-alpha" href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
  assert.ok(alpha, 'Alpha has a drag button')
  assert.equal(unesc(alpha[1]), ALPHA)
  assert.equal(unesc(alpha[2].replace(/<[^>]+>/g, '')), 'Alpha & Co')
  assert.ok(!html.includes(ALPHA.slice(0, 40)), 'the raw, unescaped bookmarklet is not in the page')

  // A repository without config gets its bookmarklet, name, summary and picture found automatically.
  const beta = tools.find((x) => x.repo === 'beta-helper')
  assert.equal(beta.bookmarklet.href, BETA)
  assert.equal(beta.name, 'Beta helper')
  assert.equal(beta.tagline, 'Beta helper adds a small, useful button to every Dataverse form you open.')
  assert.equal(beta.image.width, 800)
  assert.match(beta.image.src, /^media\/beta-helper-[0-9a-f]{10}\.png$/)
  assert.match(html, /class="is-tall"/)

  // A tool configured as "not a bookmarklet" gets no button even though it has a Bookmarklet.txt.
  const gamma = tools.find((x) => x.repo === 'GammaControl')
  assert.equal(gamma.bookmarklet, null)
  assert.equal(gamma.version, '3.0.0')
  assert.ok(!/<a class="bm" id="bm-gamma-control"/.test(html), 'no drag button for Gamma')
  assert.match(html, /<li class="tool" id="gamma-control">[\s\S]*?href="https:\/\/github\.com\/octo\/GammaControl"/)
  assert.match(gamma.image.src, /^media\/gamma-control-/)

  // Version from package.json, pictures and video saved with the site, text escaped.
  const alphaTool = tools.find((x) => x.repo === 'AlphaTool')
  assert.equal(alphaTool.version, '2.1.0')
  assert.ok(alphaTool.video.src.endsWith('.mp4'))
  assert.match(html, /Alpha &lt;does&gt; &quot;things&quot; &amp; more\./)
  assert.match(html, new RegExp(`<video src="${alphaTool.video.src}" poster="${alphaTool.image.src}"[^>]* autoplay muted loop playsinline`), 'the demo plays like a GIF')
  const media = await readdir(path.join(out, 'media'))
  assert.equal(media.length, 4) // Alpha: picture and video; Beta: picture; Gamma: picture

  // One page: each tool is one card, and each bookmarklet is in the page once.
  assert.equal((html.match(/<li class="tool" /g) || []).length, 3)
  assert.equal(html.split(ALPHA.slice(11, 40).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')).length - 1, 1)
  for (const gone of ['class="chip"', '<details', '<dialog', 'class="highlights"']) assert.ok(!html.includes(gone), `${gone} is gone`)

  // The CSP comes first in <head>; everything else the page needs is beside it.
  assert.match(html, /<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy"/)
  assert.match(await readFile(path.join(out, '404.html'), 'utf8'), /href="\/octo\/assets\/site\.css\?v=/)
  await readFile(path.join(out, 'assets', 'site.js'))
  await readFile(path.join(out, 'assets', 'fonts', 'archivo-variable.woff2'))

  // build.json, warnings and requests.
  const info = JSON.parse(await readFile(path.join(out, 'build.json'), 'utf8'))
  assert.equal(info.contentHash, contentHash)
  assert.deepEqual(info.tools.map((x) => x.repo), ['GammaControl', 'AlphaTool', 'beta-helper'])
  assert.ok(warnings.some((w) => w.includes('GoneTool')), 'a config entry without a repository is reported')
  assert.ok(warnings.some((w) => w.includes('EmptyRepo: has no commits yet')), 'a repository without commits is skipped, not fatal')
  assert.ok(requests.some((r) => r.url.includes('page=2')), 'the listing is followed to its second page')
  assert.ok(requests.filter((r) => r.url.startsWith(API)).every((r) => r.auth === 'Bearer test-token'))
  assert.equal(requests.find((r) => r.url.startsWith('https://images.example.com')).auth, undefined, 'the token never leaves the API')
})

test('the same repositories always give the same content hash', async (t) => {
  const a = await run()
  const b = await run()
  t.after(() => Promise.all([rm(a.out, { recursive: true, force: true }), rm(b.out, { recursive: true, force: true })]))
  assert.equal(a.contentHash, b.contentHash)
  const changed = await run({ files: { ...FILES, AlphaTool: { ...FILES.AlphaTool, 'dist/alpha.bookmarklet.txt': 'javascript:void("v2")' } } })
  t.after(() => rm(changed.out, { recursive: true, force: true }))
  assert.notEqual(changed.contentHash, a.contentHash)
})

test('a configured bookmarklet that disappears stops the build', async (t) => {
  const out = await mkdtemp(path.join(tmpdir(), 'kv-site-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const files = { ...FILES, AlphaTool: { 'package.json': '{}', 'src/index.ts': '' } }
  const { github } = fakeGitHub({ files })
  await assert.rejects(build({ out, config: CONFIG, github, only: [], log: () => {}, annotate: false, ownerId: OWNER_ID }), /AlphaTool: site\/config\.json says it ships a bookmarklet/)
})

test('a moved bookmarklet is found again, with a warning', async (t) => {
  const files = { ...FILES, AlphaTool: { ...FILES.AlphaTool, 'build/alpha.bookmarklet.txt': ALPHA } }
  delete files.AlphaTool['dist/alpha.bookmarklet.txt']
  const r = await run({ files })
  t.after(() => rm(r.out, { recursive: true, force: true }))
  assert.equal(r.tools.find((x) => x.repo === 'AlphaTool').bookmarklet.path, 'build/alpha.bookmarklet.txt')
  assert.ok(r.warnings.some((w) => w.includes('dist/alpha.bookmarklet.txt') && w.includes('not in the repository')))
})

test('the preview fragment has no document head and no CSP', async (t) => {
  const r = await run({ fragment: true })
  t.after(() => rm(r.out, { recursive: true, force: true }))
  assert.ok(r.html.startsWith('<title>Test Toolkit</title>'))
  assert.ok(!r.html.includes('<!doctype') && !r.html.includes('<body') && !r.html.includes('Content-Security-Policy'))
})

test('a renamed owner account stops the build', async (t) => {
  const out = await mkdtemp(path.join(tmpdir(), 'kv-site-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const { github } = fakeGitHub()
  await assert.rejects(build({ out, config: CONFIG, github, only: [], log: () => {}, annotate: false, ownerId: 999, summaryFile: '' }), /no longer account 999/)
})

test('README pictures over plain http or on private hosts are never fetched, and the token stays on the API', async (t) => {
  const readme = '# Beta\n\n<img src="http://api.github.com/steal.png">\n<img src="https://127.0.0.1/inside.png">\n\nBeta helper adds a small, useful button to every Dataverse form you open.\n\n![Beta in use](docs/shot.png)\n'
  const files = { ...FILES, 'beta-helper': { ...FILES['beta-helper'], 'README.md': readme } }
  const r = await run({ files })
  t.after(() => rm(r.out, { recursive: true, force: true }))
  assert.ok(!r.requests.some((q) => q.url.startsWith('http://') || q.url.includes('127.0.0.1')), 'nothing is requested over http or from a private host')
  assert.match(r.tools.find((x) => x.repo === 'beta-helper').image.src, /^media\/beta-helper-/)
})

test('a warning quoting a README stays one line, so it can never become a workflow command', async (t) => {
  const readme = '# Beta\n\nBeta helper adds a small, useful button to every Dataverse form you open.\n\n![a](x%0A::error%20title=Forged::y.png)\n'
  const files = { ...FILES, 'beta-helper': { ...FILES['beta-helper'], 'README.md': readme } }
  const r = await run({ files, annotate: true })
  t.after(() => rm(r.out, { recursive: true, force: true }))
  const forged = r.lines.flatMap((l) => l.split('\n')).filter((l) => l.startsWith('::error'))
  assert.deepEqual(forged, [])
  assert.ok(r.warnings.some((w) => w.includes('::error title=Forged::y.png') && !w.includes('\n')))
})

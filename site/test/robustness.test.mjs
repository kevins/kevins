// The awkward cases: repositories in unusual states, network trouble, odd README content. Each one must leave the
// hourly build either succeeding with a sensible page or failing loudly (so the live page keeps its last good buttons).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build, selfCheck } from '../build.mjs'
import { GitHub } from '../lib/github.mjs'
import { firstReadmeImage } from '../lib/media.mjs'
import { firstReadmeParagraph } from '../lib/collect.mjs'
import { BM, config, mp4, png, repo, runBuild, single } from './fake-github.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('a repository without commits is left out, not fatal', async () => {
  const o = single('Alpha')
  const r = await runBuild({ ...o, repos: [...o.repos, repo('BrandNew', { size: 0 })], empty: new Set(['BrandNew']) })
  assert.ok(r.ok, r.error?.message)
  assert.deepEqual(r.tools.map((t) => t.repo), ['Alpha'])
})

test('a configured bookmarklet tool that loses its branch stops the build', async () => {
  const r = await runBuild({ ...single('Alpha'), empty: new Set(['Alpha']) })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /Alpha: its default branch main does not exist/)
})

test('a name that becomes a "bm-" slug gets another one, and the build ends', async () => {
  const r = await runBuild(single('BMTools', {}, {}))
  assert.ok(r.ok, r.error?.message)
  assert.ok(!r.tools[0].slug.startsWith('bm-'))
  assert.match(r.html, new RegExp(`id="bm-${r.tools[0].slug}"`))
})

test('a README picture path with a bare % is still found', async () => {
  assert.doesNotThrow(() => firstReadmeImage('![x](docs/50%off.png)'))
  const r = await runBuild(single('Gamma', { 'README.md': '![s](docs/50%off.png)', 'docs/50%off.png': png(10, 10) }, { bookmarklet: false }))
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.tools[0].image?.width, 10)
})

test('a renamed repository keeps its config entry, so "bookmarklet": false still holds', async () => {
  const r = await runBuild({ config: config({ OldName: { name: 'Curated', bookmarklet: false } }), repos: [repo('NewName', { id: 7 })], files: { NewName: { 'Bookmarklet.txt': BM } }, renamed: { OldName: 'NewName' } })
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.tools[0].name, 'Curated')
  assert.equal(r.tools[0].bookmarklet, null, 'no drag button for a tool the config says is not a bookmarklet')
  assert.ok(r.warnings.some((w) => w.includes('now called NewName')))
})

test('a file that is not a video (a Git LFS pointer) is not published as the demo', async () => {
  const lfs = 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 9\n'
  const r = await runBuild(single('Alpha', { 'docs/demo.mp4': lfs }, { bookmarklet: { path: 'x.bookmarklet.txt' }, video: { path: 'docs/demo.mp4' } }))
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.tools[0].video, null)
  const real = await runBuild(single('Alpha', { 'docs/demo.mp4': mp4() }, { bookmarklet: { path: 'x.bookmarklet.txt' }, video: { path: 'docs/demo.mp4' } }))
  assert.match(real.tools[0].video.src, /\.mp4$/)
})

test('a downloaded page that is not an image is not linked as one', async () => {
  const hooks = (url, u) => (u.host === 'example.com' ? new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) : undefined)
  const r = await runBuild({ ...single('Alpha', { 'README.md': '![s](https://example.com/blob/shot.png)' }, { bookmarklet: false }), hooks })
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.tools[0].image, null)
})

test('a truncated file list still finds the configured bookmarklet', async () => {
  const r = await runBuild({ ...single('Big'), files: { Big: { 'README.md': '# a', 'x.bookmarklet.txt': BM } }, truncated: new Set(['Big']) })
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.tools[0].bookmarklet?.path, 'x.bookmarklet.txt')
})

test('a repository video that GitHub cannot serve stops the build instead of publishing the card without it', async () => {
  const hooks = (url) => (url.includes('/contents/docs/demo.mp4') ? new Response('busy', { status: 503 }) : undefined)
  const r = await runBuild({ ...single('Alpha', { 'docs/demo.mp4': mp4() }, { bookmarklet: { path: 'x.bookmarklet.txt' }, video: { path: 'docs/demo.mp4' } }), hooks })
  assert.equal(r.ok, false)
  assert.match(r.error.message, /could not download video docs\/demo\.mp4/)
})

test('a 429 with Retry-After waits as long as GitHub asks, then goes on', async () => {
  let first = true
  const hooks = (url) => {
    if (url.includes('/releases/latest') && first) {
      first = false
      return new Response('slow down', { status: 429, headers: { 'retry-after': '7' } })
    }
    return undefined
  }
  const r = await runBuild({ ...single('Alpha'), hooks })
  assert.ok(r.ok, r.error?.message)
  assert.ok(r.sleeps.includes(7000), `waited ${r.sleeps}`)
})

test('the README summary keeps snake_case words and decodes entities', () => {
  assert.equal(firstReadmeParagraph('Exports the snake_case_names of every column in a Dataverse table to a CSV file.'), 'Exports the snake_case_names of every column in a Dataverse table to a CSV file.')
  assert.equal(firstReadmeParagraph('A **bold** claim and an *italic* one, plus `code_span` and Tom &amp; Jerry in one line.'), 'A bold claim and an italic one, plus code_span and Tom & Jerry in one line.')
  assert.equal(firstReadmeParagraph('```js\nconsole.log("an unclosed fence is not a summary, even a long one like this")'), '')
})

test('a connection that drops while the body downloads is retried', async () => {
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '50000' })
    if (hits === 1) {
      res.write('javascript:')
      setTimeout(() => req.socket.destroy(), 20)
      return
    }
    res.end('javascript:'.padEnd(50000, 'x'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const gh = new GitHub({ apiUrl: `http://127.0.0.1:${server.address().port}`, sleep: async () => {} })
    assert.equal((await gh.fileText('o', 'r', 'abc', 'x.txt')).length, 50000)
    assert.equal(hits, 2)
  } finally {
    server.close()
  }
})

test('the self-check refuses a button whose icon would add text to the favourite’s name', () => {
  const tool = { repo: 'R', slug: 'r', bookmarklet: { href: BM, label: 'Level Up' } }
  const html = (inner) => `<a class="bm" id="bm-r" href="${BM.replace(/"/g, '&quot;')}" draggable="true">${inner}</a>`
  assert.doesNotThrow(() => selfCheck(html('<svg aria-hidden="true"><path d="M0 0"/></svg>Level Up'), [tool]))
  assert.throws(() => selfCheck(html('<svg aria-hidden="true"><desc>Star icon</desc><path/></svg>Level Up'), [tool]), /Star iconLevel Up/)
})

test('the output folder can never be the sources', async () => {
  for (const out of [path.join(here, '..'), path.join(here, '..', '..'), here]) {
    await assert.rejects(build({ out, config: config(), github: {}, only: ['x'], log: () => {}, annotate: false, ownerId: 0, summaryFile: '' }), /would contain or replace the site's sources/)
  }
})

test('the content hash does not depend on the machine’s time zone or language', async () => {
  const script = `import { runBuild, single, repo } from ${JSON.stringify(path.join(here, 'fake-github.mjs'))}
const o = single('delta')
for (const name of ['idris', 'Ilk', 'Zeta', 'émile']) { o.repos.push(repo(name)); o.files[name] = { 'x.bookmarklet.txt': 'javascript:void(1)' } }
const r = await runBuild(o)
console.log(r.contentHash + ' ' + r.tools.map((t) => t.repo).join(','))`
  const run = async (env) => (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env } })).stdout.trim()
  const a = await run({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })
  const b = await run({ TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' })
  assert.equal(a, b)
})

test('the site never lists its own repository, wherever it lives', async () => {
  const { discoverRepos } = await import('../lib/collect.mjs')
  const listing = ['octo', 'octo.github.io', 'toolkit-site', 'Real'].map((name) => repo(name))
  const gh = { paginate: async () => listing }
  const shown = await discoverRepos(gh, { owner: 'octo', self: 'toolkit-site' })
  assert.deepEqual(shown.map((r) => r.name), ['Real'])
})

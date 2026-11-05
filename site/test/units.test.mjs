// Unit tests for the build's helpers. Run with: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanVersion, esc, formatDate, safeUrl, slugify, titleFromRepoName, unesc } from '../lib/text.mjs'
import { bookmarkletCandidates, parseBookmarklet, percentDecode, survivesUrlParser, MAX_BOOKMARKLET_CHARS } from '../lib/bookmarklet.mjs'
import { firstReadmeImage, imageSize } from '../lib/media.mjs'
import { firstReadmeParagraph } from '../lib/collect.mjs'
import { GitHub, assertPublicHttps, nextLink } from '../lib/github.mjs'

test('esc and unesc round-trip anything, including entity-like text', () => {
  for (const s of ['plain', 'a&b', 'x&amp;y', '"quoted" \'single\'', '<b>&lt;</b>', '&#39;&quot;', 'javascript:void(a&&b<c>d)']) {
    assert.equal(unesc(esc(s)), s)
    assert.doesNotMatch(esc(s), /["<>']/)
  }
})

test('repository names become display names', () => {
  assert.equal(titleFromRepoName('SQLAdvancedFind'), 'SQL Advanced Find')
  assert.equal(titleFromRepoName('LevelUpBookmarklet'), 'Level Up Bookmarklet')
  assert.equal(titleFromRepoName('NToNMultiSelect'), 'N To N Multi Select')
  assert.equal(titleFromRepoName('DataverseImpersonator'), 'Dataverse Impersonator')
  assert.equal(titleFromRepoName('beta-helper_v2'), 'Beta helper v2')
})

test('slugs are ids', () => {
  assert.equal(slugify('N:N Multi-Select'), 'n-n-multi-select')
  assert.equal(slugify('Ünmanaged  Layer Scanner'), 'unmanaged-layer-scanner')
  assert.equal(slugify('!!!'), 'tool')
})

test('versions, dates and URLs are cleaned', () => {
  assert.equal(cleanVersion('v1.0.3'), '1.0.3')
  assert.equal(cleanVersion('2.0.0-beta.1'), '2.0.0-beta.1')
  assert.equal(cleanVersion('latest'), '')
  assert.equal(formatDate('2026-11-02T23:59:59Z'), 'Nov 2, 2026')
  assert.equal(safeUrl('https://example.com/a b'), 'https://example.com/a%20b')
  assert.equal(safeUrl('javascript:alert(1)'), '')
  assert.equal(safeUrl('data:text/html,x'), '')
  assert.equal(safeUrl('not a url'), '')
})

test('a bookmarklet file is used as it is, trimmed', () => {
  const r = parseBookmarklet('﻿  javascript:void(alert("a&b"))%3B \n')
  assert.deepEqual(r, { ok: true, href: 'javascript:void(alert("a&b"))%3B', encodedControlChars: 0 })
  assert.equal(parseBookmarklet('JavaScript:x()').ok, true)
  assert.equal(parseBookmarklet('function x() {}').ok, false)
  assert.equal(parseBookmarklet('javascript:').ok, false)
})

test('raw tabs and line breaks are percent-encoded, since a browser would delete them', () => {
  const r = parseBookmarklet('javascript:a()//c\nb()\t')
  assert.equal(r.href, 'javascript:a()//c%0Ab()')
  assert.equal(r.encodedControlChars, 1)
  assert.equal(parseBookmarklet('javascript:a()\tb()').href, 'javascript:a()%09b()')
})

test('oversized bookmarklets are refused', () => {
  assert.equal(parseBookmarklet(`javascript:${'x'.repeat(MAX_BOOKMARKLET_CHARS)}`).ok, false)
})

test('percentDecode decodes like a browser and never throws', () => {
  assert.equal(percentDecode('a%20b%zz%'), 'a b%zz%')
  assert.equal(percentDecode('%C3%A9 é'), 'é é')
  assert.equal(percentDecode('%F0%9F%98%80 😀'), '😀 😀')
})

test('the URL parser check catches code a browser would change', () => {
  assert.equal(survivesUrlParser("javascript:alert('x?y')%3B aé"), true)
  assert.equal(survivesUrlParser('javascript:a\tb'), false)
})

test('bookmarklet files are found in the owner’s real repository layouts', () => {
  const blob = (path, size = 5000) => ({ path, type: 'blob', size })
  const levelUp = [blob('.gitignore'), blob('LICENSE'), blob('LevelUpBookmarklet.js', 297606), blob('README.md'), blob('package.json'), blob('scripts/build.mjs'), blob('src/bookmarklet-entry.ts'), blob('src/app.ts'), blob('tsconfig.json')]
  assert.equal(bookmarkletCandidates(levelUp)[0], 'LevelUpBookmarklet.js')
  const scanner = [blob('build-bookmarklet.mjs'), blob('layer-scanner.js', 251283), blob('layer-scanner.bookmarklet.txt', 71899), blob('layer-scanner.min.js', 170756), blob('Install unmanaged layer scanner.html'), blob('scanner.settings.example.json')]
  assert.equal(bookmarkletCandidates(scanner)[0], 'layer-scanner.bookmarklet.txt')
  const translator = [blob('src/main.ts'), blob('dist/translator.bookmarklet.txt', 268135), blob('dist/translator.min.js', 641152), blob('dist/translator.debug.js', 1094005), blob('tools/build.mjs'), blob('SECURITY.md')]
  assert.equal(bookmarkletCandidates(translator)[0], 'dist/translator.bookmarklet.txt')
  const sql = [blob('LICENSE'), blob('README.md'), blob('SQLAdvancedFind.js', 80330), blob('THIRD-PARTY-NOTICES.md')]
  assert.deepEqual(bookmarkletCandidates(sql), ['SQLAdvancedFind.js'])
  const impersonator = [blob('Bookmarklet.txt', 326), blob('Dataverse-Impersonator.ps1')]
  assert.equal(bookmarkletCandidates(impersonator)[0], 'Bookmarklet.txt')
  assert.deepEqual(bookmarkletCandidates([blob('node_modules/x/bookmarklet.js'), blob('src/bookmarklet.txt'), blob('eslint.config.js'), blob('package-lock.json')]), [])
})

test('image sizes are read from file headers', () => {
  const png = Buffer.alloc(33)
  png.writeUInt32BE(0x89504e47, 0)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(1280, 16)
  png.writeUInt32BE(720, 20)
  assert.deepEqual(imageSize(png), { width: 1280, height: 720, type: 'image/png' })
  const gif = Buffer.alloc(24)
  gif.write('GIF89a', 0, 'ascii')
  gif.writeUInt16LE(640, 6)
  gif.writeUInt16LE(480, 8)
  assert.deepEqual(imageSize(gif), { width: 640, height: 480, type: 'image/gif' })
  // JPEG: SOI, an APP0 segment, then SOF0 with height 300 and width 400
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300, type: 'image/jpeg' })
  const webp = Buffer.alloc(30)
  webp.write('RIFF', 0, 'ascii')
  webp.write('WEBPVP8X', 8, 'ascii')
  webp.writeUIntLE(999, 24, 3)
  webp.writeUIntLE(499, 27, 3)
  assert.deepEqual(imageSize(webp), { width: 1000, height: 500, type: 'image/webp' })
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
})

test('the README picture skips badges and resolves relative paths', () => {
  const md = [
    '<p align="center"><img src="https://img.shields.io/badge/x-y-blue" alt="badge"></p>',
    '[![CI](https://github.com/o/r/actions/workflows/ci.yml/badge.svg)](x)',
    '![Logo](logo.svg)',
    '![The tool in action](./docs/shot%20one.png "title")',
    '<img src="https://example.com/later.png">',
  ].join('\n')
  assert.deepEqual(firstReadmeImage(md), { src: '', alt: 'The tool in action', repoPath: 'docs/shot one.png' })
  assert.deepEqual(firstReadmeImage('<img width="975" alt="image" src="https://github.com/user-attachments/assets/abc" />'), { src: 'https://github.com/user-attachments/assets/abc', alt: 'image', repoPath: '' })
  assert.deepEqual(firstReadmeImage('![x](../outside.png)\n![y](img/a.png)', 'docs/README.md'), { src: '', alt: 'x', repoPath: 'outside.png' })
  assert.equal(firstReadmeImage('no pictures here'), null)
  assert.equal(firstReadmeImage('![plain http](http://example.com/a.png)'), null)
  assert.deepEqual(firstReadmeImage('![odd](docs/50%off.png)'), { src: '', alt: 'odd', repoPath: 'docs/50%off.png' }) // a stray % is kept as written
})

test('the README paragraph skips headings, badges and tables', () => {
  const md = '# Title\n\n[![b](https://img.shields.io/x)](y)\n\n| a | b |\n| - | - |\n\nA **browser** bookmarklet for [Dataverse](https://example.com) that does something useful for administrators.\n\nMore.'
  assert.equal(firstReadmeParagraph(md), 'A browser bookmarklet for Dataverse that does something useful for administrators.')
  assert.ok(firstReadmeParagraph(`Intro ${'word '.repeat(100)}`).endsWith('…'))
})

test('Link headers give the next page', () => {
  assert.equal(nextLink('<https://api.github.com/user/1/repos?page=2>; rel="next", <https://api.github.com/user/1/repos?page=5>; rel="last"'), 'https://api.github.com/user/1/repos?page=2')
  assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), null)
  assert.equal(nextLink(null), null)
})

test('the client retries server errors and sends its token to the API only', async () => {
  const seen = []
  let calls = 0
  const fetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization })
    if (url.startsWith('https://api.github.com/flaky') && calls++ === 0) return new Response('busy', { status: 502 })
    if (url.endsWith('/missing')) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  const gh = new GitHub({ token: 'secret', fetch, sleep: async () => {} })
  assert.deepEqual(await gh.json('/flaky'), { ok: true })
  assert.equal(await gh.json('/missing', { allow404: true }), null)
  await assert.rejects(gh.json('/missing'), /404/)
  await gh.download('https://images.example.com/a.png')
  assert.equal(seen.find((s) => s.url.startsWith('https://images.example.com')).auth, undefined)
  assert.ok(seen.filter((s) => s.url.startsWith('https://api.github.com')).every((s) => s.auth === 'Bearer secret'))
})

test('pictures are downloaded from public https hosts only', async () => {
  let calls = 0
  const gh = new GitHub({ token: 'secret', fetch: async () => { calls++; return new Response('x') }, sleep: async () => {} })
  for (const url of ['http://api.github.com/x.png', 'http://example.com/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://metadata.internal/a.png']) {
    await assert.rejects(gh.download(url), /only/, url)
  }
  assert.equal(calls, 0)
  assert.doesNotThrow(() => assertPublicHttps('https://github.com/user-attachments/assets/abc'))
})

test('a download stops as soon as it passes the size limit, whatever the server declares', async () => {
  let pulled = 0
  const endless = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(64 * 1024)) } })
  const gh = new GitHub({ fetch: async () => new Response(endless), sleep: async () => {} })
  await assert.rejects(gh.download('https://images.example.com/huge.png', { maxBytes: 1024 * 1024 }), /over the 1048576 byte limit/)
  assert.ok(pulled < 40, `read ${pulled} chunks`)
})

test('an error from another host does not carry its body into the build log', async () => {
  const gh = new GitHub({ fetch: async () => new Response('db_password=hunter2', { status: 500 }), retries: 0, sleep: async () => {} })
  await assert.rejects(gh.download('https://images.example.com/a.png'), (error) => !error.message.includes('hunter2'))
})

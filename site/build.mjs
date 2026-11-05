#!/usr/bin/env node
// Builds the toolkit site into _site/. It reads the owner's public repositories on GitHub, takes the bookmarklet each
// one has committed (plus its version, release and pictures), and writes one static page whose buttons can be dragged
// onto the favourites bar. GitHub Actions runs it every hour (.github/workflows/site.yml), so the page follows the
// repositories by itself. No dependencies: Node.js 22 or newer.
//
//   node site/build.mjs                                 build everything into _site/
//   SITE_REPOS=LevelUpBookmarklet node site/build.mjs   only these repositories (skips the account listing)
//
// Environment: GITHUB_TOKEN (raises the API limit from 60 to 1,000+ requests an hour; Actions provides it),
// GITHUB_API_URL, SITE_URL (the published address, from actions/configure-pages), SITE_OUT (output folder, default
// _site), SITE_FRAGMENT=1 (index.html without its document head, for previews).
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHub } from './lib/github.mjs'
import { collectTool, discoverRepos } from './lib/collect.mjs'
import { renderNotFound, renderPage } from './lib/render.mjs'
import { formatDate, unesc } from './lib/text.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const RESERVED_IDS = ['howto', 'toast', 'announcer']

/**
 * @param {object} [options]
 * @param {string} [options.out]        output folder
 * @param {boolean} [options.fragment]  write index.html without its document head (for previews)
 * @param {object} [options.config]     the parsed site/config.json (read from disk when left out)
 * @param {GitHub} [options.github]     the client (tests pass one with a fake fetch)
 * @param {string[]} [options.only]     read only these repositories instead of listing the account
 * @param {string} [options.siteUrl]    the published address
 * @param {number} [options.ownerId]    the owner's account id, checked against the repositories (0: not checked)
 * @param {(line: string) => void} [options.log]
 */
export async function build({
  out = path.resolve(root, process.env.SITE_OUT || '_site'),
  fragment = process.env.SITE_FRAGMENT === '1',
  config,
  github,
  only = (process.env.SITE_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  siteUrl = process.env.SITE_URL || '',
  log = console.log,
  annotate = process.env.GITHUB_ACTIONS === 'true',
  // The owner's numeric account id, when site/config.json has none ("ownerId"): Actions gives the repository's.
  ownerId = Number(process.env.GITHUB_REPOSITORY_OWNER_ID || 0),
  summaryFile = process.env.GITHUB_STEP_SUMMARY || '',
  // The repository the build runs in ("owner/name"): never shown as a tool of its own.
  selfRepo = process.env.GITHUB_REPOSITORY || '',
} = {}) {
  config ??= JSON.parse(await readFile(path.join(here, 'config.json'), 'utf8'))
  checkConfig(config)
  const owner = config.owner
  const gh = github || new GitHub({ token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '', apiUrl: process.env.GITHUB_API_URL || undefined, log })
  const warnings = []
  // A warning can quote text from a repository (a README's picture path): keep it on one line, and escape it as
  // GitHub's workflow commands require, so it can never read as a command of its own.
  const warn = (text) => {
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    const message = String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 1000)
    warnings.push(message)
    log(annotate ? `::warning::${message.replace(/%/g, '%25')}` : `warning: ${message}`)
  }

  // The output folder is deleted first: never let that be the sources or a folder holding them.
  const target = path.resolve(out)
  if (target === root || root.startsWith(target + path.sep) || target === here || target.startsWith(here + path.sep)) {
    throw new Error(`The output folder ${target} would contain or replace the site's sources: use an empty folder such as _site.`)
  }
  await rm(out, { recursive: true, force: true })
  await mkdir(path.join(out, 'media'), { recursive: true })
  const saveMedia = async (name, buffer) => {
    await writeFile(path.join(out, 'media', name), buffer)
    return `media/${name}`
  }

  log(`Reading the public repositories of ${owner}${only.length ? ` (only ${only.join(', ')})` : ''}…`)
  const [selfOwner, selfName] = selfRepo.split('/')
  const self = selfOwner && selfOwner.toLowerCase() === owner.toLowerCase() ? selfName : ''
  const repos = await discoverRepos(gh, { owner, ownerId: Number(config.ownerId) || ownerId, exclude: config.exclude || [], only, self })
  const entries = Object.entries(config.tools || {})
  const configs = new Map()
  for (const [key, cfg] of entries) if (!configs.has(key.toLowerCase())) configs.set(key.toLowerCase(), cfg)
  const renamed = new Map() // old name -> new name, both lower case
  if (!only.length) {
    for (const [key, cfg] of entries) {
      if (repos.some((r) => r.name.toLowerCase() === key.toLowerCase())) continue
      // A renamed repository keeps its entry (its text, and "bookmarklet": false): GitHub still answers the old name,
      // redirecting to the repository under its new one.
      const moved = await gh.json(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(key)}`, { allow404: true })
      const now = moved && repos.find((r) => r.id === moved.id)
      if (now && !configs.has(now.name.toLowerCase())) {
        configs.set(now.name.toLowerCase(), cfg)
        renamed.set(key.toLowerCase(), now.name.toLowerCase())
        warn(`site/config.json describes ${key}, which is now called ${now.name}: rename its entry (and in "order").`)
      } else {
        warn(`site/config.json describes ${key}, which is not one of ${owner}'s public repositories (private, archived or excluded?).`)
      }
    }
  }
  const configFor = (name) => configs.get(name.toLowerCase()) || {}

  const tools = (
    await mapLimit(repos, 4, async (repo) => {
      const tool = await collectTool(gh, repo, configFor(repo.name), { owner, saveMedia, warn })
      if (tool) log(`  ${repo.name}: ${tool.bookmarklet ? `bookmarklet ${tool.bookmarklet.path} (${tool.bookmarklet.chars} characters)` : 'no bookmarklet'}${tool.version ? `, version ${tool.version}` : ''}`)
      return tool
    })
  ).filter(Boolean)

  // Order: as listed in the config, then the most recently changed first.
  const order = (config.order || []).map((name) => renamed.get(name.toLowerCase()) || name.toLowerCase())
  const rank = (t) => {
    const i = order.indexOf(t.repo.toLowerCase())
    return i === -1 ? order.length : i
  }
  tools.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || byCodePoint(a.repo, b.repo))
  const seen = new Set()
  for (const tool of tools) {
    // Each slug is an id on the page (#slug, bm-slug, slug-title…): keep them unique and clear of the page's own ids.
    // A prefix moves a slug off "bm-…" or a reserved id; a numbered suffix then only resolves repeats.
    const base = RESERVED_IDS.includes(tool.slug) || tool.slug.startsWith('bm-') ? `tool-${tool.slug}` : tool.slug
    let slug = base
    for (let n = 2; seen.has(slug); n++) slug = `${base}-${n}`
    tool.slug = slug
    seen.add(slug)
  }

  // Assets are copied as they are and referenced with a hash of their content, so a new page never meets a cached
  // old stylesheet or script (GitHub Pages lets browsers cache files for 10 minutes).
  const assetsIn = path.join(here, 'assets')
  await copyTree(assetsIn, path.join(out, 'assets'))
  // (A preview fragment is served as plain files, so it gets plain names.)
  const versioned = async (file) => (fragment ? `assets/${file}` : `assets/${file}?v=${sha256(await readFile(path.join(assetsIn, file))).slice(0, 10)}`)
  const assets = {
    css: await versioned('site.css'),
    js: await versioned('site.js'),
    favicon: await versioned('favicon.svg'),
    fonts: ['assets/fonts/archivo-variable.woff2'],
  }

  const latestUpdate = tools.flatMap((t) => [t.updatedAt, t.bookmarklet?.updatedAt]).filter(Boolean).sort().at(-1) || ''
  const url = (siteUrl || config.site.url || '').replace(/\/?$/, '/')
  const site = {
    ...config.site,
    url: url === '/' ? '' : url,
    ownerUrl: `https://github.com/${owner}`,
    sourceUrl: `https://github.com/${process.env.GITHUB_REPOSITORY || `${owner}/${owner}`}/tree/main/site`,
  }
  // A preview is shown where pictures from other sites are blocked: those tools show their placeholder instead.
  if (fragment) for (const t of tools) if (t.image && /^https?:/.test(t.image.src)) t.image = null
  const socialImage = tools.find((t) => t.image && !/^https?:/.test(t.image.src))?.image.src || ''
  const model = { site, tools, latestUpdate, assets, socialImage }
  const html = renderPage(model, { fragment })
  selfCheck(html, tools)
  await writeFile(path.join(out, 'index.html'), html)
  await writeFile(path.join(out, '404.html'), renderNotFound(model))

  // build.json describes the build. Its contentHash covers every published file (but not this file, whose time stamp
  // changes every run), so the workflow can tell whether anything changed since the live site was built.
  const files = await listFiles(out)
  const contentHash = sha256((await Promise.all(files.map(async (f) => `${f}\0${sha256(await readFile(path.join(out, f)))}`))).join('\n'))
  const info = {
    contentHash,
    builtAt: new Date().toISOString(),
    source: process.env.GITHUB_SHA || '',
    latestUpdate,
    tools: tools.map((t) => ({
      repo: t.repo,
      commit: t.commit,
      version: t.version,
      bookmarklet: t.bookmarklet ? { path: t.bookmarklet.path, chars: t.bookmarklet.chars, sha256: t.bookmarklet.sha256, updatedAt: t.bookmarklet.updatedAt } : null,
    })),
    warnings,
  }
  await writeFile(path.join(out, 'build.json'), `${JSON.stringify(info, null, 2)}\n`)
  if (annotate && summaryFile) await appendFile(summaryFile, summary(tools, contentHash, warnings))

  log(`Built ${path.relative(root, out) || out}: ${tools.length} tools (${tools.filter((t) => t.bookmarklet).length} bookmarklets), index.html ${Math.round(Buffer.byteLength(html) / 1024)} KB, ${gh.requests} requests, content ${contentHash.slice(0, 12)}${warnings.length ? `, ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}.`)
  return { out, tools, contentHash, warnings, html }
}

/**
 * Reads every drag button back out of the finished HTML: its href must be byte for byte the bookmarklet file, and its
 * text exactly the favourite's name (a browser names the favourite after all of the link's text, hidden text too).
 */
export function selfCheck(html, tools) {
  for (const t of tools.filter((tool) => tool.bookmarklet)) {
    const match = html.match(new RegExp(`<a class="bm" id="bm-${t.slug}" href="([^"]*)"[^>]*>([\\s\\S]*?)</a>`))
    if (!match) throw new Error(`Self-check: the button of ${t.repo} is missing from the page.`)
    if (unesc(match[1]) !== t.bookmarklet.href) throw new Error(`Self-check: the button of ${t.repo} does not hold its bookmarklet exactly.`)
    // All of the link's text, as the browser takes it: text inside the icon (<title>, <desc>, <text>) counts too.
    const text = unesc(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (text !== t.bookmarklet.label.replace(/\s+/g, ' ').trim()) throw new Error(`Self-check: the button of ${t.repo} would name the favourite "${text}" instead of "${t.bookmarklet.label}".`)
  }
}

function checkConfig(config) {
  if (!config || typeof config.owner !== 'string' || !config.owner) throw new Error('site/config.json needs "owner": the GitHub account whose repositories are shown.')
  if (!config.site || typeof config.site !== 'object') throw new Error('site/config.json needs a "site" object (title, headline…).')
  for (const [name, tool] of Object.entries(config.tools || {})) {
    if (tool.bookmarklet !== undefined && tool.bookmarklet !== false && (typeof tool.bookmarklet !== 'object' || tool.bookmarklet === null)) throw new Error(`site/config.json: tools.${name}.bookmarklet must be an object ({ "path": … }) or false.`)
    for (const key of ['image', 'video']) {
      if (tool[key] !== undefined && tool[key] !== false && (typeof tool[key] !== 'object' || tool[key] === null)) throw new Error(`site/config.json: tools.${name}.${key} must be an object ({ "path": … } or { "url": … }).`)
    }
  }
}

function summary(tools, contentHash, warnings) {
  const rows = tools.map((t) => `| [${t.name}](${t.url}) | ${t.bookmarklet ? `\`${t.bookmarklet.path}\` (${t.bookmarklet.chars.toLocaleString('en-US')} characters)` : 'not a bookmarklet'} | ${t.version || ''} | ${formatDate(t.bookmarklet?.updatedAt || t.updatedAt)} |`)
  return [
    '### Toolkit site',
    '',
    '| Tool | Bookmarklet | Version | Updated |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Content hash \`${contentHash.slice(0, 12)}\`.`,
    ...(warnings.length ? ['', '**Warnings**', '', ...warnings.map((w) => `- ${w}`)] : []),
    '',
  ].join('\n')
}

/** Sorts by code point, not by the machine's locale, so the order (and the content hash) is the same everywhere. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dest)
    else await copyFile(src, dest)
  }
}

async function listFiles(dir, prefix = '') {
  const files = []
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => byCodePoint(a.name, b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), rel)))
    else if (rel !== 'build.json') files.push(rel)
  }
  return files
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build().catch((error) => {
    // One line, escaped like the warnings, so the message can never read as a workflow command of its own.
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    const message = String(error.message).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message.replace(/%/g, '%25')}` : `error: ${message}`)
    process.exitCode = 1
  })
}

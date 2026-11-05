// Collects what the page shows for each repository: its bookmarklet (if it ships one), version, release, dates,
// image and video. Everything is read at one exact commit of the default branch, so a build never mixes two versions.
import { createHash } from 'node:crypto'
import { bookmarkletCandidates, parseBookmarklet, survivesUrlParser } from './bookmarklet.mjs'
import { firstReadmeImage, imageSize } from './media.mjs'
import { cleanVersion, isPublicHttps, safeUrl, slugify, titleFromRepoName } from './text.mjs'

const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_VIDEO_BYTES = 25 * 1024 * 1024
const README_CHARS = 32 * 1024
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const positive = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0)

/**
 * The public repositories to show: the owner's own, not forks, not archived, not excluded, and not the site's own
 * (the profile repository <owner>/<owner>, a <owner>.github.io repository, or `self`, the one the build runs in).
 * With `only` (from the SITE_REPOS variable, for local runs) the listing is skipped and just those are read.
 */
export async function discoverRepos(gh, { owner, ownerId = 0, exclude = [], only = [], self = '' }) {
  const own = [owner, `${owner}.github.io`, self].filter(Boolean).map((name) => name.toLowerCase())
  const skip = new Set([...own, ...exclude.map((name) => name.toLowerCase())])
  const repos = only.length
    ? await Promise.all(only.map((name) => gh.json(`/repos/${owner}/${encodeURIComponent(name)}`)))
    : await gh.paginate(`/users/${encodeURIComponent(owner)}/repos?type=owner&sort=full_name&per_page=100`)
  // A renamed account frees its old name for anyone: the account id, which never changes, must still match.
  if (ownerId && repos.some((r) => r && r.owner && r.owner.id !== ownerId)) {
    throw new Error(`The GitHub account "${owner}" is no longer account ${ownerId} (renamed?). Update "owner" and "ownerId" in site/config.json.`)
  }
  return repos.filter((r) => r && !r.private && !r.fork && !r.archived && !r.disabled && r.owner?.login?.toLowerCase() === owner.toLowerCase() && !skip.has(r.name.toLowerCase()))
}

/**
 * Reads one repository.
 * @param {import('./github.mjs').GitHub} gh
 * @param {object} repo     an item of the repository listing
 * @param {object} cfg      this repository's entry in site/config.json ({} when it has none)
 * @param {object} context  { owner, saveMedia(name, buffer) -> published path, warn(message) }
 * @returns the tool, or null for a repository with nothing to show yet (no commit on its default branch)
 */
export async function collectTool(gh, repo, cfg, { owner, saveMedia, warn }) {
  const name = repo.name
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const branch = repo.default_branch ? await gh.json(`${base}/branches/${encodeURIComponent(repo.default_branch)}`, { allow404: true }) : null
  if (!branch) {
    // A new repository has no commits (and so no branch) until its first push. A configured bookmarklet tool must
    // have one, though: stop, so the live page keeps its button.
    if (cfg.bookmarklet) throw new Error(`${name}: its default branch ${repo.default_branch} does not exist, so its bookmarklet cannot be read.`)
    warn(`${name}: has no commits yet, so it is not shown.`)
    return null
  }
  const commit = branch.commit.sha
  const committedAt = branch.commit.commit.committer.date
  const treeResponse = await gh.json(`${base}/git/trees/${commit}?recursive=1`)
  const files = new Map(treeResponse.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e]))
  if (treeResponse.truncated) {
    warn(`${name}: the file list is truncated (very large repository); a bookmarklet deep in it may be missed.`)
    // The list is partial: trust the paths site/config.json names (a wrong one then fails to download instead).
    for (const p of [cfg.bookmarklet?.path, cfg.image?.path, cfg.video?.path]) if (p && !files.has(p)) files.set(p, { path: p, type: 'blob' })
  }

  const displayName = cfg.name || titleFromRepoName(name)
  const tool = {
    repo: name,
    slug: slugify(cfg.slug || displayName),
    name: displayName,
    icon: cfg.icon || 'bookmark',
    url: repo.html_url,
    // The one line about the tool: the config's, else the repository's description (else, below, the README's first
    // paragraph).
    tagline: cfg.tagline || repo.description || '',
    credit: cfg.credit || '',
    commit,
    updatedAt: committedAt,
    version: '',
    release: null,
    bookmarklet: null,
    image: null,
    video: null,
  }

  // The bookmarklet: the configured file first, then whatever looks like one. A tool the config calls a bookmarklet
  // must have one, or the build stops (and the live site keeps its last good buttons).
  if (cfg.bookmarklet !== false) {
    const wanted = cfg.bookmarklet?.path
    if (wanted && !files.has(wanted)) warn(`${name}: ${wanted} (named in site/config.json) is not in the repository; looking for another bookmarklet file.`)
    const candidates = [...new Set([...(wanted && files.has(wanted) ? [wanted] : []), ...bookmarkletCandidates([...files.values()])])]
    for (const path of candidates) {
      const parsed = parseBookmarklet(await gh.fileText(owner, name, commit, path))
      if (!parsed.ok) {
        if (path === wanted) warn(`${name}: ${path} is not a bookmarklet: ${parsed.reason}.`)
        continue
      }
      if (parsed.encodedControlChars) warn(`${name}: ${path} has ${parsed.encodedControlChars} raw control characters; they were percent-encoded so the browser keeps them.`)
      if (!survivesUrlParser(parsed.href)) warn(`${name}: a browser would change the code of ${path} when saving it as a favourite (an unencoded % or # in the code?). Check the file's encoding.`)
      const history = await gh.json(`${base}/commits?sha=${commit}&path=${encodeURIComponent(path)}&per_page=1`)
      tool.bookmarklet = {
        path,
        label: cfg.bookmarklet?.label || displayName,
        href: parsed.href,
        chars: parsed.href.length,
        sha256: sha256(parsed.href),
        updatedAt: history?.[0]?.commit?.committer?.date || committedAt,
      }
      break
    }
    if (!tool.bookmarklet && cfg.bookmarklet) throw new Error(`${name}: site/config.json says it ships a bookmarklet, but no file in it starts with javascript:. Fix "bookmarklet.path" in site/config.json (or set "bookmarklet": false).`)
  }

  // Version: package.json at the root (what the committed build was made from), else the latest release tag.
  const release = await gh.json(`${base}/releases/latest`, { allow404: true })
  if (release) tool.release = { tag: release.tag_name, name: release.name || release.tag_name, url: release.html_url, publishedAt: release.published_at, assets: (release.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })) }
  if (files.has('package.json')) {
    try {
      tool.version = cleanVersion(JSON.parse(await gh.fileText(owner, name, commit, 'package.json')).version)
    } catch (error) {
      warn(`${name}: package.json could not be read (${error.message}).`)
    }
  }
  if (!tool.version && release) tool.version = cleanVersion(release.tag_name)

  // Image: the configured file or URL, else the first picture of the README. Downloaded and published with the site.
  let image = cfg.image === undefined ? 'auto' : cfg.image
  const readme = image === 'auto' || !tool.tagline ? await gh.json(`${base}/readme`, { allow404: true }) : null
  // Only the start of the README is read: the picture and first paragraph are near the top, and a bounded input
  // keeps the regular expressions below fast whatever the README holds.
  const readmeText = readme?.content ? Buffer.from(readme.content, 'base64').toString('utf8').slice(0, README_CHARS) : ''
  // Whatever a README holds, reading it never stops the build: at worst the tool shows without a picture or summary.
  try {
    if (image === 'auto') {
      const found = readmeText ? firstReadmeImage(readmeText, readme.path) : null
      image = found ? { path: found.repoPath || undefined, url: found.src || undefined, alt: found.alt } : null
    }
    if (!tool.tagline && readmeText) tool.tagline = firstReadmeParagraph(readmeText)
  } catch (error) {
    warn(`${name}: its README could not be read for a picture or summary (${error.message}).`)
    if (image === 'auto') image = null
  }
  if (image) tool.image = await fetchMedia(gh, { owner, name, commit, files, media: image, kind: 'image', slug: tool.slug, saveMedia, warn })
  if (tool.image && !tool.image.alt) tool.image.alt = `Screenshot of ${displayName}`
  if (cfg.video) tool.video = await fetchMedia(gh, { owner, name, commit, files, media: cfg.video, kind: 'video', slug: tool.slug, saveMedia, warn })

  return tool
}

/** Downloads an image or video from the repository (at the commit) or from a URL, and saves it with the site. */
async function fetchMedia(gh, { owner, name, commit, files, media, kind, slug, saveMedia, warn }) {
  const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
  let url = ''
  if (media.path) {
    if (!files.has(media.path)) {
      warn(`${name}: ${kind} ${media.path} is not in the repository.`)
      return null
    }
    url = gh.fileUrl(owner, name, commit, media.path)
  } else {
    url = safeUrl(media.url)
    if (!isPublicHttps(url)) {
      if (media.url) warn(`${name}: ${kind} ${media.url} left out: only public https addresses are used.`)
      return null
    }
  }
  let downloaded
  try {
    downloaded = await gh.download(url, { maxBytes })
  } catch (error) {
    const definite = error.final || error.status === 404 // too big, not allowed or not there: the same answer every time
    // GitHub could not be read: stop, so the live page keeps its pictures, rather than publish the card without them.
    if (media.path && !definite) throw new Error(`${name}: could not download ${kind} ${media.path}: ${error.message}`)
    // A picture hosted elsewhere that cannot be downloaded right now is linked instead.
    if (!media.path && kind === 'image' && !definite) {
      warn(`${name}: could not download ${url} (${error.message}); linking to it instead.`)
      return { src: url, width: positive(media.width), height: positive(media.height), alt: media.alt || '', bytes: 0 }
    }
    warn(`${name}: ${kind} ${media.path || url} left out: ${error.message}`)
    return null
  }
  // What was downloaded is checked by its bytes: a file that is not a picture or video is left out, never linked.
  const { buffer } = downloaded
  const size = kind === 'image' ? imageSize(buffer) : null
  const ext = kind === 'image' ? size?.type.split('/')[1].replace('jpeg', 'jpg') : videoType(buffer)
  if (!ext) {
    warn(`${name}: ${kind} ${media.path || url} left out: it is not ${kind === 'image' ? 'a PNG, GIF, JPEG or WebP image' : 'an MP4 or WebM video'}.`)
    return null
  }
  const src = await saveMedia(`${slug}-${sha256(buffer).slice(0, 10)}.${ext}`, buffer)
  return { src, width: size?.width || 0, height: size?.height || 0, alt: media.alt || '', bytes: buffer.length }
}

/** MP4 (an ftyp box first) or WebM (an EBML header), from the file's first bytes; '' for anything else. */
const videoType = (buf) => (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' ? 'mp4' : buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3 ? 'webm' : '')

/** The first prose paragraph of a README (no headings, images, badges, tables or HTML), shortened to about 240 characters. */
export function firstReadmeParagraph(markdown) {
  const blocks = String(markdown)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
  for (const block of blocks) {
    const line = block.trim()
    if (!line || /^(#|>|\||!\[|<|[-*+] |\d+\. |---|===|```|~~~)/.test(line)) continue
    const text = line
      .replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/g, '')
      .replace(/\[([^\]\n]{1,300})\]\([^)\n]{0,500}\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e])
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 40) continue
    if (text.length <= 240) return text
    const cut = text.slice(0, 240)
    return `${cut.slice(0, cut.lastIndexOf(' '))}…`
  }
  return ''
}

// Renders the site's one page: a short header, then one card per tool with its demo, a line about it and its
// buttons. Plain template strings: every value that comes from GitHub or the config passes through esc(), and every
// URL through safeUrl() or a path the build made itself.
import { esc, safeUrl } from './text.mjs'

// 20x20 line icons. The drag button keeps its icon in an aria-hidden <svg> with no <title>, so the favourite's name
// (all of the link's text) is only the label.
const ICONS = {
  star: '<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/>',
  layers: '<path d="M10 2.5l7.5 4-7.5 4-7.5-4z"/><path d="M2.5 10l7.5 4 7.5-4"/><path d="M2.5 13.5l7.5 4 7.5-4"/>',
  translate: '<path d="M3 4.5h8M7 3v1.5c0 3.5-1.7 6-4 7.5"/><path d="M5 8c1 1.8 2.6 3.1 4.5 3.8"/><path d="M10.5 17l3.25-8 3.25 8M11.7 14.2h4.1"/>',
  database: '<ellipse cx="10" cy="4.8" rx="6" ry="2.3"/><path d="M4 4.8v10.4c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V4.8"/><path d="M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3"/>',
  select: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M5.5 8.5l1.5 1.5 2.5-3M11.5 8.5h3.5M5.5 13h9.5"/>',
  user: '<circle cx="8" cy="6.5" r="3"/><path d="M2.5 16.5c.6-3 2.8-4.7 5.5-4.7 1.2 0 2.3.3 3.2 1"/><path d="M13 12.5h4.5M15.5 10.5l2 2-2 2"/>',
  bookmark: '<path d="M5.5 2.8h9v14.4L10 13.6l-4.5 3.6z"/>',
  github: '<path d="M10 2.5a7.5 7.5 0 0 0-2.4 14.6c.4.1.5-.2.5-.4v-1.4c-2.1.5-2.5-.9-2.5-.9-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.7.1 1.1.8 1.1.8.7 1.1 1.7.8 2.1.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7 7 0 0 1 3.8 0c1.4-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.5 7.5 0 0 0 10 2.5z"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h2.5"/>',
}

export const icon = (name, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.bookmark}</svg>`

const MONOGRAM = '<svg class="brand__mark" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" class="brand__tile"/><path d="M8.5 8.5v15M16 8.5l-7.5 7.5 7.5 7.5M18 8.5l3.75 15 3.75-15" fill="none" class="brand__ink" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const CSP = [
  "default-src 'self'",
  "script-src 'self'", // also stops a drag button from running if it is clicked on this page
  "style-src 'self'",
  "img-src 'self' data: https:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const dims = (m) => (Number(m.width) > 0 && Number(m.height) > 0 ? ` width="${Number(m.width)}" height="${Number(m.height)}"` : '')

/**
 * @param {object} model { site, tools, assets, socialImage }
 * @param {{fragment?: boolean}} options  fragment: page content only, without the document head (for previews)
 */
export function renderPage(model, { fragment = false } = {}) {
  const { site, tools, assets } = model
  const canonical = safeUrl(site.url)
  const socialImage = canonical && model.socialImage ? new URL(model.socialImage, canonical).href : ''
  const hasBookmarklets = tools.some((t) => t.bookmarklet)
  const credits = tools.filter((t) => t.credit).map((t) => `<p>${esc(t.credit)}</p>`).join('\n    ')

  // The CSP comes first: a meta policy only covers what follows it.
  const head = `${fragment ? '' : `<meta http-equiv="Content-Security-Policy" content="${esc(CSP)}">\n`}<title>${esc(site.title)}</title>
${fragment ? '<meta name="claude:viewport-fit-sides" content="cover">\n' : ''}<meta name="description" content="${esc(site.description)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#071614">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f7f6">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n` : ''}<link rel="icon" href="${esc(assets.favicon)}" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(site.title)}">
<meta property="og:description" content="${esc(site.description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n` : ''}${socialImage ? `<meta property="og:image" content="${esc(socialImage)}">\n<meta name="twitter:card" content="summary_large_image">\n` : ''}${assets.fonts.map((f) => `<link rel="preload" href="${esc(f)}" as="font" type="font/woff2" crossorigin>`).join('\n')}
<link rel="stylesheet" href="${esc(assets.css)}">
<script src="${esc(assets.js)}" defer></script>`

  const body = `<header class="masthead">
  <div class="wrap">
    <div class="brandrow">
      <a class="brand" href="./">${MONOGRAM}<span class="brand__name">${esc(site.author)}</span><span class="brand__suffix">Toolkit</span></a>
      <a class="brandrow__link" href="${esc(site.ownerUrl)}">${icon('github')}<span>GitHub</span></a>
    </div>
    <p class="eyebrow">${esc(site.eyebrow)}</p>
    <h1 class="headline">${esc(site.headline)}</h1>
    <p class="lead">${esc(site.intro)}</p>
    ${hasBookmarklets ? `<p class="howto" id="howto">Show your favourites bar with <kbd data-key="mod">Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>, then drag a tool’s button onto it.</p>
    <p class="browser-note" data-browser-note hidden></p>` : ''}
  </div>
</header>
<main class="wrap">
  <ul class="tools" role="list">
    ${tools.map(renderTool).join('\n    ')}
  </ul>
</main>
<footer class="footer">
  <div class="wrap">
    <p>This page updates itself from <a href="${esc(site.ownerUrl)}">${esc(site.ownerUrl.replace(/^https:\/\//, ''))}</a> every hour, so each button always holds the tool’s latest version.</p>
    ${credits}
    <p>${esc(site.disclaimer)}</p>
  </div>
</footer>
<div class="toast" id="toast" aria-hidden="true" hidden></div>
<div class="sr-only" id="announcer" role="status" aria-live="polite"></div>`

  if (fragment) return `${head}\n${body}\n`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${head.replace('\n', '\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n')}
</head>
<body>
${body}
</body>
</html>
`
}

function renderTool(t) {
  const id = esc(t.slug)
  const b = t.bookmarklet
  const install = b
    ? `<a class="bm" id="bm-${id}" href="${esc(b.href)}" draggable="true" data-slug="${id}" data-chars="${b.chars}" title="Drag to your favourites bar" aria-describedby="howto">${icon(t.icon)}${esc(b.label)}</a>
          <button class="btn" type="button" data-copy="bm-${id}" hidden>${icon('copy')}<span>Copy<span class="sr-only"> the ${esc(b.label)} bookmarklet</span></span></button>
          `
    : ''
  return `<li class="tool" id="${id}">
      ${renderMedia(t)}
      <div class="tool__body">
        <h2 class="tool__name">${esc(t.name)}</h2>
        ${t.tagline ? `<p class="tool__desc">${esc(t.tagline)}</p>` : ''}
        <div class="tool__actions">
          ${install}<a class="btn" href="${esc(t.url)}">${icon('github')}<span>GitHub<span class="sr-only">: ${esc(t.name)}</span></span></a>
        </div>
      </div>
    </li>`
}

/** The demo: a video that plays like a GIF, else the picture (which may itself be a GIF), else a quiet tile. */
function renderMedia(t) {
  if (t.video) {
    const poster = t.image ? ` poster="${esc(t.image.src)}"${dims(t.image)}` : ''
    return `<div class="tool__media"><video src="${esc(t.video.src)}"${poster} autoplay muted loop playsinline aria-label="${esc(`Demo of ${t.name}`)}"></video></div>`
  }
  if (t.image) {
    const tall = Number(t.image.height) > Number(t.image.width) ? ' class="is-tall"' : ''
    return `<div class="tool__media"><img src="${esc(t.image.src)}" alt="${esc(t.image.alt)}"${dims(t.image)} loading="lazy" decoding="async"${tall}></div>`
  }
  return `<div class="tool__media tool__media--empty" aria-hidden="true">${icon(t.icon)}<span>${esc(t.name)}</span></div>`
}

/** GitHub Pages serves 404.html for any missing address. Asset paths are absolute from the site's root path. */
export function renderNotFound(model) {
  const { site, assets } = model
  let base = '/'
  try {
    base = new URL(site.url).pathname.replace(/\/?$/, '/')
  } catch {
    /* no published address known: assume the site is at the root */
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP)}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Page not found · ${esc(site.title)}</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="${esc(base + assets.favicon)}" type="image/svg+xml">
<link rel="stylesheet" href="${esc(base + assets.css)}">
</head>
<body>
<main class="masthead">
  <div class="wrap">
    <div class="brandrow"><a class="brand" href="${esc(base)}">${MONOGRAM}<span class="brand__name">${esc(site.author)}</span><span class="brand__suffix">Toolkit</span></a></div>
    <p class="eyebrow">404</p>
    <h1 class="headline">This page isn’t here.</h1>
    <p class="lead">The tools are on the <a href="${esc(base)}">toolkit page</a>.</p>
  </div>
</main>
</body>
</html>
`
}

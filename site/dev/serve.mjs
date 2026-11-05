#!/usr/bin/env node
// Serves the built site (_site/) on http://localhost:8080 for a look before publishing: `npm run build && npm run serve`.
// Options: PORT (default 8080), SITE_OUT (folder to serve, default _site), HOST (default 127.0.0.1: this computer only).
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..', process.env.SITE_OUT || '_site')
const port = Number(process.env.PORT || 8080)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/** The file for a request path, or null when it would be outside the served folder. */
function fileFor(pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const file = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`)
  const rel = path.relative(root, file)
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : file
}

createServer(async (req, res) => {
  try {
    let file = fileFor(new URL(req.url, 'http://localhost').pathname)
    if (!file) throw new Error('outside the served folder')
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html')
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    const body = await readFile(path.join(root, '404.html')).catch(() => 'Not found')
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  }
}).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Serving ${path.relative(process.cwd(), root) || root} on http://localhost:${port}`))

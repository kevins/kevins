// The toolkit page's behaviour: a hint when a drag button is clicked instead of dragged, Copy, and a note for browsers
// that can't hold bookmarklets this large. Without this script the drag buttons still work (and their link can be
// copied from the right-click menu).
(() => {
  'use strict'

  const $ = (selector) => document.querySelector(selector)
  const $$ = (selector) => Array.from(document.querySelectorAll(selector))
  const media = (query) => window.matchMedia && window.matchMedia(query).matches
  const reducedMotion = media('(prefers-reduced-motion: reduce)')
  const touchOnly = media('(hover: none) and (pointer: coarse)') // a phone or tablet: no favourites bar to drag to
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ''

  // A short message: shown at the bottom of the screen, and said by screen readers through a live region that is
  // always in the page. Escape or moving the focus on hides it.
  const toastEl = $('#toast')
  const announcer = $('#announcer')
  let toastTimer = 0
  let toastAt = 0
  const hideToast = () => {
    if (toastEl) toastEl.hidden = true
  }
  function toast(message) {
    if (announcer) {
      announcer.textContent = ''
      window.setTimeout(() => { announcer.textContent = message }, 60)
    }
    if (!toastEl) return
    toastEl.textContent = message
    toastEl.hidden = false
    toastAt = Date.now()
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(hideToast, 7000)
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideToast()
  })
  document.addEventListener('focusin', () => {
    if (Date.now() - toastAt > 400) hideToast()
  })

  const labelOf = (link) => link.textContent.trim()

  // On a Mac the shortcut uses Command.
  if (/mac|iphone|ipad/i.test(platform)) $$('kbd[data-key="mod"]').forEach((kbd) => { kbd.textContent = '⌘' })

  // Clicking a drag button here would run the tool on this page: explain instead (the page's Content-Security-Policy
  // blocks it anyway). Dragging it onto the favourites bar is what installs it.
  $$('a.bm').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      if (!reducedMotion) {
        link.classList.remove('is-nudged')
        void link.offsetWidth // restart the animation
        link.classList.add('is-nudged')
      }
      toast(
        touchOnly
          ? `“${labelOf(link)}” installs on a computer: open this page in Edge or Chrome there and drag the button onto the favourites bar.`
          : `Drag “${labelOf(link)}” onto your favourites bar to install it. Clicking it here does nothing.`,
      )
    })
  })

  // Copy: the bookmarklet's code, for pasting as the address of a new favourite.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.append(area)
      area.select()
      let copied = false
      try {
        copied = document.execCommand('copy')
      } catch {
        copied = false
      }
      area.remove()
      return copied
    }
  }
  $$('[data-copy]').forEach((button) => {
    button.hidden = false
    button.addEventListener('click', async () => {
      const link = document.getElementById(button.dataset.copy)
      if (!link) return
      const copied = await copyText(link.getAttribute('href'))
      button.focus()
      toast(
        copied
          ? `Copied. Add a favourite named “${labelOf(link)}” and paste this as its URL.`
          : `Your browser didn’t allow copying: right-click the “${labelOf(link)}” button and copy its link instead.`,
      )
    })
  })

  // The demos play like GIFs, unless the visitor asked for less motion: then they wait, with controls to play them.
  if (reducedMotion) {
    $$('.tool__media video').forEach((video) => {
      video.autoplay = false
      video.pause()
      video.controls = true
    })
  }

  // Firefox can't save a bookmark longer than 65,536 characters (it silently refuses), and Safari may not run one
  // this large: say so once, under the instructions.
  const ua = navigator.userAgent || ''
  const isFirefox = /firefox\//i.test(ua)
  const isSafari = /safari\//i.test(ua) && !/chrome|chromium|crios|edg|opr|fxios|android/i.test(ua)
  const note = $('[data-browser-note]')
  const largest = Math.max(0, ...$$('a.bm').map((link) => Number(link.dataset.chars) || 0))
  if (note && isFirefox && largest > 65_536) {
    note.textContent = 'Firefox can’t save favourites as large as these tools. Install them in Microsoft Edge or Google Chrome.'
    note.hidden = false
  } else if (note && isSafari && largest) {
    note.textContent = 'These tools are made for Microsoft Edge and Google Chrome. Safari may not run favourites this large.'
    note.hidden = false
  }
})()

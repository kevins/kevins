# KV Toolkit site

The source of **https://kevins.github.io/kevins/**: one page with a card for every tool in this GitHub account: its
demo, a line about it, and for a bookmarklet a button you drag onto the favourites bar to install it.

It follows the repositories by itself. Every hour, GitHub Actions ([`site.yml`](../.github/workflows/site.yml)) reads
the public repositories of `kevins`, takes the bookmarklet each one has committed on its default branch, and rebuilds
the page when anything changed. Push a new build of a tool and its button carries it within the hour; create a new
public repository and it gets a card (and a button, if it ships a bookmarklet) without any change here.

## One-time setup

1. **Settings > Pages > Build and deployment > Source: GitHub Actions** (you can choose it before the workflow exists).
2. Merge this into `main` yourself: the merge runs the workflow, which publishes the page.
3. If you merged before step 1, run **Actions > Toolkit site > Run workflow** (or wait for the next hour).

The page is then at `https://kevins.github.io/kevins/`. For the shorter `https://kevins.github.io/`, move `site/`,
`package.json`, `.gitignore` and the workflow into a repository named `kevins.github.io` (the build never lists the
repository it runs in, or one with that name).

## What it does on each run

1. Lists the public repositories of the owner in [`config.json`](config.json): not forks, not archived, not the
   profile repository `kevins/kevins`, not the site's own repository, not those listed in `exclude`.
2. For each one, at the latest commit of its default branch:
   * **Bookmarklet**: the file named in `config.json`, or else the most likely file that starts with `javascript:`
     (`*.bookmarklet.txt`, `bookmarklet.txt`, a file named like `*Bookmarklet*.js`, a `.js` or `.txt` at the root).
     The button's link is that file's text exactly, so dragging it saves the same favourite as pasting the file.
   * **Version** from `package.json` at the root, else the latest release tag.
   * **Demo**: the video or picture named in `config.json`, else the first picture of the README; copied onto the
     site. A video plays like a GIF (muted, looping).
3. Writes `_site/`: `index.html`, `404.html`, `build.json` (versions, SHA-256 of each bookmarklet, and a content
   hash), the media and the assets.
4. Publishes when the content hash differs from the live site's `build.json`; otherwise the run ends with "Nothing
   changed". A manual run with *Publish even if nothing changed* always publishes.

A build stops, and the live site keeps its last good buttons, when a tool that `config.json` calls a bookmarklet no
longer has one, or when GitHub can't be read. GitHub emails a failed scheduled run to whoever added the workflow (or
last changed its `cron` line), so merge it yourself, and only if Settings > Notifications > System > Actions is set to
email.

### Keeping the hourly schedule on

GitHub switches off the workflows of a public repository after 60 days without activity, and a switched-off workflow
stops completely. The workflow's `keepalive` job re-enables it every hour to prevent that. GitHub doesn't document
that this resets the 60 days, so if you ever get the "workflow will be disabled soon" email: open **Actions > Toolkit
site** and select **Continue running workflow** (or push any commit to `main`). If it was already switched off,
**Enable workflow** on the same page brings it back.

## Browser support

The buttons are made for **Microsoft Edge and Google Chrome** on a computer, as the tools themselves are. Firefox
can't save a bookmark longer than 65,536 characters, and every one of these tools is longer (72,000 to 298,000), so on
Firefox the page says so under the instructions. Safari may not run favourites that large either. Dragging carries the
link exactly; Chrome re-encodes a few characters when it saves the favourite, which doesn't change the code it runs.

## Customising a tool: `config.json`

Every field is optional; a repository with no entry still appears, with its GitHub description and README picture.

```jsonc
"tools": {
  "UnmanagedLayerScanner": {                   // the repository name
    "name": "Unmanaged Layer Scanner",         // display name (default: from the repository name)
    "icon": "layers",                          // star, layers, translate, database, select, user, bookmark
    "tagline": "One line about the tool.",     // default: the repository description
    "credit": "Shown in the footer.",          // optional
    "bookmarklet": {
      "path": "layer-scanner.bookmarklet.txt", // the javascript: file
      "label": "Unmanaged layers"              // the favourite's name (the button's text)
    },                                         // or false: not a bookmarklet, no button
    "video": { "path": "docs/demo.mp4" },               // the demo, played like a GIF (MP4 or WebM)
    "image": { "path": "docs/thumb.png", "alt": "…" }    // the picture (or the video's first frame); a GIF works too;
                                                         // or { "url": "https://…", "width": …, "height": … }
  }
}
```

`order` lists the repositories to show first; the rest follow, most recently changed first. `exclude` hides
repositories. `site` holds the page's own text. `owner` is the account whose repositories are shown, and `ownerId` its
number: if the account is ever renamed, the build stops instead of showing whoever takes the old name.

## Working on it locally

Node.js 22 or newer, nothing to install.

```bash
npm test                          # unit tests and a full build against a fake GitHub
npm run build                     # about 40 requests: without a token GitHub allows 60 an hour, so one build
npm run serve                     # http://localhost:8080 (this computer only)
```

`SITE_REPOS=LevelUpBookmarklet,SQLAdvancedFind` builds only those repositories. For more builds an hour, set
`GITHUB_TOKEN` to a fine-grained personal access token with **Public repositories (read-only)** access: the build
only reads public repositories. Don't use `gh auth token` for this: that token can write to every repository.

## Optional: rebuild as soon as a tool changes

The hourly check is enough for most changes. For an immediate rebuild, a tool's repository can start this workflow
when it changes. Create a fine-grained personal access token for `kevins/kevins` only, with **Actions: Read and
write** and nothing else: it can start the workflow but can't change the site's code. Choose an expiration you will
remember (GitHub's default is 30 days); once it expires, this job fails until you replace the secret. Store it as the
secret `SITE_TOKEN` in the tool's repository, and add:

```yaml
# .github/workflows/update-site.yml in the tool's repository
name: Update the toolkit site
on:
  push:
    branches: [main]
permissions: {}
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: gh api --method POST repos/kevins/kevins/actions/workflows/site.yml/dispatches -f ref=main
        env:
          GH_TOKEN: ${{ secrets.SITE_TOKEN }}
```

## Files

| Path | What it is |
| --- | --- |
| `site/build.mjs` | The build: reads GitHub, writes `_site/` |
| `site/lib/` | GitHub client, bookmarklet detection, media, HTML |
| `site/assets/` | Stylesheet, script, icon and fonts (Archivo and Martian Mono, SIL Open Font License) |
| `site/config.json` | Which tools, in which order, with which text |
| `site/test/` | `npm test` |
| `site/dev/serve.mjs` | Local preview server |
| `.github/workflows/site.yml` | Hourly build and GitHub Pages publishing (actions pinned to commits) |
| `.github/dependabot.yml` | A monthly pull request when those actions have new versions |

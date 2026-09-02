# veyra-empire.github.io

GitHub Pages host for the `veyra-empire` org. Primary content: the VEYRA
EMPIRE script archive landing page at **https://veyra-empire.github.io/scripts/**.

All security-sensitive logic - Discord OAuth, Tiers sheet lookup, GitHub PAT,
script delivery - lives in the Apps Script proxy (`veyra-empire-proxy/`).
This repo holds only the public landing UI.

## Layout

```
/
├── .nojekyll             ← disable Jekyll processing org-wide
├── README.md
└── scripts/              ← https://veyra-empire.github.io/scripts/
    ├── index.html        UI shell (loading / sign-in / denied / archive states)
    ├── app.js            Client: OAuth round trip, session cache, card rendering, sort bar
    ├── style.css         Styling (lifted from the original Apps Script Install.html)
    ├── install.html/.js  Install gateway - mints a single-use token, hands off to Tampermonkey
    ├── v.html            Verification popup for the in-game auth check (origin-allowlisted)
    ├── open.html/.js     Loader for obfuscated resource / extension links
    └── submit*.html/.js  Submission forms for scripts, resources, and apps/extensions
```

Future org-wide pages can go elsewhere in the tree - e.g. a root `index.html`
for `https://veyra-empire.github.io/`.

## Architecture (one-liner)

Pages constructs the Discord authorize URL client-side and navigates the
user to Discord. Discord redirects back to Pages with `?code=&state=`.
`app.js` validates the state (kept in `sessionStorage`, so a stale one from
another tab cannot validate a fresh callback) and fires a single JSONP call
to `<proxy>/exec?api=oauth-exchange&code=...`; the response bundles session
id + identity + tier + content lists. Pages stashes that in `localStorage`
under `veyra_session` - `localStorage`, not `sessionStorage`, so
`install.html` can read it from a separate tab - and renders. No cookies, no
CORS, no trips through `script.google.com` in the browser URL bar.

Install buttons deliberately carry **no** credential: they point at
`install.html?s=<scriptId>`, which mints a single-use token at click time.
Copying an Install link therefore gives someone a URL that does nothing in
their browser.

Maintainers: the full system, including credential lifetimes, serve-time
injection, and deploy sequencing, is documented in `ARCHITECTURE.md` in the
private proxy repo. This repo is public - never move a security decision
into it.

## Updating

Edit any file under `scripts/`, commit, push. Pages redeploys within ~30
seconds.

**Hard-refresh before testing.** Pages serves these assets with
`Cache-Control: max-age=600` and nothing here is cache-busted, so for ten
minutes after a deploy your browser may still be running the previous
JavaScript, possibly paired with the new HTML. More than one confusing bug
report has turned out to be that.

`scripts/app.js` contains a `PROXY_URL` constant pointing at the Apps Script
`/exec` deployment - rotate this if the deployment URL ever changes.

## Adding a Discussion link to a script

Each script card on the archive page can show a "Discussion ->" link
pointing at its Discord forum thread (or any other URL you want members to
see for more info). The data lives in the manifest, not in this repo.

1. Open the manifest on GitHub:
   https://github.com/veyra-empire/scripts/blob/master/manifest.json
2. Click the pencil (Edit) icon.
3. Add a `"threadUrl"` field to the script's entry:
   ```json
   "scripts": {
     "havoc": {
       "path": "havoc/havoc.user.js",
       "name": "Havoc Autobattle",
       "author": "lmv",
       "description": "...",
       "minTier": "tester",
       "threadUrl": "https://discord.com/channels/<guild-id>/<thread-id>"
     }
   }
   ```
4. Commit directly to `master` (e.g. "add thread link for havoc").

Propagation time: up to 10 minutes (the proxy caches the manifest for 10 min).
To apply immediately, run `_clearMembershipCache()` in the Apps Script editor.
Members already signed in see the new link the next time they sign in - their
cached content list in `localStorage` is rendered as-is until then.

No re-deploy of the proxy or this repo is needed - manifest edits are
live data, not code.

Omit `threadUrl` (or leave it empty) to suppress the link on that card.

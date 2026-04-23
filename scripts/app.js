(function() {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  // Apps Script /exec URL (not secret - baked into every installed script's
  // @updateURL). Only used for JSONP data calls + install button URLs.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';

  // Discord OAuth app (public values per Discord docs).
  var CLIENT_ID    = '1494917616878227597';
  var REDIRECT_URI = 'https://veyra-empire.github.io/scripts/';

  var TIER_ORDER = ['probationary', 'member', 'tester', 'owner'];

  // Flavorful display labels. Internal tier values (in the manifest, on
  // the proxy, and in the Tiers sheet) stay as 'probationary' / 'member'
  // / 'tester' / 'owner' - this map only affects what users see. Update
  // the same map in submit.js / submit-resource.js if you tweak it.
  var TIER_DISPLAY = {
    probationary: 'Probationary',
    member:       'Full Member',
    tester:       'Tester',
    owner:        'Emperor'
  };
  function tierLabel(t) { return TIER_DISPLAY[t] || t || ''; }
  // veyra_session lives in localStorage so install.html (a separate tab)
  // can read it when the user clicks an Install button.
  var CACHE_KEY  = 'veyra_session';
  // oauth_state is only used during the Discord round-trip in this tab;
  // sessionStorage is correct so stale state from prior tabs can't
  // accidentally validate a fresh callback.
  var STATE_KEY  = 'veyra_oauth_state';

  // ─── JSONP helper ────────────────────────────────────────────────────────
  // Apps Script /exec 302-redirects through googleusercontent.com and strips
  // CORS headers, so we load responses as <script> tags (bypasses CORS).
  function jsonp(url) {
    return new Promise(function(resolve, reject) {
      var cb = '__veyra_cb_' + Math.random().toString(36).slice(2) + '_' + Date.now();
      var script = document.createElement('script');
      var timer = setTimeout(function() { cleanup(); reject(new Error('timeout')); }, 30000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (_) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function(data) { cleanup(); resolve(data); };
      script.onerror = function() { cleanup(); reject(new Error('network')); };
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'callback=' + encodeURIComponent(cb);
      document.head.appendChild(script);
    });
  }

  // ─── DOM refs ────────────────────────────────────────────────────────────
  var elLoading  = document.getElementById('state-loading');
  var elOauth    = document.getElementById('state-oauth');
  var elDenied   = document.getElementById('state-denied');
  var elScripts  = document.getElementById('state-scripts');
  var elDeniedMsg= document.getElementById('denied-msg');
  var elName     = document.getElementById('user-name');
  var elEmail    = document.getElementById('user-email');
  var elTier     = document.getElementById('user-tier');
  var elGrid     = document.getElementById('scriptsGrid');
  var elSortBar  = document.getElementById('sortBar');
  var elSortDir  = document.getElementById('sortDir');
  var elEmpty    = document.getElementById('empty-state');
  var elControls = document.getElementById('scripts-controls');
  var elSignin   = document.getElementById('signin-btn');
  var elSignout  = document.getElementById('signout-btn');

  function show(section) {
    [elLoading, elOauth, elDenied, elScripts].forEach(function(el) { el.hidden = true; });
    section.hidden = false;
  }

  // ─── Query-string parsing (OAuth callback lands here with ?code=&state=) ─
  function parseQuery() {
    var s = location.search.replace(/^\?/, '');
    var out = {};
    if (!s) return out;
    s.split('&').forEach(function(kv) {
      var i = kv.indexOf('=');
      if (i < 0) out[decodeURIComponent(kv)] = '';
      else out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }

  function clearQuery() {
    if (history.replaceState) {
      history.replaceState(null, '', location.pathname);
    }
  }

  // ─── Denied messages ─────────────────────────────────────────────────────
  var DENIED_MESSAGES = {
    'not-in-guild':    "Your Discord account isn't in the VEYRA EMPIRE guild. Join the guild first, then come back.",
    'no-tier':         "You're in the guild, but you haven't been assigned a tier yet. Check with an officer on Discord to get registered.",
    'not-configured':  "The sign-in system isn't configured yet. Contact the admin.",
    'oauth-state':     "Sign-in failed: state token mismatch. Try again.",
    'oauth-exchange':  "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-identity':  "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-guilds':    "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-error':     "Sign-in failed. Try again, or contact an officer if it keeps happening."
  };

  function showDenied(reason) {
    elDeniedMsg.textContent = DENIED_MESSAGES[reason] ||
      "No script access found. If you were recently added or promoted, check with an officer on Discord.";
    show(elDenied);
  }

  // ─── Renderers ───────────────────────────────────────────────────────────
  function renderScripts(data) {
    elName.textContent = data.name || (data.email ? data.email.split('@')[0] : '');
    elEmail.textContent = data.email || '';
    elTier.textContent = tierLabel(data.tier);
    elTier.className = 'tier-badge tier-' + (data.tier || '');

    var scripts    = data.scripts    || [];
    var resources  = data.resources  || [];
    var extensions = data.extensions || [];

    // Show the "no content at your tier" message only when ALL three
    // sections are empty. Each section's own container hides itself when
    // empty (see renderResources / renderExtensions).
    elEmpty.hidden = !(scripts.length === 0 && resources.length === 0 && extensions.length === 0);

    if (scripts.length === 0) {
      elControls.hidden = true;
    } else {
      elControls.hidden = false;
      elGrid.innerHTML = '';
      scripts.forEach(function(s) {
        var card = document.createElement('div');
        card.className = 'script-card';
        card.dataset.name = (s.name || '').toLowerCase();
        card.dataset.author = (s.author || '').toLowerCase();
        card.dataset.tier = s.minTier || '';
        card.dataset.tierRank = String(TIER_ORDER.indexOf(s.minTier));

        // Title row: name + version badge side by side.
        var titleWrap = document.createElement('div');
        titleWrap.className = 'card-title';
        var h3 = document.createElement('h3');
        h3.textContent = s.name || s.id;
        titleWrap.appendChild(h3);
        if (s.version) {
          var verPill = document.createElement('span');
          verPill.className = 'version-pill';
          verPill.textContent = 'v' + s.version;
          titleWrap.appendChild(verPill);
        }

        var meta = document.createElement('div');
        meta.className = 'script-meta';
        meta.appendChild(document.createTextNode('by ' + (s.author || '')));
        if (s.minTier) {
          var pill = document.createElement('span');
          pill.className = 'tier-pill tier-' + s.minTier;
          pill.textContent = tierLabel(s.minTier);
          meta.appendChild(document.createTextNode(' '));
          meta.appendChild(pill);
        }

        var desc = document.createElement('div');
        desc.className = 'script-desc';
        desc.textContent = s.description || '';

        // Optional changelog disclosure: lets members see recent updates
        // without leaving the page. Rendered only if at least one non-empty
        // entry exists. Collapsed by default to keep the card compact.
        var changelogEl = null;
        if (Array.isArray(s.changelog) && s.changelog.length) {
          changelogEl = buildChangelog(s.changelog);
        }

        // Optional screenshot thumbnail. Click expands to a full-size lightbox.
        // Validate origin as an extra defense - we expect public raw.githubusercontent.com.
        var thumb = null;
        if (s.screenshotUrl && /^https:\/\/raw\.githubusercontent\.com\//i.test(s.screenshotUrl)) {
          thumb = document.createElement('button');
          thumb.type = 'button';
          thumb.className = 'script-thumb';
          thumb.setAttribute('aria-label', 'Show screenshot for ' + (s.name || s.id));
          var img = document.createElement('img');
          img.src = s.screenshotUrl;
          img.alt = '';
          img.loading = 'lazy';
          thumb.appendChild(img);
          thumb.addEventListener('click', function() { openLightbox(s.screenshotUrl, s.name || s.id); });
        }

        var actions = document.createElement('div');
        actions.className = 'script-actions';

        var btn = document.createElement('a');
        btn.className = 'install-btn';
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = 'Install';
        // Pages-hosted gateway: copy-link gives a URL useless in any other
        // browser (no localStorage.veyra_session). The real proxy URL with
        // a single-use install token is constructed inside install.html
        // and immediately consumed by Tampermonkey on navigation.
        btn.href = 'install.html?s=' + encodeURIComponent(s.id);
        actions.appendChild(btn);

        // Only render the link if the URL is HTTPS - defense-in-depth against
        // a future compromised manifest entry with a `javascript:` href that
        // could XSS the Pages origin and exfiltrate the session from localStorage.
        if (s.threadUrl && /^https:\/\//i.test(s.threadUrl)) {
          var threadLink = document.createElement('a');
          threadLink.className = 'thread-link';
          threadLink.target = '_blank';
          threadLink.rel = 'noopener';
          threadLink.href = s.threadUrl;
          threadLink.textContent = 'Discussion \u2192';
          actions.appendChild(threadLink);
        }

        card.appendChild(titleWrap);
        card.appendChild(meta);
        card.appendChild(desc);
        if (changelogEl) card.appendChild(changelogEl);
        if (thumb) card.appendChild(thumb);
        card.appendChild(actions);
        elGrid.appendChild(card);
      });
      applySort();
    }

    renderResources(resources);
    renderExtensions(extensions);

    show(elScripts);
  }

  // Shared changelog renderer used by both scripts and extension cards.
  // Returns a <details> element with the last N entries, each shown as:
  //   v1.2.3 (2026-04-21)
  //     notes text, line-broken as written
  function buildChangelog(entries) {
    var wrap = document.createElement('details');
    wrap.className = 'card-changelog';
    var summary = document.createElement('summary');
    summary.textContent = 'Show recent changes';
    wrap.appendChild(summary);

    var list = document.createElement('div');
    list.className = 'card-changelog-list';
    entries.forEach(function(e) {
      var item = document.createElement('div');
      item.className = 'card-changelog-item';
      var head = document.createElement('div');
      head.className = 'card-changelog-head';
      head.textContent = 'v' + (e.version || '?') + (e.date ? '  (' + e.date + ')' : '');
      item.appendChild(head);
      if (e.notes) {
        var notes = document.createElement('div');
        notes.className = 'card-changelog-notes';
        notes.textContent = e.notes;
        item.appendChild(notes);
      }
      list.appendChild(item);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // Extensions render into their own grid below the scripts section.
  // Different visual affordance because the install flow is different
  // (not a Tampermonkey one-click; download from Drive + load unpacked).
  function renderExtensions(extensions) {
    var section = document.getElementById('extensions-section');
    var grid    = document.getElementById('extensionsGrid');
    if (!section || !grid) return;
    if (!extensions.length) { section.hidden = true; return; }
    grid.innerHTML = '';
    extensions.forEach(function(x) {
      var card = document.createElement('div');
      card.className = 'script-card extension-card';

      var titleWrap = document.createElement('div');
      titleWrap.className = 'card-title';
      var h3 = document.createElement('h3');
      h3.textContent = x.name || x.id;
      titleWrap.appendChild(h3);
      if (x.version) {
        var verPill = document.createElement('span');
        verPill.className = 'version-pill';
        verPill.textContent = 'v' + x.version;
        titleWrap.appendChild(verPill);
      }
      var extTag = document.createElement('span');
      extTag.className = 'extension-tag';
      extTag.textContent = 'Browser extension';
      titleWrap.appendChild(extTag);

      var meta = document.createElement('div');
      meta.className = 'script-meta';
      meta.appendChild(document.createTextNode('by ' + (x.author || '')));
      if (x.minTier) {
        var pill = document.createElement('span');
        pill.className = 'tier-pill tier-' + x.minTier;
        pill.textContent = tierLabel(x.minTier);
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(pill);
      }

      var desc = document.createElement('div');
      desc.className = 'script-desc';
      desc.textContent = x.description || '';

      var thumb = null;
      if (x.screenshotUrl && /^https:\/\/raw\.githubusercontent\.com\//i.test(x.screenshotUrl)) {
        thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'script-thumb';
        thumb.setAttribute('aria-label', 'Show screenshot for ' + (x.name || x.id));
        var img = document.createElement('img');
        img.src = x.screenshotUrl;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
        thumb.addEventListener('click', function() { openLightbox(x.screenshotUrl, x.name || x.id); });
      }

      // Install instructions - rendered as an expandable numbered list.
      var instr = null;
      if (Array.isArray(x.instructions) && x.instructions.length) {
        instr = document.createElement('details');
        instr.className = 'card-instructions';
        var summary = document.createElement('summary');
        summary.textContent = 'Install instructions';
        instr.appendChild(summary);
        var ol = document.createElement('ol');
        ol.className = 'card-instructions-list';
        x.instructions.forEach(function(step) {
          var li = document.createElement('li');
          li.textContent = step;
          ol.appendChild(li);
        });
        instr.appendChild(ol);
      }

      var changelogEl = null;
      if (Array.isArray(x.changelog) && x.changelog.length) {
        changelogEl = buildChangelog(x.changelog);
      }

      var actions = document.createElement('div');
      actions.className = 'script-actions';
      // The proxy projects `openUrl` (signed redirect). `driveUrl` is no
      // longer sent, so hovering this button only reveals the opaque
      // script.google.com URL, not the underlying Drive folder.
      var openHref = x.openUrl || '';
      if (openHref && /^https:\/\//i.test(openHref)) {
        var btn = document.createElement('a');
        btn.className = 'install-btn extension-btn';
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = 'Open Drive folder';
        btn.href = openHref;
        actions.appendChild(btn);
      }
      if (x.threadUrl && /^https:\/\//i.test(x.threadUrl)) {
        var threadLink = document.createElement('a');
        threadLink.className = 'thread-link';
        threadLink.target = '_blank';
        threadLink.rel = 'noopener';
        threadLink.href = x.threadUrl;
        threadLink.textContent = 'Discussion \u2192';
        actions.appendChild(threadLink);
      }

      card.appendChild(titleWrap);
      card.appendChild(meta);
      card.appendChild(desc);
      if (instr) card.appendChild(instr);
      if (changelogEl) card.appendChild(changelogEl);
      if (thumb) card.appendChild(thumb);
      card.appendChild(actions);
      grid.appendChild(card);
    });
    section.hidden = false;
  }

  // Resources render into their own grid above scripts. Externally-hosted
  // URL assets (spreadsheets, docs, reference material). Same visual
  // affordance as extensions but with an "Updated <YYYY-MM-DD>" caption
  // so members can see freshness at a glance even when the resource has
  // no meaningful version number.
  function renderResources(resources) {
    var section = document.getElementById('resources-section');
    var grid    = document.getElementById('resourcesGrid');
    if (!section || !grid) return;
    if (!resources.length) { section.hidden = true; return; }
    grid.innerHTML = '';
    resources.forEach(function(r) {
      var card = document.createElement('div');
      card.className = 'script-card resource-card';

      var titleWrap = document.createElement('div');
      titleWrap.className = 'card-title';
      var h3 = document.createElement('h3');
      h3.textContent = r.name || r.id;
      titleWrap.appendChild(h3);
      if (r.version) {
        var verPill = document.createElement('span');
        verPill.className = 'version-pill';
        verPill.textContent = 'v' + r.version;
        titleWrap.appendChild(verPill);
      }
      var resTag = document.createElement('span');
      resTag.className = 'extension-tag resource-tag';
      resTag.textContent = 'Resource';
      titleWrap.appendChild(resTag);

      var meta = document.createElement('div');
      meta.className = 'script-meta';
      meta.appendChild(document.createTextNode('by ' + (r.author || '')));
      if (r.minTier) {
        var pill = document.createElement('span');
        pill.className = 'tier-pill tier-' + r.minTier;
        pill.textContent = tierLabel(r.minTier);
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(pill);
      }

      // "Updated <date>" line - always present for resources.
      var updated = null;
      if (r.lastModified) {
        updated = document.createElement('div');
        updated.className = 'resource-updated';
        updated.textContent = 'Updated ' + r.lastModified;
      }

      var desc = document.createElement('div');
      desc.className = 'script-desc';
      desc.textContent = r.description || '';

      var thumb = null;
      if (r.screenshotUrl && /^https:\/\/raw\.githubusercontent\.com\//i.test(r.screenshotUrl)) {
        thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'script-thumb';
        thumb.setAttribute('aria-label', 'Show screenshot for ' + (r.name || r.id));
        var img = document.createElement('img');
        img.src = r.screenshotUrl;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
        thumb.addEventListener('click', function() { openLightbox(r.screenshotUrl, r.name || r.id); });
      }

      // Optional setup instructions (numbered list, expandable).
      var instr = null;
      if (Array.isArray(r.instructions) && r.instructions.length) {
        instr = document.createElement('details');
        instr.className = 'card-instructions';
        var summary = document.createElement('summary');
        summary.textContent = 'Instructions';
        instr.appendChild(summary);
        var ol = document.createElement('ol');
        ol.className = 'card-instructions-list';
        r.instructions.forEach(function(step) {
          var li = document.createElement('li');
          li.textContent = step;
          ol.appendChild(li);
        });
        instr.appendChild(ol);
      }

      var changelogEl = null;
      if (Array.isArray(r.changelog) && r.changelog.length) {
        changelogEl = buildChangelog(r.changelog);
      }

      var actions = document.createElement('div');
      actions.className = 'script-actions';
      // Obfuscated link: proxy's apiOpen re-validates tier, then redirects.
      // `url` (the real destination) is intentionally not projected.
      var openHref = r.openUrl || '';
      if (openHref && /^https:\/\//i.test(openHref)) {
        var btn = document.createElement('a');
        btn.className = 'install-btn resource-btn';
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = 'Open';
        btn.href = openHref;
        actions.appendChild(btn);
      }
      if (r.threadUrl && /^https:\/\//i.test(r.threadUrl)) {
        var threadLink = document.createElement('a');
        threadLink.className = 'thread-link';
        threadLink.target = '_blank';
        threadLink.rel = 'noopener';
        threadLink.href = r.threadUrl;
        threadLink.textContent = 'Discussion \u2192';
        actions.appendChild(threadLink);
      }

      card.appendChild(titleWrap);
      card.appendChild(meta);
      if (updated) card.appendChild(updated);
      card.appendChild(desc);
      if (instr) card.appendChild(instr);
      if (changelogEl) card.appendChild(changelogEl);
      if (thumb) card.appendChild(thumb);
      card.appendChild(actions);
      grid.appendChild(card);
    });
    section.hidden = false;
  }

  // ─── Sort bar ────────────────────────────────────────────────────────────
  var sortState = { by: 'name', asc: true };

  function cmp(a, b, by) {
    if (by === 'tier') {
      var ar = +a.dataset.tierRank, br = +b.dataset.tierRank;
      if (ar !== br) return ar - br;
      return a.dataset.name.localeCompare(b.dataset.name);
    }
    var av = a.dataset[by] || '', bv = b.dataset[by] || '';
    if (av !== bv) return av.localeCompare(bv);
    return a.dataset.name.localeCompare(b.dataset.name);
  }

  function applySort() {
    var cards = Array.prototype.slice.call(elGrid.children);
    cards.sort(function(a, b) {
      var c = cmp(a, b, sortState.by);
      return sortState.asc ? c : -c;
    });
    cards.forEach(function(c) { elGrid.appendChild(c); });
    elSortBar.querySelectorAll('.sort-btn[data-sort]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.sort === sortState.by);
    });
    elSortDir.textContent = sortState.asc ? '\u25B2' : '\u25BC';
  }

  elSortBar.querySelectorAll('.sort-btn[data-sort]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      sortState.by = btn.dataset.sort;
      applySort();
    });
  });
  elSortDir.addEventListener('click', function() {
    sortState.asc = !sortState.asc;
    applySort();
  });

  // ─── Discord authorize URL ───────────────────────────────────────────────
  function buildAuthorizeUrl(state) {
    return 'https://discord.com/oauth2/authorize' +
           '?response_type=code' +
           '&client_id='    + encodeURIComponent(CLIENT_ID) +
           '&scope='        + encodeURIComponent('identify guilds') +
           '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
           '&state='        + encodeURIComponent(state) +
           '&prompt=none';
  }

  function randomState() {
    // 128 bits of entropy, base36.
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }

  function startSignIn() {
    var state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    location.href = buildAuthorizeUrl(state);
  }

  // ─── Sign-in / sign-out ──────────────────────────────────────────────────
  elSignin.addEventListener('click', function(e) {
    e.preventDefault();
    startSignIn();
  });

  elSignout.addEventListener('click', function(e) {
    e.preventDefault();
    localStorage.removeItem(CACHE_KEY);
    // Clear the long-lived fingerprint marker too. Auth-required scripts on
    // game pages will block until the user signs in again.
    localStorage.removeItem('veyra_fingerprint');
    sessionStorage.removeItem(STATE_KEY);
    location.replace(location.pathname);
  });

  // ─── OAuth callback handler ──────────────────────────────────────────────
  function handleOauthCallback(code, state) {
    var expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    if (!expected || expected !== state) {
      clearQuery();
      showDenied('oauth-state');
      return;
    }
    clearQuery();
    show(elLoading);
    jsonp(PROXY_URL + '?api=oauth-exchange&code=' + encodeURIComponent(code))
      .then(function(body) {
        if (body && !body.error && body.sid) {
          localStorage.setItem(CACHE_KEY, JSON.stringify(body));
          // Long-lived fingerprint marker - consumed by the auth bootstrap
          // inside requiresAuth scripts. Permanent until explicit sign-out.
          if (body.discordId && body.fingerprintSig && body.signedAt) {
            try {
              localStorage.setItem('veyra_fingerprint', JSON.stringify({
                discordId: body.discordId,
                sig:       body.fingerprintSig,
                signedAt:  body.signedAt
              }));
            } catch (_) { /* quota or storage disabled; bootstrap will fall through to signin-needed */ }
          }
          renderScripts(body);
        } else {
          showDenied((body && body.error) || 'oauth-error');
        }
      })
      .catch(function() {
        showDenied('oauth-error');
      });
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  function init() {
    var q = parseQuery();

    if (q.code && q.state) {
      handleOauthCallback(q.code, q.state);
      return;
    }

    // Migrate any pre-existing sessionStorage entry from older builds.
    var legacy = sessionStorage.getItem(CACHE_KEY);
    if (legacy && !localStorage.getItem(CACHE_KEY)) {
      localStorage.setItem(CACHE_KEY, legacy);
    }
    sessionStorage.removeItem(CACHE_KEY);

    // Fresh-tab detection: sessionStorage is scoped to this tab only, so no
    // marker means "this tab just opened" (close+reopen, Ctrl+click, cold
    // browser start). On a fresh tab, always force the sign-in landing
    // regardless of any cached session in localStorage - stale sessions are
    // the common case and having the user click through the signed-in UI
    // only to get bounced to OAuth on install is wasted motion. Within the
    // same tab (refreshes, in-tab navigations), the cached session is
    // trusted as before.
    var tabLive = sessionStorage.getItem('veyra_tab_live');
    sessionStorage.setItem('veyra_tab_live', '1');

    if (tabLive) {
      var cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        try {
          var data = JSON.parse(cached);
          if (data && data.sid) {
            renderScripts(data);
            return;
          }
        } catch (_) { /* fall through to landing */ }
        localStorage.removeItem(CACHE_KEY);
      }
    }

    show(elOauth);
  }

  // ─── Lightbox (full-size screenshot viewer) ──────────────────────────────
  function openLightbox(url, caption) {
    var box = document.getElementById('lightbox');
    if (!box) return;
    var img = document.getElementById('lightbox-img');
    var cap = document.getElementById('lightbox-caption');
    img.src = url;
    img.alt = caption || '';
    if (cap) cap.textContent = caption || '';
    box.hidden = false;
    document.addEventListener('keydown', onLightboxKey);
  }
  function closeLightbox() {
    var box = document.getElementById('lightbox');
    if (!box) return;
    box.hidden = true;
    document.getElementById('lightbox-img').removeAttribute('src');
    document.removeEventListener('keydown', onLightboxKey);
  }
  function onLightboxKey(e) {
    if (e.key === 'Escape') closeLightbox();
  }
  (function wireLightbox() {
    var box = document.getElementById('lightbox');
    if (!box) return;
    box.addEventListener('click', function(e) {
      // Only the backdrop or the close button dismisses; click on image does not.
      if (e.target === box || e.target.hasAttribute('data-lightbox-close')) closeLightbox();
    });
  })();

  init();
})();

(function() {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  // Apps Script /exec URL (not secret — baked into every installed script's
  // @updateURL). Only used for JSONP data calls + install button URLs.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';

  // Discord OAuth app (public values per Discord docs).
  var CLIENT_ID    = '1494917616878227597';
  var REDIRECT_URI = 'https://veyra-empire.github.io/scripts/';

  var TIER_ORDER = ['probationary', 'member', 'trusted', 'owner'];
  var CACHE_KEY  = 'veyra_session';       // sessionStorage key for the rendered payload
  var STATE_KEY  = 'veyra_oauth_state';   // sessionStorage key for the CSRF state token

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
    elTier.textContent = data.tier || '';
    elTier.className = 'tier-badge tier-' + (data.tier || '');

    var sid = data.sid || '';
    var scripts = data.scripts || [];

    if (scripts.length === 0) {
      elEmpty.hidden = false;
      elControls.hidden = true;
    } else {
      elEmpty.hidden = true;
      elControls.hidden = false;
      elGrid.innerHTML = '';
      scripts.forEach(function(s) {
        var card = document.createElement('div');
        card.className = 'script-card';
        card.dataset.name = (s.name || '').toLowerCase();
        card.dataset.author = (s.author || '').toLowerCase();
        card.dataset.tier = s.minTier || '';
        card.dataset.tierRank = String(TIER_ORDER.indexOf(s.minTier));

        var h3 = document.createElement('h3');
        h3.textContent = s.name || s.id;

        var meta = document.createElement('div');
        meta.className = 'script-meta';
        meta.appendChild(document.createTextNode('by ' + (s.author || '')));
        if (s.minTier) {
          var pill = document.createElement('span');
          pill.className = 'tier-pill tier-' + s.minTier;
          pill.textContent = s.minTier;
          meta.appendChild(document.createTextNode(' '));
          meta.appendChild(pill);
        }

        var desc = document.createElement('div');
        desc.className = 'script-desc';
        desc.textContent = s.description || '';

        var btn = document.createElement('a');
        btn.className = 'install-btn';
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = 'Install';
        btn.href = PROXY_URL + '/' + encodeURIComponent(s.id) + '.user.js' +
                   '?s=' + encodeURIComponent(s.id) +
                   '&session=' + encodeURIComponent(sid);

        card.appendChild(h3);
        card.appendChild(meta);
        card.appendChild(desc);
        card.appendChild(btn);
        elGrid.appendChild(card);
      });
      applySort();
    }

    show(elScripts);
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
    sessionStorage.removeItem(CACHE_KEY);
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
          sessionStorage.setItem(CACHE_KEY, JSON.stringify(body));
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

    var cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        var data = JSON.parse(cached);
        if (data && data.sid) {
          renderScripts(data);
          return;
        }
      } catch (_) { /* fall through to landing */ }
      sessionStorage.removeItem(CACHE_KEY);
    }

    show(elOauth);
  }

  init();
})();

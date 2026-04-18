(function() {
  'use strict';

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  // Apps Script web-app /exec URL. Replace with the real deployment URL.
  // (Same URL embedded in every installed script's @updateURL — not secret.)
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';

  var TIER_ORDER = ['probationary', 'member', 'trusted', 'owner'];

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

  // ─── Hash parsing ────────────────────────────────────────────────────────
  function parseHash() {
    var h = location.hash.replace(/^#/, '');
    var out = {};
    if (!h) return out;
    h.split('&').forEach(function(kv) {
      var i = kv.indexOf('=');
      if (i < 0) out[decodeURIComponent(kv)] = '';
      else out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }

  function clearHash() {
    if (history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      location.hash = '';
    }
  }

  // ─── Denied messages ─────────────────────────────────────────────────────
  var DENIED_MESSAGES = {
    'not-in-guild':    "Your Discord account isn't in the VEYRA EMPIRE guild. Join the guild first, then come back.",
    'no-tier':         "You're in the guild, but you haven't been assigned a tier yet. Check with an officer on Discord to get registered.",
    'not-configured':  "The sign-in system isn't configured yet. Contact the admin.",
    'oauth-state':     "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-exchange':  "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-identity':  "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-guilds':    "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'oauth-error':     "Sign-in failed. Try again, or contact an officer if it keeps happening.",
    'bad-token':       "That install link is no longer valid. Ask an officer for a fresh one.",
    'expired':         "Your session expired. Sign in again."
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

    var sid = sessionStorage.getItem('sid') || '';
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

  // ─── Sign-in / sign-out ──────────────────────────────────────────────────
  elSignin.addEventListener('click', function(e) {
    e.preventDefault();
    elSignin.textContent = 'Loading\u2026';
    fetch(PROXY_URL + '?api=authorize-url', { credentials: 'omit' })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j && j.url) {
          location.href = j.url;
        } else {
          elSignin.textContent = 'Sign in with Discord';
          showDenied(j && j.error === 'not-configured' ? 'not-configured' : 'oauth-error');
        }
      })
      .catch(function() {
        elSignin.textContent = 'Sign in with Discord';
        showDenied('oauth-error');
      });
  });

  elSignout.addEventListener('click', function(e) {
    e.preventDefault();
    sessionStorage.removeItem('sid');
    location.replace(location.pathname);
  });

  // ─── Session fetch ───────────────────────────────────────────────────────
  function loadSession(sid) {
    show(elLoading);
    fetch(PROXY_URL + '?api=session&sid=' + encodeURIComponent(sid), { credentials: 'omit' })
      .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
      .then(function(res) {
        if (res.status === 200 && !res.body.error) {
          renderScripts(res.body);
        } else {
          sessionStorage.removeItem('sid');
          if (res.body && res.body.error) showDenied(res.body.error);
          else show(elOauth);
        }
      })
      .catch(function() {
        sessionStorage.removeItem('sid');
        showDenied('oauth-error');
      });
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  function init() {
    var hash = parseHash();

    if (hash.session) {
      sessionStorage.setItem('sid', hash.session);
      clearHash();
    } else if (hash.denied) {
      sessionStorage.removeItem('sid');
      clearHash();
      showDenied(hash.denied);
      return;
    }

    var sid = sessionStorage.getItem('sid');
    if (sid) {
      loadSession(sid);
    } else {
      show(elOauth);
    }
  }

  init();
})();

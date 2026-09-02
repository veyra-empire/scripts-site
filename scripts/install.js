(function() {
  'use strict';

  // Must match PROXY_URL in app.js.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';
  var CACHE_KEY = 'veyra_session';

  // ─── JSONP helper (matches app.js) ───────────────────────────────────────
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

  function show(id) {
    ['state-installing', 'state-unauthenticated', 'state-expired', 'state-manual'].forEach(function(s) {
      var el = document.getElementById(s);
      if (el) el.hidden = (s !== id);
    });
  }

  /**
   * How the minted URL is handed to Tampermonkey. Default is unchanged; the
   * other two are diagnostics for the stray "intermediate step" tab that TM
   * leaves behind after an install.
   *
   * Two candidate causes, and these separate them:
   *   1. the Google sign-in detour on the /exec/<path>.user.js form, which
   *      crosses origins twice before the script arrives, or
   *   2. simply that location.replace is a scripted navigation rather than a
   *      link click, which is TM's normal install path.
   *
   *   (default) location.replace - today's behaviour, the baseline.
   *   anchor    a real <a> clicked from script. Same instant hand-off and the
   *             same ~1s token lifetime, so if this fixes it we ship it with
   *             no UX change and no change to the security posture.
   *   manual    a visible link the user clicks. The truest "real click", but
   *             it leaves the minted token unconsumed in the DOM until then
   *             (up to INSTALL_TOKEN_TTL, currently 60s). Diagnostic only -
   *             not a shape to ship without shortening that window first.
   */
  function go(url, mode) {
    if (mode === 'manual') {
      var link = document.getElementById('manual-link');
      if (link) { link.href = url; show('state-manual'); return; }
    }
    if (mode === 'anchor') {
      var a = document.createElement('a');
      a.href = url;
      document.body.appendChild(a);
      a.click();
      return;
    }
    location.replace(url);
  }

  function getSid() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.sid ? data.sid : null;
    } catch (_) { return null; }
  }

  function parseQuery() {
    var q = location.search.replace(/^\?/, '');
    var out = {};
    if (!q) return out;
    q.split('&').forEach(function(kv) {
      var i = kv.indexOf('=');
      if (i >= 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }

  /**
   * A dead session used to dead-end here: we cleared the cached sid, printed
   * "sign in again at the archive", and left the member to navigate back,
   * re-authenticate, re-find the script and click Install a second time. Since
   * re-auth is a silent Discord redirect, all of that can happen on its own -
   * hand the script id to the archive, let it re-authenticate, and it sends us
   * back here with a fresh sid. `retry` is the loop guard: one recovery
   * attempt, then we show the error for real.
   */
  function handoffToArchive(scriptId) {
    try { sessionStorage.setItem('veyra_resume_install', scriptId); } catch (_) {}
    location.replace('./');
  }

  function fail(state, message) {
    if (message) {
      var el = document.getElementById(state === 'state-expired' ? 'expired-msg' : 'unauth-msg');
      if (el) el.textContent = message;
    }
    show(state);
  }

  function init() {
    var q = parseQuery();
    var scriptId = q.s || null;
    var retried  = !!q.retry;
    if (!scriptId) { fail('state-unauthenticated', 'No script id specified.'); return; }

    var sid = getSid();
    if (!sid) {
      // No session at all. On a first attempt that is still recoverable -
      // the archive can sign us in silently and send us straight back.
      if (!retried) { handoffToArchive(scriptId); return; }
      fail('state-unauthenticated');
      return;
    }

    document.getElementById('status').textContent = 'Preparing install for "' + scriptId + '"...';

    jsonp(PROXY_URL +
          '?api=mint-install-token' +
          '&session=' + encodeURIComponent(sid) +
          '&s=' + encodeURIComponent(scriptId))
      .then(function(body) {
        if (body && body.token) {
          var url = PROXY_URL + '/' + encodeURIComponent(scriptId) + '.user.js' +
                    '?s=' + encodeURIComponent(scriptId) +
                    '&it=' + encodeURIComponent(body.token);
          go(url, q.mode);
          return;
        }
        // Known error shapes from the proxy.
        var err = body && body.error;
        if (err === 'expired') {
          // The sid really is dead server-side, so drop it - keeping it would
          // just fail the next install too. Then recover automatically rather
          // than stranding the member on an error.
          try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
          if (!retried) { handoffToArchive(scriptId); return; }
          fail('state-expired', 'Your sign-in session expired. Sign in again at the archive.');
        } else if (err === 'server') {
          fail('state-expired', 'The archive server hit a temporary problem. Wait a moment and try Install again.');
        } else if (err === 'tier-insufficient') {
          fail('state-expired', "Your current tier doesn't grant access to this script. Contact an officer if this is unexpected.");
        } else if (err === 'unknown') {
          fail('state-expired', 'This script is no longer distributed.');
        } else {
          fail('state-expired', 'Install failed. Try again, or contact an officer.');
        }
      })
      .catch(function() {
        fail('state-expired', 'Network error minting install token. Try again in a moment.');
      });
  }

  init();
})();

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
    ['state-installing', 'state-unauthenticated', 'state-expired'].forEach(function(s) {
      var el = document.getElementById(s);
      if (el) el.hidden = (s !== id);
    });
  }

  function getSid() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.sid ? data.sid : null;
    } catch (_) { return null; }
  }

  function getScriptId() {
    var q = location.search.replace(/^\?/, '');
    if (!q) return null;
    var out = {};
    q.split('&').forEach(function(kv) {
      var i = kv.indexOf('=');
      if (i >= 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
    });
    return out.s || null;
  }

  function fail(state, message) {
    if (message) {
      var el = document.getElementById(state === 'state-expired' ? 'expired-msg' : 'unauth-msg');
      if (el) el.textContent = message;
    }
    show(state);
  }

  function init() {
    var scriptId = getScriptId();
    if (!scriptId) { fail('state-unauthenticated', 'No script id specified.'); return; }

    var sid = getSid();
    if (!sid) { fail('state-unauthenticated'); return; }

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
          location.replace(url);
          return;
        }
        // Known error shapes from the proxy.
        var err = body && body.error;
        if (err === 'expired') {
          // Stale sid in localStorage - clear it so the archive forces re-sign-in.
          try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
          fail('state-expired', 'Your sign-in session expired. Sign in again at the archive.');
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

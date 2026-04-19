(function() {
  'use strict';

  // Must match PROXY_URL in app.js / install.js.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';
  var CACHE_KEY = 'veyra_session';
  var MAX_BYTES = 2 * 1024 * 1024;

  // ─── JSONP helper (GET endpoints only) ────────────────────────────────────
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

  // ─── State show helper ────────────────────────────────────────────────────
  var STATE_IDS = ['state-loading', 'state-unauthenticated', 'state-form', 'state-submitting', 'state-success'];
  function show(id) {
    STATE_IDS.forEach(function(s) {
      var el = document.getElementById(s);
      if (el) el.hidden = (s !== id);
    });
  }

  function getSession() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  // ─── Userscript header parse ──────────────────────────────────────────────
  function parseHeader(source) {
    var match = source.match(/\/\/\s*==UserScript==[\s\S]*?\/\/\s*==\/UserScript==/);
    if (!match) return null;
    var tags = {};
    var lines = match[0].split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\s*\/\/\s*@([\w-]+)\s+(.+?)\s*$/);
      if (m) tags[m[1]] = m[2];
    }
    return tags;
  }

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  var session = null;
  var ownedScripts = [];  // [{id, name, description, minTier, threadUrl}, ...]
  var form, modeInputs, idNewRow, idUpdateRow, idNew, idUpdate;
  var fieldName, fieldAuthor, fieldDescription, fieldMinTier, fieldThread, fieldSource, fieldAttest;
  var submitBtn, formError, sourceHint, modeUpdateLabel;

  function bindRefs() {
    form             = document.getElementById('submit-form');
    modeInputs       = Array.prototype.slice.call(form.querySelectorAll('input[name="mode"]'));
    modeUpdateLabel  = document.getElementById('mode-update-label');
    idNewRow         = document.getElementById('id-new-row');
    idUpdateRow      = document.getElementById('id-update-row');
    idNew            = document.getElementById('id-new');
    idUpdate         = document.getElementById('id-update');
    fieldName        = document.getElementById('field-name');
    fieldAuthor      = document.getElementById('field-author');
    fieldDescription = document.getElementById('field-description');
    fieldMinTier     = document.getElementById('field-min-tier');
    fieldThread      = document.getElementById('field-thread');
    fieldSource      = document.getElementById('field-source');
    fieldAttest      = document.getElementById('field-attest');
    submitBtn        = document.getElementById('submit-btn');
    formError        = document.getElementById('form-error');
    sourceHint       = document.getElementById('source-hint');
  }

  // ─── Mode switching ───────────────────────────────────────────────────────
  function currentMode() {
    for (var i = 0; i < modeInputs.length; i++) if (modeInputs[i].checked) return modeInputs[i].value;
    return 'new';
  }

  function applyMode() {
    var mode = currentMode();
    idNewRow.hidden    = mode !== 'new';
    idUpdateRow.hidden = mode !== 'update';
    if (mode === 'update') {
      // Pre-fill from the selected script if one is selected.
      prefillFromSelectedUpdate();
    }
    updateSubmitEnabled();
  }

  function prefillFromSelectedUpdate() {
    var selectedId = idUpdate.value;
    if (!selectedId) return;
    var s = ownedScripts.find(function(x) { return x.id === selectedId; });
    if (!s) return;
    // Only fill fields that are empty, so we don't clobber user edits.
    if (!fieldName.value)        fieldName.value        = s.name || '';
    if (!fieldDescription.value) fieldDescription.value = s.description || '';
    if (!fieldThread.value)      fieldThread.value      = s.threadUrl || '';
    if (s.minTier) fieldMinTier.value = s.minTier;
  }

  // ─── Source auto-fill on paste/drop ───────────────────────────────────────
  function autoFillFromSource() {
    var source = fieldSource.value;
    var tags = parseHeader(source);
    if (!tags) return;
    if (!fieldName.value        && tags.name)        fieldName.value        = tags.name;
    if (!fieldAuthor.value      && tags.author)      fieldAuthor.value      = tags.author;
    if (!fieldDescription.value && tags.description) fieldDescription.value = tags.description;
    // If script header has a @veyra-min-tier, honor it
    if (tags['veyra-min-tier']) {
      var allowed = ['probationary', 'member', 'trusted'];
      if (allowed.indexOf(tags['veyra-min-tier']) >= 0) {
        fieldMinTier.value = tags['veyra-min-tier'];
      }
    }
    if (!fieldThread.value && tags['veyra-thread']) fieldThread.value = tags['veyra-thread'];
    // If new mode + empty id, suggest one from @name
    if (currentMode() === 'new' && !idNew.value && tags.name) {
      idNew.value = slugify(tags.name);
    }
    updateSubmitEnabled();
  }

  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 48);
  }

  // ─── Drag-drop onto source textarea ──────────────────────────────────────
  function wireDragDrop() {
    var stopDefault = function(e) { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(evt) {
      fieldSource.addEventListener(evt, stopDefault);
    });
    fieldSource.addEventListener('dragover', function() { fieldSource.classList.add('drag-over'); });
    fieldSource.addEventListener('dragleave', function() { fieldSource.classList.remove('drag-over'); });
    fieldSource.addEventListener('drop', function(e) {
      fieldSource.classList.remove('drag-over');
      var dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      var file = dt.files[0];
      if (file.size > MAX_BYTES) {
        showError('That file is larger than the 2 MB limit.');
        return;
      }
      var reader = new FileReader();
      reader.onload = function() {
        fieldSource.value = String(reader.result || '');
        autoFillFromSource();
        updateSizeHint();
      };
      reader.onerror = function() { showError('Failed to read file.'); };
      reader.readAsText(file);
    });
  }

  function updateSizeHint() {
    var bytes = (new Blob([fieldSource.value])).size;
    var kb = (bytes / 1024).toFixed(1);
    sourceHint.textContent = 'Max 2 MB. Current: ' + kb + ' KB.';
    sourceHint.style.color = bytes > MAX_BYTES ? 'var(--danger)' : '';
  }

  // ─── Submit enablement ────────────────────────────────────────────────────
  function updateSubmitEnabled() {
    var mode = currentMode();
    var idOk = mode === 'new'
      ? /^[a-z0-9][a-z0-9-]{1,48}$/.test(idNew.value)
      : !!idUpdate.value;
    var sourceOk = fieldSource.value.length > 0 && fieldSource.value.length <= MAX_BYTES;
    var attestOk = fieldAttest.checked;
    submitBtn.disabled = !(idOk && sourceOk && attestOk);
  }

  // ─── Error display ────────────────────────────────────────────────────────
  var ERROR_MESSAGES = {
    'expired':            'Your sign-in session expired. Reload the archive and sign in again.',
    'not-tiered':         'Submission is restricted to members with an assigned tier. Contact an officer.',
    'duplicate-id':       "A script with that ID already exists and you aren't the owner. Pick a different ID, or ask lmv if you believe this is an error.",
    'not-found':          "No script with that ID exists. Switch to New mode, or pick a different script to update.",
    'not-owner':          "You don't own this script. Only the original submitter (or lmv) can update it.",
    'rate-limited':       'You have an open submission pending review, or you\'ve hit the daily/weekly limit. Try again later.',
    'invalid-script':     "The script source doesn't look like a valid userscript. Make sure it has a // ==UserScript== block with at least @name and @version.",
    'invalid-id':         'Script ID must be lowercase letters, digits, and hyphens only (2-49 chars).',
    'invalid-min-tier':   'Min tier must be probationary, member, or trusted.',
    'invalid-thread-url': 'Thread URL must start with https://',
    'too-large':          'Script exceeds the 2 MB limit.',
    'github-error':       'GitHub is having trouble right now. Try again in a few minutes.',
    'server-error':       'Something went wrong on the server. Contact an officer.',
    'unknown-api':        'Server received an unknown request. Contact an officer.',
    'forbidden':          'Server rejected the request. Contact an officer.'
  };

  function showError(text) {
    formError.textContent = text;
    formError.hidden = false;
  }

  function clearError() {
    formError.textContent = '';
    formError.hidden = true;
  }

  // ─── Submit handler ───────────────────────────────────────────────────────
  function handleSubmit(e) {
    e.preventDefault();
    clearError();

    if (!session) { show('state-unauthenticated'); return; }

    var mode = currentMode();
    var id = mode === 'new' ? idNew.value.trim() : idUpdate.value.trim();
    if (!id) { showError('Pick a script ID.'); return; }

    var source = fieldSource.value;
    if (!source) { showError('Paste or drop the script source.'); return; }
    if ((new Blob([source])).size > MAX_BYTES) { showError('Script exceeds the 2 MB limit.'); return; }
    if (!fieldAttest.checked) { showError('You must confirm the attestation.'); return; }

    var body = {
      api:         'submit-script',
      sid:         session.sid,
      mode:        mode,
      id:          id,
      name:        fieldName.value.trim()        || undefined,
      author:      fieldAuthor.value.trim()      || undefined,
      description: fieldDescription.value.trim() || undefined,
      minTier:     fieldMinTier.value,
      threadUrl:   fieldThread.value.trim()      || undefined,
      source:      source
    };

    show('state-submitting');

    fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body:    JSON.stringify(body),
      credentials: 'omit'
    })
      .then(function(r) {
        // Apps Script ContentService responses should include ACAO:* so we
        // can read the body. If CORS blocks reading, this throws.
        return r.text().then(function(t) {
          try { return JSON.parse(t); }
          catch (_) { return { error: 'server-error', detail: 'Non-JSON response' }; }
        });
      })
      .then(function(data) {
        if (data && data.prNumber) {
          var titleEl = document.getElementById('success-title');
          var detailEl = document.getElementById('success-detail');
          titleEl.textContent = data.mode === 'update'
            ? 'Your update was submitted.'
            : 'Your script was submitted.';
          detailEl.textContent = 'PR #' + data.prNumber +
            ' - lmv will review within a day or two. If accepted, the archive will show it after merge.';
          show('state-success');
        } else {
          show('state-form');
          var msg = ERROR_MESSAGES[data && data.error] ||
                    ('Submission failed' + (data && data.detail ? ': ' + data.detail : '.'));
          showError(msg);
        }
      })
      .catch(function(err) {
        show('state-form');
        showError('Network error submitting: ' + (err && err.message || err) +
                  '. (If this persists, your browser may be blocking the request - try another browser or contact lmv.)');
      });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    bindRefs();

    session = getSession();
    if (!session || !session.sid) { show('state-unauthenticated'); return; }

    // Pre-fill author from session name.
    fieldAuthor.value = session.name || '';

    // Fetch list of scripts the user owns so we can enable the update mode.
    jsonp(PROXY_URL + '?api=my-scripts&session=' + encodeURIComponent(session.sid))
      .then(function(res) {
        if (res && res.error === 'expired') { show('state-unauthenticated'); return; }
        ownedScripts = (res && res.scripts) || [];
        if (!ownedScripts.length) {
          modeUpdateLabel.classList.add('disabled');
          modeUpdateLabel.querySelector('input').disabled = true;
        } else {
          // Populate the update-mode dropdown.
          idUpdate.innerHTML = '';
          var first = document.createElement('option');
          first.value = '';
          first.textContent = '-- select --';
          idUpdate.appendChild(first);
          ownedScripts.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name + '  (' + s.id + ')';
            idUpdate.appendChild(opt);
          });
        }
        show('state-form');
        wireForm();
      })
      .catch(function() {
        // Still allow submission in new mode even if my-scripts fails.
        modeUpdateLabel.classList.add('disabled');
        modeUpdateLabel.querySelector('input').disabled = true;
        show('state-form');
        wireForm();
      });
  }

  function wireForm() {
    // Mode switching
    modeInputs.forEach(function(r) { r.addEventListener('change', applyMode); });
    applyMode();

    // Update-dropdown selection
    idUpdate.addEventListener('change', function() {
      prefillFromSelectedUpdate();
      updateSubmitEnabled();
    });

    // Source auto-fill
    fieldSource.addEventListener('input', function() {
      autoFillFromSource();
      updateSizeHint();
    });
    fieldSource.addEventListener('blur', autoFillFromSource);
    wireDragDrop();
    updateSizeHint();

    // Enablement watchers
    [idNew, fieldAttest].forEach(function(el) {
      el.addEventListener('input', updateSubmitEnabled);
      el.addEventListener('change', updateSubmitEnabled);
    });

    // Submit
    form.addEventListener('submit', handleSubmit);
  }

  init();
})();

(function() {
  'use strict';

  // Must match PROXY_URL in app.js / install.js.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';
  var CACHE_KEY = 'veyra_session';
  var MAX_BYTES = 3 * 1024 * 1024;
  var MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
  var VALID_SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

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
  // Holds every script in the manifest (the submission flow is open: any
  // tiered member can update or delete any script, lmv reviews each PR).
  // Each entry includes the script's recorded `author` and `ownerDiscordId`
  // so the dropdown can show "name - by author (id)" and the form can
  // prefill `fieldAuthor` from the existing manifest author rather than
  // overwriting it with the submitter's name.
  var availableScripts = [];
  var pendingScreenshot = null;  // { mimeType, base64 } or null
  var form, modeInputs;
  var idNewRow, idUpdateRow, idDeleteRow, idNew, idUpdate, idDelete;
  var fieldName, fieldAuthor, fieldDescription, fieldMinTier, fieldThread, fieldSource, fieldAttest, fieldRequiresAuth;
  var fieldScreenshot, screenshotPreview, screenshotPreviewImg, screenshotClearBtn;
  var fieldSubmitterName, fieldReason, fieldDeleteAttest;
  var deleteNameRow, deleteReasonRow, deleteAttestRow;
  var fieldVersion, fieldVersionBtn, fieldPurpose;
  var versionWarning, vwNew, vwCur, vwCur2;
  var submitBtn, formError, sourceHint, modeUpdateLabel, modeDeleteLabel;
  var submitOnlyRows, deleteOnlyRows, updateOnlyRows;

  function bindRefs() {
    form             = document.getElementById('submit-form');
    modeInputs       = Array.prototype.slice.call(form.querySelectorAll('input[name="mode"]'));
    modeUpdateLabel  = document.getElementById('mode-update-label');
    modeDeleteLabel  = document.getElementById('mode-delete-label');
    idNewRow         = document.getElementById('id-new-row');
    idUpdateRow      = document.getElementById('id-update-row');
    idDeleteRow      = document.getElementById('id-delete-row');
    idNew            = document.getElementById('id-new');
    idUpdate         = document.getElementById('id-update');
    idDelete         = document.getElementById('id-delete');
    fieldName        = document.getElementById('field-name');
    fieldAuthor      = document.getElementById('field-author');
    fieldDescription = document.getElementById('field-description');
    fieldMinTier     = document.getElementById('field-min-tier');
    fieldThread      = document.getElementById('field-thread');
    fieldSource      = document.getElementById('field-source');
    fieldAttest      = document.getElementById('field-attest');
    fieldRequiresAuth = document.getElementById('field-requires-auth');
    fieldScreenshot       = document.getElementById('field-screenshot');
    screenshotPreview     = document.getElementById('screenshot-preview');
    screenshotPreviewImg  = document.getElementById('screenshot-preview-img');
    screenshotClearBtn    = document.getElementById('screenshot-clear');
    fieldSubmitterName = document.getElementById('field-submitter-name');
    fieldReason        = document.getElementById('field-reason');
    fieldDeleteAttest  = document.getElementById('field-delete-attest');
    deleteNameRow      = document.getElementById('delete-name-row');
    deleteReasonRow    = document.getElementById('delete-reason-row');
    deleteAttestRow    = document.getElementById('delete-attest-row');
    fieldVersion     = document.getElementById('field-version');
    fieldVersionBtn  = document.getElementById('field-version-btn');
    fieldPurpose     = document.getElementById('field-purpose');
    versionWarning   = document.getElementById('version-warning');
    vwNew            = document.getElementById('vw-new');
    vwCur            = document.getElementById('vw-cur');
    vwCur2           = document.getElementById('vw-cur2');
    submitBtn        = document.getElementById('submit-btn');
    formError        = document.getElementById('form-error');
    sourceHint       = document.getElementById('source-hint');
    submitOnlyRows   = Array.prototype.slice.call(form.querySelectorAll('.submit-only'));
    deleteOnlyRows   = Array.prototype.slice.call(form.querySelectorAll('.delete-only'));
    updateOnlyRows   = Array.prototype.slice.call(form.querySelectorAll('.update-only'));
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
    idDeleteRow.hidden = mode !== 'delete';

    // Visibility by mode:
    // - submit-only (source/screenshot/attest): shown for new+update, hidden for delete
    // - delete-only (name/reason/delete-attest): shown for delete only
    // - update-only (version/purpose): shown for update only
    var showSubmit = mode !== 'delete';
    submitOnlyRows.forEach(function(el) { el.hidden = !showSubmit; });
    deleteOnlyRows.forEach(function(el) { el.hidden = showSubmit; });
    updateOnlyRows.forEach(function(el) { el.hidden = mode !== 'update'; });

    if (mode === 'update') prefillFromSelectedUpdate();
    updateSubmitBtnLabel();
    updateSubmitEnabled();
    updateVersionWarning();
  }

  function updateSubmitBtnLabel() {
    var mode = currentMode();
    submitBtn.textContent = mode === 'delete' ? 'Submit deletion request' : 'Submit';
  }

  function prefillFromSelectedUpdate() {
    var selectedId = idUpdate.value;
    if (!selectedId) return;
    var s = availableScripts.find(function(x) { return x.id === selectedId; });
    if (!s) return;
    // Only fill fields that are empty, so we don't clobber user edits.
    if (!fieldName.value)        fieldName.value        = s.name || '';
    if (!fieldDescription.value) fieldDescription.value = s.description || '';
    if (!fieldThread.value)      fieldThread.value      = s.threadUrl || '';
    if (s.minTier) fieldMinTier.value = s.minTier;
    // Prefill the auth flag from the script's current state. Submitter can
    // toggle if they want to change it as part of this update.
    if (fieldRequiresAuth) fieldRequiresAuth.checked = s.requiresAuth === true;
    // Prefill author from the manifest's recorded author rather than the
    // session.name default. Cross-author updates preserve attribution by
    // default; submitter can still override (e.g. add themselves as a
    // co-author) before submitting.
    if (s.author) fieldAuthor.value = s.author;
    updateVersionWarning();
  }

  // Semver-lite numeric compare. Returns <0 if a<b, 0 if equal, >0 if a>b.
  // Non-numeric segments fall back to string compare. Missing segments are 0.
  function compareVersions(a, b) {
    var pa = String(a || '').split('.');
    var pb = String(b || '').split('.');
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var sa = pa[i] || '0';
      var sb = pb[i] || '0';
      var na = parseInt(sa, 10);
      var nb = parseInt(sb, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      if (isNaN(na) || isNaN(nb)) {
        if (sa !== sb) return sa < sb ? -1 : 1;
      }
    }
    return 0;
  }

  // Advisory banner: if the submitter types a version lower than the currently
  // distributed one, Tampermonkey won't auto-install the rollback. Surface the
  // catch but don't block the submit - contributor may have a good reason.
  function updateVersionWarning() {
    if (!versionWarning) return;
    if (currentMode() !== 'update') { versionWarning.hidden = true; return; }
    var selectedId = idUpdate.value;
    var s = selectedId && availableScripts.find(function(x) { return x.id === selectedId; });
    var current = s && s.version;
    var proposed = fieldVersion && fieldVersion.value.trim();
    if (!current || !proposed) { versionWarning.hidden = true; return; }
    if (compareVersions(proposed, current) < 0) {
      vwNew.textContent  = proposed;
      vwCur.textContent  = current;
      vwCur2.textContent = current;
      versionWarning.hidden = false;
    } else {
      versionWarning.hidden = true;
    }
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
      var allowed = ['probationary', 'member', 'tester'];
      if (allowed.indexOf(tags['veyra-min-tier']) >= 0) {
        fieldMinTier.value = tags['veyra-min-tier'];
      }
    }
    if (!fieldThread.value && tags['veyra-thread']) fieldThread.value = tags['veyra-thread'];
    // If new mode + empty id, suggest one from @name
    if (currentMode() === 'new' && !idNew.value && tags.name) {
      idNew.value = slugify(tags.name);
    }
    // Update mode: pre-bake the version field (locked) whenever the locked state is on.
    // Don't overwrite a user's in-progress edit.
    if (currentMode() === 'update' && tags.version && fieldVersion.readOnly) {
      fieldVersion.value = tags.version;
    }
    updateSubmitEnabled();
    updateVersionWarning();
  }

  // Version field: locked by default, Edit button unlocks, Confirm re-locks.
  function wireVersionToggle() {
    fieldVersionBtn.addEventListener('click', function() {
      if (fieldVersion.readOnly) {
        fieldVersion.readOnly = false;
        fieldVersion.focus();
        fieldVersion.select();
        fieldVersionBtn.textContent = 'Confirm';
        fieldVersionBtn.classList.add('version-btn-confirm');
      } else {
        fieldVersion.readOnly = true;
        fieldVersionBtn.textContent = 'Edit';
        fieldVersionBtn.classList.remove('version-btn-confirm');
      }
    });
  }

  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 48);
  }

  // Shared file->textarea loader used by both drag-drop and the Upload button.
  // Mobile browsers don't expose drag-drop on touch; the Upload button is the
  // only intake path that works there. Also handy for anyone with a .user.js
  // file on disk who doesn't want to open-and-paste.
  function loadSourceFromFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      showError('That file is larger than the 3 MB limit.');
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
  }

  // ─── Source intake (drag-drop + file picker) ─────────────────────────────
  function wireSourceIntake() {
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
      loadSourceFromFile(dt.files[0]);
    });

    // Upload button - visible label acts as a file picker trigger. Works on
    // mobile where drag-drop is unavailable and clipboards can't hold multi-KB
    // source reliably.
    var fieldSourceFile = document.getElementById('field-source-file');
    if (fieldSourceFile) {
      fieldSourceFile.addEventListener('change', function() {
        var f = fieldSourceFile.files && fieldSourceFile.files[0];
        loadSourceFromFile(f);
        // Reset so re-selecting the same file re-triggers change.
        fieldSourceFile.value = '';
      });
    }
  }

  function updateSizeHint() {
    var bytes = (new Blob([fieldSource.value])).size;
    var kb = (bytes / 1024).toFixed(1);
    sourceHint.textContent = 'Max 3 MB. Current: ' + kb + ' KB.';
    sourceHint.style.color = bytes > MAX_BYTES ? 'var(--danger)' : '';
  }

  // ─── Screenshot upload ───────────────────────────────────────────────────
  function wireScreenshot() {
    fieldScreenshot.addEventListener('change', function() {
      var file = fieldScreenshot.files && fieldScreenshot.files[0];
      if (!file) { clearScreenshot(); return; }
      if (VALID_SCREENSHOT_MIMES.indexOf(file.type) < 0) {
        toast('error', 'Screenshot must be PNG, JPEG, or WebP.');
        fieldScreenshot.value = '';
        return;
      }
      if (file.size > MAX_SCREENSHOT_BYTES) {
        toast('error', 'Screenshot is larger than the 2 MB limit.');
        fieldScreenshot.value = '';
        return;
      }
      var reader = new FileReader();
      reader.onload = function() {
        // reader.result is a data URL: "data:image/png;base64,<payload>"
        var dataUrl = String(reader.result || '');
        var commaIdx = dataUrl.indexOf(',');
        var base64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : '';
        pendingScreenshot = { mimeType: file.type, base64: base64 };
        screenshotPreviewImg.src = dataUrl;
        screenshotPreview.hidden = false;
      };
      reader.onerror = function() { toast('error', 'Failed to read screenshot file.'); };
      reader.readAsDataURL(file);
    });

    screenshotClearBtn.addEventListener('click', clearScreenshot);
  }

  function clearScreenshot() {
    pendingScreenshot = null;
    fieldScreenshot.value = '';
    screenshotPreview.hidden = true;
    screenshotPreviewImg.removeAttribute('src');
  }

  // ─── Submit enablement ────────────────────────────────────────────────────
  function updateSubmitEnabled() {
    var mode = currentMode();
    var idOk, sourceOk, attestOk;
    if (mode === 'new') {
      idOk     = /^[a-z0-9][a-z0-9-]{1,48}$/.test(idNew.value);
      sourceOk = fieldSource.value.length > 0 && fieldSource.value.length <= MAX_BYTES;
      attestOk = fieldAttest.checked;
    } else if (mode === 'update') {
      idOk     = !!idUpdate.value;
      sourceOk = fieldSource.value.length > 0 && fieldSource.value.length <= MAX_BYTES;
      attestOk = fieldAttest.checked;
    } else {
      // delete
      idOk     = !!idDelete.value;
      sourceOk = true;  // no source needed
      attestOk = fieldDeleteAttest.checked &&
                 fieldSubmitterName.value.trim().length > 0 &&
                 fieldReason.value.trim().length >= 10;
    }
    submitBtn.disabled = !(idOk && sourceOk && attestOk);
  }

  // ─── Error display ────────────────────────────────────────────────────────
  var ERROR_MESSAGES = {
    'expired':            'Your sign-in session expired. Reload the archive and sign in again.',
    'not-tiered':         'Submission is restricted to members with an assigned tier. Contact an officer.',
    'duplicate-id':       "A script with that ID already exists and you aren't the owner. Pick a different ID, or ask lmv if you believe this is an error.",
    'not-found':          "No script with that ID exists. Switch to New mode, or pick a different script to update.",
    'not-owner':          "You don't own this script. Only the original submitter (or lmv) can update it.",
    'invalid-script':     "The script source doesn't look like a valid userscript. Make sure it has a // ==UserScript== block with at least @name and @version.",
    'pre-injected-source': "Your source already contains VEYRA proxy code - it looks like you copied it out of Tampermonkey after installing. Please submit the original clean version instead (from your own editor before install, or from the veyra-empire/scripts repo).",
    'invalid-id':         'Script ID must be lowercase letters, digits, and hyphens only (2-49 chars).',
    'invalid-min-tier':   'Min tier must be Probationary, Full Member, or Tester.',
    'invalid-thread-url': 'Thread URL must start with https://',
    'too-large':          'Script exceeds the 3 MB limit.',
    'missing-name':       'Please provide your name for the deletion request.',
    'missing-reason':     'Please explain why this script should be deleted (at least 10 characters).',
    'reason-too-long':    'Reason is too long (2000 character limit).',
    'invalid-screenshot':        'Screenshot file is invalid or empty.',
    'invalid-screenshot-type':   'Screenshot must be PNG, JPEG, or WebP.',
    'screenshot-too-large':      'Screenshot exceeds the 2 MB limit.',
    'screenshot-upload-failed':  'Uploading the screenshot to GitHub failed. Try again in a few minutes.',
    'github-error':       'GitHub is having trouble right now. Try again in a few minutes.',
    'server-error':       'Something went wrong on the server. Contact an officer.',
    'unknown-api':        'Server received an unknown request. Contact an officer.',
    'forbidden':          'Server rejected the request. Contact an officer.'
  };

  /**
   * Format a rate-limited error response using the counts returned by the
   * server. Leads with the blocking reason (open-slots full / daily /
   * weekly) and always reports usage counts so the submitter can see
   * exactly where they stand.
   */
  function rateLimitMessage(detail) {
    if (!detail) return 'Rate limited. Try again later.';
    var openCount = detail.openCount || 0;
    var openLimit = detail.openLimit || 3;
    var pieces = [];
    if (openCount >= openLimit) {
      pieces.push('You have ' + openCount + '/' + openLimit +
                  ' submissions pending review. Cancel one above to submit something new.');
    } else if (detail.daily >= detail.dailyLimit) {
      pieces.push('You\'ve hit today\'s submission limit. Try again tomorrow.');
    } else if (detail.weekly >= detail.weeklyLimit) {
      pieces.push('You\'ve hit this week\'s submission limit. Try again next week.');
    } else {
      pieces.push('Rate limited.');
    }
    pieces.push('Used ' + detail.daily + '/' + detail.dailyLimit + ' today, ' +
                detail.weekly + '/' + detail.weeklyLimit + ' this week.');
    return pieces.join(' ');
  }

  function showError(text) {
    formError.textContent = text;
    formError.hidden = false;
  }

  function clearError() {
    formError.textContent = '';
    formError.hidden = true;
  }

  /**
   * Render the list of open PRs at the top of the form, one row per PR
   * with an individual cancel button. `list` is an array of {pr, title}.
   * Empty array hides the section.
   */
  function renderOpenSubmissions(list, openLimit) {
    var section = document.getElementById('open-submissions');
    if (!section) return;
    if (!list || !list.length) { section.hidden = true; return; }

    section.hidden = false;
    var countEl = document.getElementById('open-submissions-count');
    countEl.textContent = '(' + list.length + '/' + (openLimit || 3) + ')';

    var ul = document.getElementById('open-submissions-list');
    ul.innerHTML = '';
    list.forEach(function(entry) {
      var li = document.createElement('li');
      li.className = 'open-submissions-item';

      var label = document.createElement('span');
      label.className = 'open-submissions-label';
      var strong = document.createElement('strong');
      strong.textContent = 'PR #' + entry.pr;
      label.appendChild(strong);
      label.appendChild(document.createTextNode(' ' + (entry.title || '')));

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cancel-banner-btn';
      btn.textContent = 'Cancel';
      btn.addEventListener('click', function() { cancelSubmission(entry.pr, btn); });

      li.appendChild(label);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function cancelSubmission(prNumber, btn) {
    btn.disabled = true;
    btn.textContent = 'Cancelling...';
    fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body:    JSON.stringify({ api: 'cancel-submission', sid: session.sid, pr: prNumber }),
      credentials: 'omit'
    })
      .then(function(r) { return r.text().then(function(t) {
        try { return JSON.parse(t); } catch (_) { return { error: 'server-error' }; }
      }); })
      .then(function(data) {
        if (data && data.ok) {
          // Stash a toast to show after reload (reload refreshes the
          // open-list + quota so the UI is coherent).
          stashPendingToast({ type: 'info', message: 'Cancelled PR #' + prNumber + '.' });
          location.reload();
        } else {
          btn.disabled = false;
          btn.textContent = 'Cancel';
          toast('error', 'Cancel failed: ' + (data && data.error || 'unknown'));
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = 'Cancel';
        toast('error', 'Network error cancelling submission. Try again.');
      });
  }

  // ─── Toasts ───────────────────────────────────────────────────────────────
  // Lightweight non-blocking notifications. Used for cancel-success (after
  // reload, via sessionStorage handoff) and submit failures.

  var TOAST_TTL_MS = 6000;
  var TOAST_KEY    = 'veyra_submit_toast';

  function toast(type, message) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = message;
    el.addEventListener('click', function() { dismissToast(el); });
    container.appendChild(el);
    // Allow the browser to paint before adding the `show` class so the
    // CSS transition actually animates.
    requestAnimationFrame(function() { el.classList.add('show'); });
    setTimeout(function() { dismissToast(el); }, TOAST_TTL_MS);
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove('show');
    // Wait for the transition to finish before removing from DOM.
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  function stashPendingToast(t) {
    try { sessionStorage.setItem(TOAST_KEY, JSON.stringify(t)); } catch (_) {}
  }

  function flushPendingToast() {
    var raw;
    try { raw = sessionStorage.getItem(TOAST_KEY); sessionStorage.removeItem(TOAST_KEY); }
    catch (_) { return; }
    if (!raw) return;
    try {
      var t = JSON.parse(raw);
      if (t && t.message) toast(t.type || 'info', t.message);
    } catch (_) { /* ignore */ }
  }

  // ─── Submit handler ───────────────────────────────────────────────────────
  function handleSubmit(e) {
    e.preventDefault();
    clearError();

    if (!session) { show('state-unauthenticated'); return; }

    var mode = currentMode();
    var id;
    if (mode === 'new')         id = idNew.value.trim();
    else if (mode === 'update') id = idUpdate.value.trim();
    else                        id = idDelete.value.trim();
    if (!id) { showError('Pick a script ID.'); return; }

    if (mode === 'delete') {
      var submitterName = fieldSubmitterName.value.trim();
      var reason = fieldReason.value.trim();
      if (!submitterName) { showError('Enter your name for the deletion request.'); return; }
      if (reason.length < 10) { showError('Reason must be at least 10 characters.'); return; }
      if (!fieldDeleteAttest.checked) { showError('You must confirm the deletion is intentional.'); return; }
      show('state-submitting');
      sendSubmit({
        api:           'submit-script',
        sid:           session.sid,
        mode:          'delete',
        id:            id,
        submitterName: submitterName,
        reason:        reason
      });
      return;
    }

    var source = fieldSource.value;
    if (!source) { showError('Paste or drop the script source.'); return; }
    if ((new Blob([source])).size > MAX_BYTES) { showError('Script exceeds the 3 MB limit.'); return; }
    if (!fieldAttest.checked) { showError('You must confirm the attestation.'); return; }

    var body = {
      api:          'submit-script',
      sid:          session.sid,
      mode:         mode,
      id:           id,
      name:         fieldName.value.trim()        || undefined,
      author:       fieldAuthor.value.trim()      || undefined,
      description:  fieldDescription.value.trim() || undefined,
      minTier:      fieldMinTier.value,
      threadUrl:    fieldThread.value.trim()      || undefined,
      source:       source,
      screenshot:   pendingScreenshot              || undefined,
      // Per-script opt-in auth gate. When true the proxy injects the
      // anti-sharing bootstrap so unauthenticated clients see a stub.
      requiresAuth: fieldRequiresAuth && fieldRequiresAuth.checked || false
    };

    if (mode === 'update') {
      var ver = fieldVersion.value.trim();
      if (ver) body.version = ver;
      var purpose = fieldPurpose.value.trim();
      if (purpose) body.purpose = purpose;
    }

    show('state-submitting');
    sendSubmit(body);
  }

  function sendSubmit(body) {
    fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body:    JSON.stringify(body),
      credentials: 'omit'
    })
      .then(function(r) {
        return r.text().then(function(t) {
          try { return JSON.parse(t); }
          catch (_) { return { error: 'server-error', detail: 'Non-JSON response' }; }
        });
      })
      .then(function(data) {
        if (data && data.prNumber) {
          var titleEl  = document.getElementById('success-title');
          var detailEl = document.getElementById('success-detail');
          var modeLabel;
          if (data.mode === 'delete')     modeLabel = 'Your deletion request was submitted.';
          else if (data.mode === 'update') modeLabel = 'Your update was submitted.';
          else                             modeLabel = 'Your script was submitted.';
          titleEl.textContent = modeLabel;
          detailEl.textContent = 'PR #' + data.prNumber +
            ' - lmv will review within a day or two. ' +
            (data.mode === 'delete'
              ? 'Once merged, the script is removed from the archive.'
              : 'If accepted, the archive will show it after merge.');
          show('state-success');
        } else {
          show('state-form');
          var err = data && data.error;
          var msg;
          if (err === 'rate-limited') {
            msg = rateLimitMessage(data.detail);
            if (data.detail) {
              renderOpenSubmissions(data.detail.openPrs || [], data.detail.openLimit);
            }
          } else {
            msg = ERROR_MESSAGES[err] ||
                  ('Submission failed' + (data && data.detail ? ': ' + JSON.stringify(data.detail) : '.'));
          }
          showError(msg);
          toast('error', msg);
        }
      })
      .catch(function(err) {
        show('state-form');
        var msg = 'Network error submitting: ' + (err && err.message || err) +
                  '. (If this persists, your browser may be blocking the request - try another browser or contact lmv.)';
        showError(msg);
        toast('error', msg);
      });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    bindRefs();
    flushPendingToast();

    session = getSession();
    if (!session || !session.sid) { show('state-unauthenticated'); return; }

    // Pre-fill author from session name.
    fieldAuthor.value = session.name || '';

    // Fetch every script in the archive (submission flow is open; lmv
    // reviews cross-author submissions via the PR body banner). Also
    // fetches the caller's submission-rate-limit status for the cancel
    // banner.
    jsonp(PROXY_URL + '?api=my-scripts&session=' + encodeURIComponent(session.sid))
      .then(function(res) {
        if (res && res.error === 'expired') { show('state-unauthenticated'); return; }
        availableScripts = (res && res.scripts) || [];
        if (!availableScripts.length) {
          // Degenerate case: empty manifest. Update / Delete have nothing to
          // pick, so disable those modes. Doesn't happen in practice.
          modeUpdateLabel.classList.add('disabled');
          modeUpdateLabel.querySelector('input').disabled = true;
          modeDeleteLabel.classList.add('disabled');
          modeDeleteLabel.querySelector('input').disabled = true;
        } else {
          // Populate the update-mode and delete-mode dropdowns. Option text
          // includes author so cross-author submitters know whose script
          // they're picking (e.g. "Compact PvP - by [EMP] lmv (compact-pvp)").
          [idUpdate, idDelete].forEach(function(sel) {
            sel.innerHTML = '';
            var first = document.createElement('option');
            first.value = '';
            first.textContent = '-- select --';
            sel.appendChild(first);
            availableScripts.forEach(function(s) {
              var opt = document.createElement('option');
              opt.value = s.id;
              opt.textContent = s.name + ' - by ' + (s.author || 'unknown') + '  (' + s.id + ')';
              sel.appendChild(opt);
            });
          });
        }
        // Render the open-submissions list at form load.
        if (res && res.status) {
          renderOpenSubmissions(res.status.openPrs || [], res.status.openLimit);
        }
        show('state-form');
        wireForm();
      })
      .catch(function() {
        // Still allow submission in new mode even if my-scripts fails.
        modeUpdateLabel.classList.add('disabled');
        modeUpdateLabel.querySelector('input').disabled = true;
        modeDeleteLabel.classList.add('disabled');
        modeDeleteLabel.querySelector('input').disabled = true;
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
      updateVersionWarning();
    });

    // Lower-version advisory: re-check on any version-field change. Input
    // fires while typing (even when readonly is briefly flipped off), so
    // the warning appears/disappears as the submitter adjusts.
    if (fieldVersion) fieldVersion.addEventListener('input', updateVersionWarning);

    // Delete-mode input handlers
    idDelete.addEventListener('change', updateSubmitEnabled);
    fieldSubmitterName.addEventListener('input', updateSubmitEnabled);
    fieldReason.addEventListener('input', updateSubmitEnabled);
    fieldDeleteAttest.addEventListener('change', updateSubmitEnabled);

    // Source auto-fill
    fieldSource.addEventListener('input', function() {
      autoFillFromSource();
      updateSizeHint();
    });
    fieldSource.addEventListener('blur', autoFillFromSource);
    wireSourceIntake();
    wireScreenshot();
    wireVersionToggle();
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

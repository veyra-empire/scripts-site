(function() {
  'use strict';

  // Must match PROXY_URL in app.js / submit.js.
  var PROXY_URL = 'https://script.google.com/macros/s/AKfycbzUHg1z18WmWFSyEsZStaK2kmax2JXnPzK4LrTyEitSFVBQ2u2vfFeO6wZhjWx58EJZ7w/exec';
  var CACHE_KEY = 'veyra_session';
  var MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
  var VALID_SCREENSHOT_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
  var MAX_INSTRUCTIONS_STEPS = 15;
  var MAX_INSTRUCTION_LEN    = 500;

  // Must align with app.js' TIER_DISPLAY. Option values (the tier names
  // the proxy stores in manifest) stay lowercase; only the labels change.
  var TIER_DISPLAY = {
    probationary: 'Probationary',
    member:       'Full Member',
    tester:       'Tester',
    owner:        'Emperor'
  };
  function tierLabel(t) { return TIER_DISPLAY[t] || t || ''; }

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

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  var session = null;
  // Holds every resource in the manifest. Submission flow is open: any
  // tiered member can update or delete any resource, lmv reviews each PR.
  // Each entry includes `author` and `ownerDiscordId` for the cross-author
  // dropdown labels and author prefill (parallel to submit.js).
  var availableResources = [];
  var pendingScreenshot = null;  // { mimeType, base64 } or null
  var form, modeInputs;
  var idNewRow, idUpdateRow, idDeleteRow, idNew, idUpdate, idDelete;
  var fieldName, fieldAuthor, fieldDescription, fieldUrl, fieldMinTier, fieldThread, fieldAttest;
  var fieldScreenshot, screenshotPreview, screenshotPreviewImg, screenshotClearBtn;
  var fieldSubmitterName, fieldReason, fieldDeleteAttest;
  var deleteNameRow, deleteReasonRow, deleteAttestRow;
  var fieldVersion, fieldPurpose, fieldInstructions;
  var versionWarning, vwNew, vwCur;
  var submitBtn, formError, modeUpdateLabel, modeDeleteLabel;
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
    fieldUrl         = document.getElementById('field-url');
    fieldMinTier     = document.getElementById('field-min-tier');
    fieldThread      = document.getElementById('field-thread');
    fieldAttest      = document.getElementById('field-attest');
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
    fieldVersion       = document.getElementById('field-version');
    fieldPurpose       = document.getElementById('field-purpose');
    fieldInstructions  = document.getElementById('field-instructions');
    versionWarning     = document.getElementById('version-warning');
    vwNew              = document.getElementById('vw-new');
    vwCur              = document.getElementById('vw-cur');
    submitBtn          = document.getElementById('submit-btn');
    formError          = document.getElementById('form-error');
    submitOnlyRows     = Array.prototype.slice.call(form.querySelectorAll('.submit-only'));
    deleteOnlyRows     = Array.prototype.slice.call(form.querySelectorAll('.delete-only'));
    updateOnlyRows     = Array.prototype.slice.call(form.querySelectorAll('.update-only'));
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
    var r = availableResources.find(function(x) { return x.id === selectedId; });
    if (!r) return;
    // Only fill fields that are empty, so we don't clobber user edits.
    if (!fieldName.value)        fieldName.value        = r.name        || '';
    if (!fieldDescription.value) fieldDescription.value = r.description || '';
    if (!fieldUrl.value)         fieldUrl.value         = r.url         || '';
    if (!fieldThread.value)      fieldThread.value      = r.threadUrl   || '';
    if (r.minTier) fieldMinTier.value = r.minTier;
    if (!fieldVersion.value && r.version) fieldVersion.value = r.version;
    if (!fieldInstructions.value && Array.isArray(r.instructions) && r.instructions.length) {
      fieldInstructions.value = r.instructions.join('\n');
    }
    // Prefill author from manifest (same pattern as submit.js): preserves
    // attribution by default on cross-author updates. Submitter can still
    // override (e.g. add themselves as a co-author).
    if (r.author) fieldAuthor.value = r.author;
    updateVersionWarning();
  }

  // Semver-lite numeric compare. Returns <0 if a<b, 0 if equal, >0 if a>b.
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

  // Advisory banner: if the submitter types a lower version than the
  // current one. Only fires when BOTH old and new are non-empty, because
  // resources may legitimately be unversioned.
  function updateVersionWarning() {
    if (!versionWarning) return;
    if (currentMode() !== 'update') { versionWarning.hidden = true; return; }
    var selectedId = idUpdate.value;
    var r = selectedId && availableResources.find(function(x) { return x.id === selectedId; });
    var current  = r && r.version;
    var proposed = fieldVersion && fieldVersion.value.trim();
    if (!current || !proposed) { versionWarning.hidden = true; return; }
    if (compareVersions(proposed, current) < 0) {
      vwNew.textContent = proposed;
      vwCur.textContent = current;
      versionWarning.hidden = false;
    } else {
      versionWarning.hidden = true;
    }
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

  function slugify(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 48);
  }

  // Parse the Instructions textarea into a string[]. Empty lines are
  // dropped, surrounding whitespace trimmed, length capped.
  function parseInstructions() {
    var raw = (fieldInstructions && fieldInstructions.value) || '';
    if (!raw.trim()) return [];
    return raw.split(/\r?\n/)
      .map(function(l) { return l.trim(); })
      .filter(function(l) { return l.length > 0; });
  }

  function instructionsError(steps) {
    if (steps.length > MAX_INSTRUCTIONS_STEPS) return 'invalid-instructions';
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].length > MAX_INSTRUCTION_LEN) return 'invalid-instructions';
    }
    return null;
  }

  // ─── Submit enablement ────────────────────────────────────────────────────
  function updateSubmitEnabled() {
    var mode = currentMode();
    var idOk, urlOk, nameOk, descOk, attestOk;
    if (mode === 'new') {
      idOk     = /^[a-z0-9][a-z0-9-]{1,48}$/.test(idNew.value);
      urlOk    = /^https:\/\//i.test(fieldUrl.value.trim());
      nameOk   = fieldName.value.trim().length > 0;
      descOk   = fieldDescription.value.trim().length > 0;
      attestOk = fieldAttest.checked;
    } else if (mode === 'update') {
      idOk     = !!idUpdate.value;
      // URL can stay whatever's already stored; if typed it still must be https.
      var u = fieldUrl.value.trim();
      urlOk    = u === '' || /^https:\/\//i.test(u);
      nameOk   = true;
      descOk   = true;
      attestOk = fieldAttest.checked;
    } else {
      // delete
      idOk     = !!idDelete.value;
      urlOk    = true;
      nameOk   = true;
      descOk   = true;
      attestOk = fieldDeleteAttest.checked &&
                 fieldSubmitterName.value.trim().length > 0 &&
                 fieldReason.value.trim().length >= 10;
    }
    submitBtn.disabled = !(idOk && urlOk && nameOk && descOk && attestOk);
  }

  // ─── Error display ────────────────────────────────────────────────────────
  var ERROR_MESSAGES = {
    'expired':            'Your sign-in session expired. Reload the archive and sign in again.',
    'not-tiered':         'Submission is restricted to members with an assigned tier. Contact an officer.',
    'duplicate-id':       "A resource with that ID already exists and you aren't the owner. Pick a different ID, or ask lmv if you believe this is an error.",
    'not-found':          "No resource with that ID exists. Switch to New mode, or pick a different resource to update.",
    'not-owner':          "You don't own this resource. Only the original submitter (or lmv) can update it.",
    'invalid-id':         'Resource ID must be lowercase letters, digits, and hyphens only (2-49 chars).',
    'invalid-min-tier':   'Min tier must be Probationary, Full Member, or Tester.',
    'invalid-url':        'URL must start with https://',
    'missing-url':        'Please provide the URL members should open.',
    'missing-name':       'Please provide a display name for this resource.',
    'missing-reason':     'Please explain why this resource should be deleted (at least 10 characters).',
    'reason-too-long':    'Reason is too long (2000 character limit).',
    'invalid-thread-url': 'Thread URL must start with https://',
    'invalid-instructions': 'Instructions are too long or there are too many steps. Limit: 15 steps, 500 chars per step.',
    'invalid-screenshot':        'Screenshot file is invalid or empty.',
    'invalid-screenshot-type':   'Screenshot must be PNG, JPEG, or WebP.',
    'screenshot-too-large':      'Screenshot exceeds the 2 MB limit.',
    'screenshot-upload-failed':  'Uploading the screenshot to GitHub failed. Try again in a few minutes.',
    'github-error':       'GitHub is having trouble right now. Try again in a few minutes.',
    'server-error':       'Something went wrong on the server. Contact an officer.',
    'unknown-api':        'Server received an unknown request. Contact an officer.',
    'forbidden':          'Server rejected the request. Contact an officer.'
  };

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
    requestAnimationFrame(function() { el.classList.add('show'); });
    setTimeout(function() { dismissToast(el); }, TOAST_TTL_MS);
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove('show');
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
    if (!id) { showError('Pick a resource ID.'); return; }

    if (mode === 'delete') {
      var submitterName = fieldSubmitterName.value.trim();
      var reason = fieldReason.value.trim();
      if (!submitterName) { showError('Enter your name for the deletion request.'); return; }
      if (reason.length < 10) { showError('Reason must be at least 10 characters.'); return; }
      if (!fieldDeleteAttest.checked) { showError('You must confirm the deletion is intentional.'); return; }
      show('state-submitting');
      sendSubmit({
        api:           'submit-resource',
        sid:           session.sid,
        mode:          'delete',
        id:            id,
        submitterName: submitterName,
        reason:        reason
      });
      return;
    }

    var url = fieldUrl.value.trim();
    if (mode === 'new' && !url) { showError('Please provide the URL members should open.'); return; }
    if (url && !/^https:\/\//i.test(url)) { showError('URL must start with https://'); return; }
    if (!fieldAttest.checked) { showError('You must confirm the attestation.'); return; }

    var steps = parseInstructions();
    var instrErr = instructionsError(steps);
    if (instrErr) { showError(ERROR_MESSAGES[instrErr]); return; }

    var body = {
      api:          'submit-resource',
      sid:          session.sid,
      mode:         mode,
      id:           id,
      name:         fieldName.value.trim()        || undefined,
      author:       fieldAuthor.value.trim()      || undefined,
      description:  fieldDescription.value.trim() || undefined,
      url:          url                           || undefined,
      minTier:      fieldMinTier.value,
      version:      fieldVersion.value.trim()     || undefined,
      instructions: steps.length ? steps          : undefined,
      threadUrl:    fieldThread.value.trim()      || undefined,
      screenshot:   pendingScreenshot             || undefined
    };

    if (mode === 'update') {
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
          if (data.mode === 'delete')      modeLabel = 'Your deletion request was submitted.';
          else if (data.mode === 'update') modeLabel = 'Your update was submitted.';
          else                              modeLabel = 'Your resource was submitted.';
          titleEl.textContent = modeLabel;
          detailEl.textContent = 'PR #' + data.prNumber +
            ' - lmv will review within a day or two. ' +
            (data.mode === 'delete'
              ? 'Once merged, the resource is removed from the archive.'
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

    // Suggest an ID from the display name as the submitter types.
    fieldName.addEventListener('input', function() {
      if (currentMode() === 'new' && !idNew.dataset.userEdited) {
        idNew.value = slugify(fieldName.value);
      }
    });
    idNew.addEventListener('input', function() { idNew.dataset.userEdited = '1'; });

    // Fetch every resource in the archive (submission flow is open; lmv
    // reviews cross-author submissions via the PR body banner). Also
    // fetches the caller's submission-rate-limit status for the cancel
    // banner.
    jsonp(PROXY_URL + '?api=my-resources&session=' + encodeURIComponent(session.sid))
      .then(function(res) {
        if (res && res.error === 'expired') { show('state-unauthenticated'); return; }
        availableResources = (res && res.resources) || [];
        if (!availableResources.length) {
          // Degenerate case: empty resources section. Update / Delete have
          // nothing to pick. Falls through to the New mode workflow.
          modeUpdateLabel.classList.add('disabled');
          modeUpdateLabel.querySelector('input').disabled = true;
          modeDeleteLabel.classList.add('disabled');
          modeDeleteLabel.querySelector('input').disabled = true;
        } else {
          // Option text includes author so cross-author submitters see
          // whose resource they're picking.
          [idUpdate, idDelete].forEach(function(sel) {
            sel.innerHTML = '';
            var first = document.createElement('option');
            first.value = '';
            first.textContent = '-- select --';
            sel.appendChild(first);
            availableResources.forEach(function(r) {
              var opt = document.createElement('option');
              opt.value = r.id;
              opt.textContent = r.name + ' - by ' + (r.author || 'unknown') + '  (' + r.id + ')';
              sel.appendChild(opt);
            });
          });
        }
        if (res && res.status) {
          renderOpenSubmissions(res.status.openPrs || [], res.status.openLimit);
        }
        show('state-form');
        wireForm();
      })
      .catch(function() {
        // Still allow submission in new mode even if my-resources fails.
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

    idUpdate.addEventListener('change', function() {
      prefillFromSelectedUpdate();
      updateSubmitEnabled();
      updateVersionWarning();
    });

    if (fieldVersion) fieldVersion.addEventListener('input', updateVersionWarning);

    idDelete.addEventListener('change', updateSubmitEnabled);
    fieldSubmitterName.addEventListener('input', updateSubmitEnabled);
    fieldReason.addEventListener('input', updateSubmitEnabled);
    fieldDeleteAttest.addEventListener('change', updateSubmitEnabled);

    wireScreenshot();

    [idNew, fieldName, fieldDescription, fieldUrl, fieldAttest].forEach(function(el) {
      el.addEventListener('input', updateSubmitEnabled);
      el.addEventListener('change', updateSubmitEnabled);
    });

    form.addEventListener('submit', handleSubmit);
  }

  init();
})();

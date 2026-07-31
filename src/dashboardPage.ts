import { renderPage } from './htmlPage';

// The merchant-facing status/control page (closes the "no UI after
// onboarding" gap found in the functional audit). Static HTML shell +
// vanilla inline JS — no framework/bundler/new dependency, matching this
// app's minimal-deps philosophy everywhere else. Unlike the two onboarding
// pages (which render once, server-side, and are done), this page needs
// real interactivity — fetch calls, a dynamic rule editor, localStorage —
// so it's the one page in this app that genuinely needs client-side JS.
//
// Auth is entirely client-side: the merchant pastes the per-merchant admin
// key (shown once at HubSpot-connect time) into a form; it's held in
// localStorage from then on and attached as a Bearer token to every API
// call this script makes. No new server-side session/auth system — this is
// just a browser-side wrapper around the REST API that already exists
// (GET/PUT /merchants/:shop/deal-rules, GET /sync-status, and the three
// new endpoints in src/server.ts).
//
// This is also the first page in this app where server/merchant-controlled
// content (sync-log error text, HubSpot portal ids, merchant-typed deal
// rule values) is ever reflected into the DOM — every prior page had zero
// such content (confirmed in the audit). Every render function below uses
// createElement/textContent, never innerHTML with interpolated data, to
// keep that guarantee.
export function renderDashboardPage(): string {
  const body = `
<h1>Dashboard</h1>

<div id="key-form">
  <p class="muted">Enter the admin key you were shown when you connected HubSpot.</p>
  <div id="key-error"></div>
  <form id="key-entry-form">
    <label for="key-input">Admin key</label>
    <input type="password" id="key-input" autocomplete="off" />
    <button type="submit" class="btn">Continue</button>
  </form>
</div>

<div id="dashboard-content" hidden>
  <section id="status-section">
    <h2>Connection status</h2>
    <div id="status-body" class="table-scroll"></div>
  </section>

  <section id="backfill-section">
    <h2>Historical import</h2>
    <div class="warning">
      <p><strong>Already had Shopify orders syncing into HubSpot Deals before connecting Fielded</strong> — from
      HubSpot's own Shopify integration, or a different app?</p>
      <p>Import matches your Shopify orders to HubSpot deals by order number. If that older sync used a different
      naming format, running this can create <strong>duplicate deals</strong> for the same order — HubSpot doesn't
      block that on its own. If this sounds like your setup, get in touch first (see the link at the bottom of this
      page) before starting the import below, so we can check with you.</p>
    </div>
    <div id="backfill-body"></div>
    <button type="button" id="retry-backfill-btn" class="btn">Start historical import</button>
  </section>

  <section id="deal-rules-section">
    <h2>Deal routing rules</h2>
    <p class="muted">Route orders to a specific pipeline, stage, or owner based on their status. Rules are checked
    top to bottom — the first one that matches an order wins. An order that matches nothing below uses your
    default pipeline &amp; stage (shown under Connection status above).</p>
    <div id="deal-rules-options-banner"></div>
    <div id="deal-rules-error"></div>
    <div id="deal-rules-list"></div>
    <div id="deal-rules-empty" class="empty-state" hidden>
      <p class="muted" style="margin: 0 0 0.75rem;">No custom rules yet — every order uses your default pipeline
      &amp; stage. Add a rule to handle specific cases differently, e.g. routing refunded orders to a separate
      pipeline.</p>
    </div>
    <div class="rule-list-actions">
      <button type="button" id="add-rule-btn" class="btn-secondary">+ Add a rule</button>
      <button type="button" id="save-rules-btn" class="btn">Save rules</button>
      <span id="deal-rules-status" class="save-confirmation" aria-live="polite"></span>
    </div>
  </section>

  <section id="activity-section">
    <h2>Recent activity</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>When</th><th>Type</th><th>Shopify ID</th><th>HubSpot ID</th><th>Status</th></tr>
        </thead>
        <tbody id="activity-body"></tbody>
      </table>
    </div>
  </section>

  <section id="actions-section">
    <h2>Actions</h2>
    <div id="action-error"></div>
    <button type="button" id="retry-webhooks-btn" class="btn-secondary">Retry webhook registration</button>
    <button type="button" id="regenerate-key-btn" class="btn-secondary">Regenerate admin key</button>
    <div id="new-key-block"></div>
  </section>
</div>

<script>
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var shop = params.get('shop');

  var keyFormEl = document.getElementById('key-form');
  var dashboardEl = document.getElementById('dashboard-content');
  var keyErrorEl = document.getElementById('key-error');

  if (!shop) {
    keyFormEl.innerHTML = '';
    var missing = document.createElement('p');
    missing.className = 'error';
    missing.textContent = "This link is missing your store's address. Use the exact dashboard link you saved when you connected HubSpot.";
    keyFormEl.appendChild(missing);
    return;
  }

  var storageKey = 'dashboard:apiKey:' + shop;
  var state = { apiKey: localStorage.getItem(storageKey) };

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function showKeyForm(message) {
    dashboardEl.hidden = true;
    keyFormEl.hidden = false;
    keyErrorEl.textContent = message || '';
    keyErrorEl.className = message ? 'error' : '';
  }

  function showDashboard() {
    keyFormEl.hidden = true;
    dashboardEl.hidden = false;
  }

  // Single choke point every call goes through. Handles a key going bad
  // mid-session (not just on first load) by clearing storage and re-showing
  // the form from right here, so every caller gets that behavior for free.
  function authedFetch(path, options) {
    options = options || {};
    var headers = { Authorization: 'Bearer ' + state.apiKey };
    if (options.headers) {
      for (var k in options.headers) headers[k] = options.headers[k];
    }
    if (options.body) headers['Content-Type'] = 'application/json';
    var fetchOptions = { method: options.method, headers: headers, body: options.body };

    return fetch(path, fetchOptions).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem(storageKey);
        state.apiKey = null;
        showKeyForm('That key was rejected. Double check it, or reconnect HubSpot with ?regenerate_key=1 on the ' +
          'auth page to get a new one.');
        throw new Error('unauthorized');
      }
      if (res.status === 404) {
        return res.text().then(function (text) {
          throw new Error(text || 'No merchant found for this shop.');
        });
      }
      if (!res.ok) {
        return res.text().then(function (text) {
          throw new Error(text || ('Request failed with status ' + res.status));
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function renderStatus(data) {
    var el = document.getElementById('status-body');
    clearChildren(el);

    var billingLabel = 'Not set up';
    if (data.billingStatus === 'ACTIVE') {
      var trialEnds = data.billingTrialEndsAt ? new Date(data.billingTrialEndsAt) : null;
      billingLabel = (trialEnds && trialEnds > new Date())
        ? 'Active — free trial until ' + formatDate(data.billingTrialEndsAt)
        : 'Active';
    } else if (data.billingStatus) {
      billingLabel = data.billingStatus.charAt(0) + data.billingStatus.slice(1).toLowerCase();
    }

    var table = document.createElement('table');
    var rows = [
      ['Shop', data.shopDomain],
      ['Billing', billingLabel],
      ['HubSpot portal', data.hubspotPortalId || 'not connected'],
      ['Default pipeline', data.dealPipeline || '(not set — reconnect HubSpot to fix)'],
      ['Default stage', data.dealStage || '(not set — reconnect HubSpot to fix)']
    ];
    rows.forEach(function (pair) {
      var tr = document.createElement('tr');
      var th = document.createElement('th');
      th.textContent = pair[0];
      var td = document.createElement('td');
      td.textContent = pair[1];
      tr.appendChild(th);
      tr.appendChild(td);
      table.appendChild(tr);
    });
    el.appendChild(table);

    if (data.billingStatus !== 'ACTIVE') {
      var billingWarn = document.createElement('div');
      billingWarn.className = 'warning';
      var billingStrong = document.createElement('strong');
      billingStrong.textContent = 'Billing needs attention.';
      billingWarn.appendChild(billingStrong);
      var billingText = document.createElement('p');
      billingText.style.margin = '0.4rem 0 0';
      billingText.textContent = 'Syncing is paused until billing is approved' +
        (data.billingStatus ? ' (current status: ' + data.billingStatus.toLowerCase() + ')' : '') + '.';
      billingWarn.appendChild(billingText);
      var billingLink = document.createElement('a');
      billingLink.href = '/auth/shopify/billing?shop=' + encodeURIComponent(shop);
      billingLink.textContent = 'Set up billing →';
      billingLink.style.display = 'inline-block';
      billingLink.style.marginTop = '0.5rem';
      billingWarn.appendChild(billingLink);
      el.appendChild(billingWarn);
    }

    if (data.hubspotConnectionBrokenAt) {
      var warn = document.createElement('div');
      warn.className = 'warning';
      var strong = document.createElement('strong');
      strong.textContent = 'HubSpot connection needs attention.';
      warn.appendChild(strong);
      var warnText = document.createElement('p');
      warnText.style.margin = '0.4rem 0 0';
      warnText.textContent = 'It looks like access was revoked around ' + formatDate(data.hubspotConnectionBrokenAt) +
        '. Reconnect at /auth/hubspot?shop=' + shop + ' to fix this.';
      warn.appendChild(warnText);
      el.appendChild(warn);
    }

    var webhooksLabel = document.createElement('p');
    webhooksLabel.className = 'muted';
    webhooksLabel.style.marginBottom = '0.4rem';
    webhooksLabel.textContent = 'Webhook subscriptions:';
    el.appendChild(webhooksLabel);

    if (data.webhooksError) {
      var werr = document.createElement('p');
      werr.className = 'error';
      werr.textContent = 'Could not check webhook status: ' + data.webhooksError;
      el.appendChild(werr);
    } else if (data.webhooks) {
      var badgeWrap = document.createElement('div');
      data.webhooks.forEach(function (w) {
        var badge = document.createElement('span');
        badge.className = 'badge ' + (w.registered ? 'badge-ok' : 'badge-bad');
        badge.style.marginRight = '0.4rem';
        badge.style.marginBottom = '0.3rem';
        badge.style.display = 'inline-block';
        badge.textContent = w.topic + ': ' + (w.registered ? 'registered' : 'missing');
        badgeWrap.appendChild(badge);
      });
      el.appendChild(badgeWrap);
    }
  }

  function updateBackfillButton(backfillStatus) {
    var btn = document.getElementById('retry-backfill-btn');
    if (!btn) return;
    clearChildren(btn);
    if (!backfillStatus) {
      btn.disabled = false;
      btn.appendChild(document.createTextNode('Start historical import'));
    } else if (backfillStatus.status === 'running') {
      btn.disabled = true;
      var runningSpinner = document.createElement('span');
      runningSpinner.className = 'spinner';
      btn.appendChild(runningSpinner);
      btn.appendChild(document.createTextNode('Import running...'));
    } else {
      btn.disabled = false;
      btn.appendChild(document.createTextNode('Run import again'));
    }
  }

  // Immediate feedback the instant the button is clicked, before the
  // request even resolves — updateBackfillButton() above only fires once
  // loadDashboard() re-fetches real status afterward, which would otherwise
  // leave the button looking unresponsive for that round trip.
  function setBackfillButtonStarting() {
    var btn = document.getElementById('retry-backfill-btn');
    if (!btn) return;
    btn.disabled = true;
    clearChildren(btn);
    var spinner = document.createElement('span');
    spinner.className = 'spinner';
    btn.appendChild(spinner);
    btn.appendChild(document.createTextNode('Starting...'));
  }

  function renderBackfillStatus(backfillStatus) {
    var el = document.getElementById('backfill-body');
    clearChildren(el);
    updateBackfillButton(backfillStatus);

    if (!backfillStatus) {
      var none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No import has run yet.';
      el.appendChild(none);
      return;
    }

    var badge = document.createElement('span');
    var statusText = { running: 'in progress', complete: 'complete', failed: 'failed' }[backfillStatus.status] ||
      backfillStatus.status;
    badge.className = 'badge ' + (backfillStatus.status === 'complete' ? 'badge-ok' :
      (backfillStatus.status === 'failed' ? 'badge-bad' : ''));
    if (backfillStatus.status === 'running') {
      badge.style.background = '#fff4e5';
      badge.style.color = '#92610a';
    }
    badge.textContent = statusText;
    el.appendChild(badge);

    if (backfillStatus.status === 'running') {
      // Louder than the plain .muted text this used to be (13a/16-era
      // precedent: important info a merchant shouldn't skim past gets a
      // .banner-info box, not gray footnote text) — plus a one-click way to
      // actually check progress, since this page has no auto-polling and a
      // merchant can't be relied on to remember "reload the page" on their own.
      var runningBanner = document.createElement('div');
      runningBanner.className = 'banner-info';
      runningBanner.style.marginTop = '0.6rem';
      var runningText = document.createElement('p');
      runningText.style.margin = '0 0 0.6rem';
      runningText.textContent = 'Started ' + formatDate(backfillStatus.startedAt) +
        '. Running in the background — this page won\\'t update on its own.';
      runningBanner.appendChild(runningText);
      var refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'btn-secondary';
      refreshBtn.textContent = 'Refresh status';
      refreshBtn.addEventListener('click', function () {
        loadDashboard();
      });
      runningBanner.appendChild(refreshBtn);
      el.appendChild(runningBanner);
    } else {
      var detail = document.createElement('p');
      detail.className = 'muted';
      detail.style.marginTop = '0.4rem';
      if (backfillStatus.status === 'complete') {
        detail.textContent = 'Imported ' + backfillStatus.customerCount + ' customer(s) and ' +
          backfillStatus.orderCount + ' order(s), finished ' + formatDate(backfillStatus.completedAt) + '.';
      } else if (backfillStatus.status === 'failed') {
        detail.textContent = 'Failed at ' + formatDate(backfillStatus.completedAt) + ': ' + backfillStatus.error;
      }
      el.appendChild(detail);
    }
  }

  function renderActivity(entries) {
    var body = document.getElementById('activity-body');
    clearChildren(body);
    if (!entries.length) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'muted';
      td.textContent = 'Nothing synced yet.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    entries.forEach(function (entry) {
      var row = document.createElement('tr');
      [formatDate(entry.createdAt), entry.entityType, entry.shopifyId, entry.hubspotId || '\\u2014'].forEach(function (val) {
        var td = document.createElement('td');
        td.textContent = val;
        row.appendChild(td);
      });
      var statusTd = document.createElement('td');
      var badge = document.createElement('span');
      var neutralStatus = entry.status === 'skipped' || entry.status === 'deleted';
      var badgeClass = entry.status === 'success' ? 'badge-ok' : (neutralStatus ? 'badge-neutral' : 'badge-bad');
      badge.className = 'badge ' + badgeClass;
      badge.textContent = entry.status;
      statusTd.appendChild(badge);
      if (entry.errorMessage) {
        var errP = document.createElement('div');
        errP.className = 'muted';
        errP.style.marginTop = '0.2rem';
        errP.textContent = entry.errorMessage;
        statusTd.appendChild(errP);
      }
      row.appendChild(statusTd);
      body.appendChild(row);
    });
  }

  // ---- Deal rules editor ----

  var rulesDraft = [];
  var dealRulesErrorEl = document.getElementById('deal-rules-error');
  var dealRulesStatusEl = document.getElementById('deal-rules-status');
  var dealRulesStatusTimer = null;

  // Populated from GET /merchants/:shop/hubspot-options (loadDashboard,
  // below). null means "couldn't load" (missing scope, HubSpot down, etc.)
  // — the pipeline/stage/owner fields fall back to plain text entry in that
  // case rather than blocking the whole editor. Financial/fulfillment
  // status don't depend on this: they're a fixed, known Shopify vocabulary.
  var hubspotOptions = { pipelines: null, owners: null };

  var FINANCIAL_STATUS_OPTIONS = [
    { value: 'pending', label: 'Pending' },
    { value: 'authorized', label: 'Authorized' },
    { value: 'partially_paid', label: 'Partially paid' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_refunded', label: 'Partially refunded' },
    { value: 'refunded', label: 'Refunded' },
    { value: 'voided', label: 'Voided' }
  ];
  var FULFILLMENT_STATUS_OPTIONS = [
    { value: 'unfulfilled', label: 'Unfulfilled' },
    { value: 'partial', label: 'Partially fulfilled' },
    { value: 'fulfilled', label: 'Fulfilled' },
    { value: 'restocked', label: 'Restocked' }
  ];
  var CANCELLED_OPTIONS = [
    { value: 'true', label: 'Cancelled orders only' },
    { value: 'false', label: 'Not cancelled' }
  ];

  function blankRule() {
    return { financial_status: '', fulfillment_status: '', cancelled: '', pipeline: '', stage: '', owner: '' };
  }

  function pipelineById(id) {
    return (hubspotOptions.pipelines || []).filter(function (p) { return p.id === id; })[0];
  }

  // One labeled field: a select when "options" is a real (non-null) list,
  // otherwise a plain text input carrying the raw value through unchanged —
  // this is what lets the editor still work (just less conveniently) before
  // a merchant has reconnected HubSpot for the scope live options need.
  function selectOrTextField(labelText, value, options, onChange, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'rule-field';
    var label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);

    if (!options) {
      var input = document.createElement('input');
      input.type = 'text';
      input.style.marginBottom = '0';
      input.placeholder = opts.placeholder || '';
      input.value = value || '';
      input.addEventListener('input', function () { onChange(input.value); });
      wrap.appendChild(input);
      return wrap;
    }

    var select = document.createElement('select');
    select.style.marginBottom = '0';
    var placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = opts.anyLabel || 'Any';
    select.appendChild(placeholderOpt);

    var found = false;
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === value) { o.selected = true; found = true; }
      select.appendChild(o);
    });
    // A value that exists in saved data but not in the current options list
    // (e.g. an archived HubSpot pipeline, or an id typed by hand before this
    // page had dropdowns) — keep it visible and selected rather than
    // silently discarding it the moment this renders.
    if (value && !found) {
      var unknownOpt = document.createElement('option');
      unknownOpt.value = value;
      unknownOpt.textContent = value + ' (not in current list)';
      unknownOpt.selected = true;
      select.appendChild(unknownOpt);
    }

    select.addEventListener('change', function () { onChange(select.value); });
    wrap.appendChild(select);
    return wrap;
  }

  function ruleRow(rowLabel, fields) {
    var row = document.createElement('div');
    row.className = 'rule-row';
    var label = document.createElement('span');
    label.className = 'rule-row-label';
    label.textContent = rowLabel;
    row.appendChild(label);
    var fieldsWrap = document.createElement('div');
    fieldsWrap.className = 'rule-fields';
    fields.forEach(function (f) { fieldsWrap.appendChild(f); });
    row.appendChild(fieldsWrap);
    return row;
  }

  function renderDealRules() {
    var list = document.getElementById('deal-rules-list');
    var empty = document.getElementById('deal-rules-empty');
    clearChildren(list);
    empty.hidden = rulesDraft.length > 0;

    rulesDraft.forEach(function (rule, index) {
      var card = document.createElement('div');
      card.className = 'rule-card';

      var header = document.createElement('div');
      header.className = 'rule-card-header';
      var numberBadge = document.createElement('span');
      numberBadge.className = 'rule-number-badge';
      numberBadge.textContent = String(index + 1);
      header.appendChild(numberBadge);

      var actions = document.createElement('div');
      actions.className = 'rule-card-actions';
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'icon-btn';
      upBtn.title = 'Move rule up';
      upBtn.setAttribute('aria-label', 'Move rule up');
      upBtn.textContent = '\\u2191';
      upBtn.disabled = index === 0;
      upBtn.addEventListener('click', function () {
        var tmp = rulesDraft[index - 1];
        rulesDraft[index - 1] = rulesDraft[index];
        rulesDraft[index] = tmp;
        renderDealRules();
      });
      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'icon-btn';
      downBtn.title = 'Move rule down';
      downBtn.setAttribute('aria-label', 'Move rule down');
      downBtn.textContent = '\\u2193';
      downBtn.disabled = index === rulesDraft.length - 1;
      downBtn.addEventListener('click', function () {
        var tmp = rulesDraft[index + 1];
        rulesDraft[index + 1] = rulesDraft[index];
        rulesDraft[index] = tmp;
        renderDealRules();
      });
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-btn icon-btn-danger';
      removeBtn.title = 'Remove rule';
      removeBtn.setAttribute('aria-label', 'Remove rule');
      removeBtn.textContent = '\\u2715';
      removeBtn.addEventListener('click', function () {
        rulesDraft.splice(index, 1);
        renderDealRules();
      });
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(removeBtn);
      header.appendChild(actions);
      card.appendChild(header);

      card.appendChild(ruleRow('If order has', [
        selectOrTextField('Payment status', rule.financial_status, FINANCIAL_STATUS_OPTIONS, function (v) { rule.financial_status = v; }),
        selectOrTextField('Fulfillment status', rule.fulfillment_status, FULFILLMENT_STATUS_OPTIONS, function (v) { rule.fulfillment_status = v; }),
        selectOrTextField('Cancelled', rule.cancelled, CANCELLED_OPTIONS, function (v) { rule.cancelled = v; })
      ]));

      var pipelineOptions = hubspotOptions.pipelines
        ? hubspotOptions.pipelines.map(function (p) { return { value: p.id, label: p.label }; })
        : null;
      var currentPipeline = hubspotOptions.pipelines ? pipelineById(rule.pipeline) : null;
      var stageOptions = hubspotOptions.pipelines
        ? (currentPipeline ? currentPipeline.stages.map(function (s) { return { value: s.id, label: s.label }; } ) : [])
        : null;
      var ownerOptions = hubspotOptions.owners
        ? hubspotOptions.owners.map(function (o) { return { value: o.id, label: o.label }; })
        : null;

      card.appendChild(ruleRow('Then route to', [
        selectOrTextField('Pipeline', rule.pipeline, pipelineOptions, function (v) {
          rule.pipeline = v;
          // A pipeline's stages are specific to it — a stage id that made
          // sense under the old pipeline almost never exists under the new
          // one, so don't carry it forward silently.
          if (hubspotOptions.pipelines) rule.stage = '';
          renderDealRules();
        }, { placeholder: 'HubSpot pipeline id', anyLabel: 'Choose a pipeline\\u2026' }),
        selectOrTextField('Stage', rule.stage, stageOptions, function (v) { rule.stage = v; },
          { placeholder: 'HubSpot stage id', anyLabel: currentPipeline ? 'Choose a stage\\u2026' : 'Choose a pipeline first' }),
        selectOrTextField('Owner (optional)', rule.owner, ownerOptions, function (v) { rule.owner = v; },
          { placeholder: 'HubSpot owner id', anyLabel: 'Unassigned' })
      ]));

      list.appendChild(card);
    });
  }

  function loadHubSpotOptions() {
    return authedFetch('/merchants/' + shop + '/hubspot-options').then(function (data) {
      hubspotOptions.pipelines = data.pipelines;
      hubspotOptions.owners = data.owners;

      var banner = document.getElementById('deal-rules-options-banner');
      clearChildren(banner);
      if (data.pipelinesError || data.ownersError) {
        var box = document.createElement('div');
        box.className = 'banner-info';
        var strong = document.createElement('strong');
        strong.textContent = "Pipeline/stage/owner dropdowns aren't available right now.";
        box.appendChild(strong);
        var detail = document.createElement('p');
        detail.style.margin = '0.4rem 0 0';
        detail.textContent = (data.pipelinesError || data.ownersError) +
          ' You can still enter HubSpot\\'s internal ids directly below, or reconnect HubSpot to enable the dropdowns.';
        box.appendChild(detail);
        var link = document.createElement('a');
        link.href = '/auth/hubspot?shop=' + encodeURIComponent(shop);
        link.textContent = 'Reconnect HubSpot \\u2192';
        link.style.display = 'inline-block';
        link.style.marginTop = '0.5rem';
        box.appendChild(link);
        banner.appendChild(box);
      }
    }).catch(function () {
      // Non-fatal: the rest of the dashboard still works, just with plain
      // text entry for these three fields (handled by selectOrTextField's
      // null-options fallback, since hubspotOptions stays at its initial
      // {pipelines: null, owners: null}).
    });
  }

  document.getElementById('add-rule-btn').addEventListener('click', function () {
    rulesDraft.push(blankRule());
    renderDealRules();
  });

  function showDealRulesSaved() {
    if (dealRulesStatusTimer) clearTimeout(dealRulesStatusTimer);
    dealRulesStatusEl.textContent = '\\u2713 Saved';
    dealRulesStatusTimer = setTimeout(function () { dealRulesStatusEl.textContent = ''; }, 3000);
  }

  document.getElementById('save-rules-btn').addEventListener('click', function () {
    clearChildren(dealRulesErrorEl);
    dealRulesStatusEl.textContent = '';

    for (var i = 0; i < rulesDraft.length; i++) {
      if (!rulesDraft[i].pipeline || !rulesDraft[i].stage) {
        var p = document.createElement('p');
        p.className = 'error';
        p.textContent = 'Rule ' + (i + 1) + ': pipeline and stage are both required.';
        dealRulesErrorEl.appendChild(p);
        return;
      }
    }

    var payload = rulesDraft.map(function (rule) {
      var when = {};
      if (rule.financial_status) when.financial_status = rule.financial_status;
      if (rule.fulfillment_status) when.fulfillment_status = rule.fulfillment_status;
      if (rule.cancelled === 'true') when.cancelled = true;
      if (rule.cancelled === 'false') when.cancelled = false;
      var out = { when: when, pipeline: rule.pipeline, stage: rule.stage };
      if (rule.owner) out.owner = rule.owner;
      return out;
    });

    authedFetch('/merchants/' + shop + '/deal-rules', { method: 'PUT', body: JSON.stringify({ rules: payload }) })
      .then(function (data) {
        rulesDraft = (data.rules || []).map(function (r) {
          return {
            financial_status: (r.when && r.when.financial_status) || '',
            fulfillment_status: (r.when && r.when.fulfillment_status) || '',
            cancelled: r.when && typeof r.when.cancelled === 'boolean' ? String(r.when.cancelled) : '',
            pipeline: r.pipeline || '',
            stage: r.stage || '',
            owner: r.owner || ''
          };
        });
        renderDealRules();
        showDealRulesSaved();
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        var p = document.createElement('p');
        p.className = 'error';
        p.textContent = err.message;
        dealRulesErrorEl.appendChild(p);
      });
  });

  // ---- Actions ----

  var actionErrorEl = document.getElementById('action-error');

  function showActionError(message) {
    clearChildren(actionErrorEl);
    var p = document.createElement('p');
    p.className = 'error';
    p.textContent = message;
    actionErrorEl.appendChild(p);
  }

  document.getElementById('retry-webhooks-btn').addEventListener('click', function () {
    clearChildren(actionErrorEl);
    authedFetch('/merchants/' + shop + '/retry-webhooks', { method: 'POST' })
      .then(function (data) {
        if (data && data.ok) {
          loadDashboard();
        } else {
          showActionError((data && data.error) || 'Retry failed.');
        }
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        showActionError(err.message);
      });
  });

  document.getElementById('retry-backfill-btn').addEventListener('click', function () {
    clearChildren(actionErrorEl);
    setBackfillButtonStarting();
    authedFetch('/merchants/' + shop + '/retry-backfill', { method: 'POST' })
      .then(function (data) {
        if (!(data && data.ok)) {
          showActionError((data && data.error) || 'Retry failed.');
        }
        // Always re-fetches real status, success or not — restores the
        // button to an accurate label/enabled-state either way rather than
        // leaving it stuck on the "Starting..." spinner from above.
        loadDashboard();
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        showActionError(err.message);
        loadDashboard();
      });
  });

  document.getElementById('regenerate-key-btn').addEventListener('click', function () {
    if (!confirm('This invalidates your current admin key immediately. Continue?')) return;
    clearChildren(actionErrorEl);
    authedFetch('/merchants/' + shop + '/admin-key/regenerate', { method: 'POST' })
      .then(function (data) {
        // The key that just authenticated this call is now dead server-side
        // — swap to the new one immediately, before anything else fetches.
        state.apiKey = data.adminApiKey;
        localStorage.setItem(storageKey, data.adminApiKey);

        var block = document.getElementById('new-key-block');
        clearChildren(block);
        var warn = document.createElement('div');
        warn.className = 'warning';
        var label = document.createElement('p');
        var labelStrong = document.createElement('strong');
        labelStrong.textContent = 'Your new key (won\\'t be shown again):';
        label.appendChild(labelStrong);
        warn.appendChild(label);
        var pre = document.createElement('pre');
        pre.textContent = data.adminApiKey;
        warn.appendChild(pre);
        block.appendChild(warn);
      })
      .catch(function (err) {
        if (err.message === 'unauthorized') return;
        showActionError(err.message);
      });
  });

  // ---- Boot ----

  function loadDashboard() {
    return Promise.all([
      authedFetch('/merchants/' + shop + '/status'),
      authedFetch('/merchants/' + shop + '/deal-rules'),
      authedFetch('/sync-status?shop=' + encodeURIComponent(shop) + '&limit=25'),
      loadHubSpotOptions()
    ]).then(function (results) {
      showDashboard();
      renderStatus(results[0]);
      renderBackfillStatus(results[0].backfillStatus);
      rulesDraft = (results[1].rules || []).map(function (r) {
        return {
          financial_status: (r.when && r.when.financial_status) || '',
          fulfillment_status: (r.when && r.when.fulfillment_status) || '',
          cancelled: r.when && typeof r.when.cancelled === 'boolean' ? String(r.when.cancelled) : '',
          pipeline: r.pipeline || '',
          stage: r.stage || '',
          owner: r.owner || ''
        };
      });
      renderDealRules();
      renderActivity(results[2].entries || []);
    }).catch(function (err) {
      if (err.message === 'unauthorized') return;
      showActionError('Failed to load dashboard: ' + err.message);
    });
  }

  document.getElementById('key-entry-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = document.getElementById('key-input').value.trim();
    if (!value) return;
    state.apiKey = value;
    localStorage.setItem(storageKey, value);
    loadDashboard();
  });

  if (state.apiKey) {
    loadDashboard();
  } else {
    showKeyForm();
  }
})();
</script>
`;

  return renderPage('Dashboard', body, { wide: true });
}

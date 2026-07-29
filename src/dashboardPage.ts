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
    <div id="status-body"></div>
  </section>

  <section id="deal-rules-section">
    <h2>Deal routing rules</h2>
    <p class="muted">First matching rule wins. Leave a field blank to match any value. Pipeline/stage/owner are
    HubSpot's own internal identifiers, not display names — the same values the raw API already expects.</p>
    <div id="deal-rules-error"></div>
    <table>
      <thead>
        <tr>
          <th>Financial status</th>
          <th>Fulfillment status</th>
          <th>Cancelled</th>
          <th>Pipeline</th>
          <th>Stage</th>
          <th>Owner</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="deal-rules-body"></tbody>
    </table>
    <button type="button" id="add-rule-btn" class="btn-secondary">+ Add rule</button>
    <button type="button" id="save-rules-btn" class="btn">Save rules</button>
  </section>

  <section id="activity-section">
    <h2>Recent activity</h2>
    <table>
      <thead>
        <tr><th>When</th><th>Type</th><th>Shopify ID</th><th>HubSpot ID</th><th>Status</th></tr>
      </thead>
      <tbody id="activity-body"></tbody>
    </table>
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
    missing.textContent = 'Missing ?shop= in the URL. Use the dashboard link from your HubSpot-connected page.';
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

    var table = document.createElement('table');
    var rows = [
      ['Shop', data.shopDomain],
      ['HubSpot portal', data.hubspotPortalId || 'not connected'],
      ['Default pipeline', data.dealPipeline || '(portal default)'],
      ['Default stage', data.dealStage || '(portal default)']
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
      badge.className = 'badge ' + (entry.status === 'success' ? 'badge-ok' : 'badge-bad');
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

  function blankRule() {
    return { financial_status: '', fulfillment_status: '', cancelled: '', pipeline: '', stage: '', owner: '' };
  }

  function textCell(value, onInput) {
    var td = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'text';
    input.style.marginBottom = '0';
    input.value = value || '';
    input.addEventListener('input', function () {
      onInput(input.value);
    });
    td.appendChild(input);
    return td;
  }

  function renderDealRules() {
    var body = document.getElementById('deal-rules-body');
    clearChildren(body);

    rulesDraft.forEach(function (rule, index) {
      var row = document.createElement('tr');

      row.appendChild(textCell(rule.financial_status, function (v) { rule.financial_status = v; }));
      row.appendChild(textCell(rule.fulfillment_status, function (v) { rule.fulfillment_status = v; }));

      var cancelledTd = document.createElement('td');
      var select = document.createElement('select');
      [['', 'any'], ['true', 'true'], ['false', 'false']].forEach(function (opt) {
        var option = document.createElement('option');
        option.value = opt[0];
        option.textContent = opt[1];
        if (rule.cancelled === opt[0]) option.selected = true;
        select.appendChild(option);
      });
      select.addEventListener('change', function () { rule.cancelled = select.value; });
      cancelledTd.appendChild(select);
      row.appendChild(cancelledTd);

      row.appendChild(textCell(rule.pipeline, function (v) { rule.pipeline = v; }));
      row.appendChild(textCell(rule.stage, function (v) { rule.stage = v; }));
      row.appendChild(textCell(rule.owner, function (v) { rule.owner = v; }));

      var actionsTd = document.createElement('td');
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'btn-secondary';
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
      downBtn.className = 'btn-secondary';
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
      removeBtn.className = 'btn-secondary';
      removeBtn.textContent = '\\u2715';
      removeBtn.addEventListener('click', function () {
        rulesDraft.splice(index, 1);
        renderDealRules();
      });
      actionsTd.appendChild(upBtn);
      actionsTd.appendChild(downBtn);
      actionsTd.appendChild(removeBtn);
      row.appendChild(actionsTd);

      body.appendChild(row);
    });
  }

  document.getElementById('add-rule-btn').addEventListener('click', function () {
    rulesDraft.push(blankRule());
    renderDealRules();
  });

  document.getElementById('save-rules-btn').addEventListener('click', function () {
    clearChildren(dealRulesErrorEl);
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
      authedFetch('/sync-status?shop=' + encodeURIComponent(shop) + '&limit=25')
    ]).then(function (results) {
      showDashboard();
      renderStatus(results[0]);
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

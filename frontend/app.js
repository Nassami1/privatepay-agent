/*
 * PrivatePay Agent — dashboard renderer.
 *
 * Reads `data/dashboard.json`, written by `npm run demo:success` and
 * `npm run demo:blocked`, and polls it so the page updates while the demo runs
 * in a terminal. No framework, no build step, no network calls.
 */

const state = {
  data: null,
  generatedAt: null,
  filter: 'all',
};

const $ = (selector) => document.querySelector(selector);

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function pretty(value) {
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function shortHash(value, head = 8, tail = 6) {
  if (!value) return '—';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function formatUtc(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${formatted} UTC`;
}

function relative(iso) {
  if (!iso) return '—';
  const delta = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (delta < 45) return 'just now';
  if (delta < 3600) return `${Math.round(delta / 60)} min ago`;
  if (delta < 86_400) return `${Math.round(delta / 3600)} h ago`;
  return formatUtc(iso);
}

function txLink(hash) {
  return `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
}

function accountLink(accountId) {
  return `https://testnet.nearblocks.io/address/${encodeURIComponent(accountId)}`;
}

/* ------------------------------------------------------------------ load */

async function load(force = false) {
  try {
    const response = await fetch(`data/dashboard.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (force || data.generatedAt !== state.generatedAt) {
      state.data = data;
      state.generatedAt = data.generatedAt;
      render();
    }
    setWatch(true);
  } catch {
    setWatch(false);
    if (state.data === null) renderEmpty();
  }
}

function setWatch(ok) {
  const watch = $('#watch');
  if (!watch) return;
  watch.dataset.off = ok ? 'false' : 'true';
  watch.textContent = ok ? 'watching · 5s' : 'waiting for dashboard.json';
}

/* ---------------------------------------------------------------- render */

function render() {
  if (state.data === null) {
    renderEmpty();
    return;
  }
  renderMasthead();
  renderChain();
  renderLedger();
  renderPolicy();
  renderEvidence();
  renderChainCard();
}

function latestRun() {
  return state.data?.runs?.[0] ?? null;
}

function renderEmpty() {
  $('#empty').hidden = false;
  $('#ledger-list').innerHTML = '';
  $('#chain').innerHTML = [
    ['Ingest', 'raw invoice stays in-process'],
    ['Redact', 'identifiers removed before inference'],
    ['Confidential TEE', 'attestation evidence'],
    ['Policy', 'cap + whitelist enforced on testnet'],
    ['Settle', 'constrained settlement'],
  ]
    .map(
      ([title, detail], index) => `
        <div class="chain__step" data-state="idle">
          <span class="chain__num">0${index + 1}</span>
          <span class="chain__title">${esc(title)}</span>
          <span class="chain__detail">${esc(detail)}</span>
          <span class="chain__dot" aria-hidden="true"></span>
        </div>`,
    )
    .join('');
  $('#policy-card').innerHTML =
    '<div class="card__head"><h3>Policy instrument</h3><span class="card__src">awaiting data</span></div>' +
    '<p class="cap"><span class="cap__num">—</span><span class="cap__unit">USDC / day</span></p>' +
    '<p class="fine">Run <code>npm run demo:success</code> to write the first evidence file.</p>';
  $('#tee-card').innerHTML =
    '<div class="card__head"><h3>TEE evidence</h3><span class="stamp stamp--guard stamp--dark">No runs</span></div>' +
    '<p class="fine">Attestation evidence appears after a demo run.</p>';
  $('#chain-card').innerHTML =
    '<div class="card__head"><h3>Chain record</h3></div>' +
    '<p class="log-empty">No policy log yet.</p>';
}

function renderMasthead() {
  const run = latestRun();
  $('#file-id').textContent = run ? `PPA-${run.runId.slice(0, 8).toUpperCase()}` : 'PPA-00000000';

  const contract = state.data.contractId;
  const contractEl = $('#meta-contract');
  if (contract) {
    contractEl.innerHTML = `<a href="${accountLink(contract)}" target="_blank" rel="noreferrer">${esc(contract)}</a>`;
  } else {
    contractEl.textContent = 'local simulation';
  }

  $('#meta-network').textContent = state.data.network ?? 'testnet';
  const time = $('#meta-time');
  time.textContent = relative(state.data.generatedAt);
  time.title = formatUtc(state.data.generatedAt);

  const stamp = $('#status-stamp');
  const attempts = (state.data.runs ?? []).flatMap((entry) => entry.attempts ?? []);
  const settlement = latestSettlement();

  const settlementEl = $('#meta-settlement');
  if (settlementEl) {
    settlementEl.textContent = settlement
      ? settlement.mode === 'live'
        ? 'live quote'
        : 'simulated'
      : 'not attempted';
  }

  if (attempts.length === 0 || run === null) {
    stamp.className = 'stamp stamp--guard';
    stamp.textContent = 'Awaiting run';
  } else if (run.tee?.mode === 'simulated') {
    stamp.className = 'stamp stamp--warn';
    stamp.textContent = 'Simulated TEE';
  } else {
    stamp.className = 'stamp stamp--ok';
    stamp.textContent = 'TEE attested';
  }
}

function latestSettlement() {
  for (const run of state.data?.runs ?? []) {
    for (const attempt of run.attempts ?? []) {
      if (attempt.settlement) return attempt.settlement;
    }
  }
  return null;
}

function renderChain() {
  const run = latestRun();
  if (!run) return;
  const fields = run.tee?.redactedFields ?? [];
  const teeReal = run.tee?.mode === 'real';
  const policyLive = run.policy?.mode === 'testnet';
  const settlement = latestSettlement();
  const settlementLive = settlement?.mode === 'live';

  const steps = [
    {
      title: 'Ingest',
      detail: `${run.attempts.length} invoice${run.attempts.length === 1 ? '' : 's'} held in-process`,
      state: 'ok',
    },
    {
      title: 'Redact',
      detail: fields.length ? `${fields.length} field classes removed` : 'no identifiers found',
      state: fields.length ? 'ok' : 'warn',
    },
    {
      title: 'Confidential TEE',
      detail: teeReal ? `real · ${run.tee.model}` : 'simulated — no TEE call',
      state: teeReal ? 'ok' : 'warn',
    },
    {
      title: 'Policy',
      detail: policyLive ? `on-chain cap ${run.policy.after?.capUsdc ?? '—'} USDC` : 'local simulation',
      state: policyLive ? 'ok' : 'warn',
    },
    {
      title: 'Settle',
      detail: settlement
        ? `${settlementLive ? 'live quote' : 'simulated'} · ${settlement.quoted ? '1-Click' : 'no Intents call'}`
        : 'nothing settled',
      state: settlement ? (settlementLive ? 'ok' : 'warn') : 'idle',
    },
  ];

  $('#chain').innerHTML = steps
    .map(
      (step, index) => `
      <div class="chain__step" data-state="${step.state}">
        <span class="chain__num">0${index + 1}</span>
        <span class="chain__title">${esc(step.title)}</span>
        <span class="chain__detail">${esc(step.detail)}</span>
        <span class="chain__dot" aria-hidden="true"></span>
      </div>`,
    )
    .join('');
}

function flattenAttempts() {
  const rows = [];
  for (const run of state.data.runs ?? []) {
    for (const attempt of run.attempts ?? []) {
      rows.push({ run, attempt, kind: attempt.result === 'SUCCESS' ? 'ok' : 'no' });
    }
  }
  return rows;
}

function statusText(attempt) {
  if (attempt.result === 'SUCCESS') return 'Authorised';
  if (attempt.result === 'BLOCKED_OVER_LIMIT') return 'Refused · over limit';
  return 'Refused · not whitelisted';
}

function renderEntry({ run, attempt, kind }, index) {
  const ok = kind === 'ok';
  const settlement = attempt.settlement;
  const chain = attempt.onChainTx
    ? `<a href="${txLink(attempt.onChainTx)}" target="_blank" rel="noreferrer">${esc(shortHash(attempt.onChainTx))}</a>`
    : '—';
  const digest = attempt.attestationDigest
    ? `<span class="mono">sha256:${esc(shortHash(attempt.attestationDigest, 10, 8))}</span>
       <button class="btn btn--dark" data-copy="sha256:${esc(attempt.attestationDigest)}">copy</button>`
    : 'no digest (simulated)';

  const settlementCell = settlement
    ? `<span class="result-line ${settlement.mode === 'live' ? 'ok' : 'warn'}"><span class="dot"></span>
         ${settlement.mode.toUpperCase()}${settlement.quoted ? ' · 1-Click quote' : ''}</span>
       <div class="fine">${esc(settlement.txId)}${settlement.amountOut ? ` · out ${esc(settlement.amountOut)}` : ''}</div>
       <div class="fine">${esc(settlement.reason ?? '')}</div>`
    : '<span class="no">not attempted — refused before settlement</span>';

  const tags = (attempt.riskFlags ?? []).length
    ? `<div class="tags">${attempt.riskFlags
        .map((flag) => `<span class="tag tag--risk">${esc(flag.replace(/_/g, ' '))}</span>`)
        .join('')}</div>`
    : '';

  const redacted = (attempt.redactedFields ?? []).length
    ? `<div class="chips">${attempt.redactedFields
        .map((field) => `<span class="chip chip--redacted">${esc(field)}</span>`)
        .join('')}</div>`
    : '<span class="fine">none</span>';

  const model = attempt.teeModel ?? run.tee?.model ?? '—';
  const mode = attempt.attestationMode === 'real' ? 'REAL TEE' : 'SIMULATED';
  const runNote = `${run.demo} run · ${formatUtc(run.startedAt)}`;

  return `
    <article class="entry" data-kind="${kind}" data-result="${esc(attempt.result)}" style="--i:${index}">
      <div class="entry__index">${String(index + 1).padStart(2, '0')}</div>
      <div class="entry__main">
        <div class="entry__top">
          <span class="entry__ref">${esc(attempt.invoiceRef)}</span>
          <span class="stamp ${ok ? 'stamp--ok' : 'stamp--no'}">${esc(ok ? 'Authorised' : 'Refused')}</span>
        </div>
        <p class="entry__amount ${ok ? '' : 'is-refused'}">
          <span>${esc(attempt.amountUsdc)}</span>
          <span class="unit">USDC</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="to">${esc(attempt.to)}</span>
        </p>
        <p class="entry__facts">
          <span>${esc(statusText(attempt))}</span>
          <span>${esc(runNote)}</span>
          <span>policy <b>${esc(run.policy?.mode ?? '—')}</b></span>
          <span>model <b>${esc(model)}</b></span>
        </p>
        ${tags}
        <details>
          <summary>Evidence</summary>
          <dl class="evidence-grid">
            <div><dt>Invoice reference</dt><dd>${esc(attempt.invoiceRef)}</dd></div>
            <div><dt>Decision provenance</dt><dd>${mode} · ${esc(model)}</dd></div>
            <div><dt>Attestation digest</dt><dd>${digest}</dd></div>
            <div><dt>Policy receipt</dt><dd>${attempt.policyTx ? esc(attempt.policyTx) : '—'}</dd></div>
            <div><dt>Chain transaction</dt><dd>${chain}</dd></div>
            <div><dt>Settlement</dt><dd>${settlementCell}</dd></div>
            <div class="wide"><dt>Removed before inference</dt><dd>${redacted}</dd></div>
          </dl>
        </details>
      </div>
    </article>`;
}

function renderLedger() {
  const rows = flattenAttempts();
  const counts = {
    all: rows.length,
    ok: rows.filter((row) => row.kind === 'ok').length,
    no: rows.filter((row) => row.kind === 'no').length,
  };

  for (const [key, value] of Object.entries(counts)) {
    const node = document.querySelector(`[data-count="${key}"]`);
    if (node) node.textContent = String(value);
  }

  const visible = rows.filter((row) => state.filter === 'all' || row.kind === state.filter);
  const list = $('#ledger-list');
  list.innerHTML = visible.map((row, index) => renderEntry(row, index)).join('');

  const empty = $('#empty');
  if (rows.length === 0) {
    empty.hidden = false;
    list.innerHTML = '';
  } else {
    empty.hidden = true;
    if (visible.length === 0) {
      list.innerHTML = `<p class="empty-note">No ${state.filter === 'ok' ? 'authorised' : 'refused'} entries in this dossier.</p>`;
    }
  }
}

function renderPolicy() {
  const policy = state.data.latestPolicy;
  const run = latestRun();
  const contract = state.data.contractId;
  const live = policy?.mode === 'testnet';
  const cap = policy?.capUsdc ?? 0;
  const spent = policy?.spentTodayUsdc ?? 0;
  const ratio = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
  const guard = run?.keyGuard;

  const whitelist = (policy?.whitelist ?? []).length
    ? policy.whitelist.map((account) => `<li>${esc(account)}</li>`).join('')
    : '<li class="empty-row">no accounts whitelisted</li>';

  const guardHtml = guard
    ? guard.checked
      ? `<div class="guard ${guard.ok ? '' : 'guard--warn'}">
           <b>Function Call Key ${guard.ok ? 'verified' : 'rejected'}</b><br />
           ${esc(guard.contractId ?? '')} · methods [try_pay]<br />
           ${esc(guard.checks.find((check) => check.name === 'has_gas_allowance')?.detail ?? '')}
         </div>`
      : `<div class="guard guard--warn"><b>Key guard skipped</b><br />${esc(guard.checks[0]?.detail ?? '')}</div>`
    : '';

  $('#policy-card').innerHTML = `
    <div class="card__head">
      <h3>Policy instrument</h3>
      <span class="card__src">${live ? 'on-chain' : 'local simulation'}<br />${contract ? esc(shortHash(contract, 12, 8)) : 'no contract'}</span>
    </div>
    <p class="cap"><span class="cap__num">${cap || '—'}</span><span class="cap__unit">USDC / day<br />hard cap</span></p>
    <div class="meter" role="img" aria-label="${spent} of ${cap} USDC spent today">
      <div class="meter__fill" style="width:${ratio}%"></div>
      <div class="meter__ticks"></div>
    </div>
    <p class="meter-caption"><span><b>${spent}</b> spent today</span><span><b>${Math.max(0, cap - spent)}</b> remaining</span></p>
    <p class="subhead">Whitelist</p>
    <ul class="whitelist">${whitelist}</ul>
    ${guardHtml}
    <p class="fine">${live
      ? 'Cap and whitelist live in the contract. The agent can call <code>try_pay</code> and nothing else.'
      : 'Local mirror of the contract rules. No funds and no chain state are touched.'}</p>`;
}

function renderEvidence() {
  const run = latestRun();
  const evidence = run?.tee?.attestation;
  if (!evidence) {
    $('#tee-card').innerHTML =
      '<div class="card__head"><h3>TEE evidence</h3><span class="stamp stamp--guard stamp--dark">No runs</span></div>' +
      '<p class="fine">Attestation evidence appears after a demo run.</p>';
    return;
  }

  const real = evidence.mode === 'real';
  const passed = evidence.checks.filter((check) => check.ok).length;
  const stamp = real
    ? '<span class="stamp stamp--ok stamp--dark">Real TEE</span>'
    : '<span class="stamp stamp--warn stamp--dark">Simulated</span>';

  const checks = evidence.checks
    .map(
      (check) => `
      <li data-ok="${check.ok}">
        <span class="mark">${check.ok ? '✓' : '✕'}</span>
        <span><b>${esc(pretty(check.name))}</b> — ${esc(check.detail)}</span>
      </li>`,
    )
    .join('');

  const environment = evidence.environment
    ? `<div class="evidence-env">
         <span>gateway app <b>${esc(evidence.environment.gatewayAppId ?? '—')}</b></span>
         <span>instance <b>${esc(evidence.environment.gatewayInstanceId ?? '—')}</b></span>
         <span>model signer <b>${esc(evidence.environment.modelSigningAddress ?? '—')}</b></span>
         <span>quote <b>${esc(evidence.environment.quoteBytes ?? 0)} chars</b> · event log <b>${esc(evidence.environment.eventLogEntries ?? 0)} entries</b></span>
       </div>`
    : '';

  const digest = `sha256:${evidence.digest}`;

  $('#tee-card').innerHTML = `
    <div class="card__head">
      <h3>TEE evidence</h3>
      ${stamp}
    </div>
    <p class="evidence-model">${esc(evidence.model)}</p>
    <p class="evidence-score">${real ? `${passed}/${evidence.checks.length}` : 'SIMULATED'} <span>${real ? 'structural checks' : 'attestation'}</span></p>
    <ul class="checks">${checks}</ul>
    ${environment}
    <div class="digest"><b>Report digest</b>${esc(digest)}</div>
    <div class="btn-row">
      <a class="btn" href="${esc(evidence.verificationUrl)}" target="_blank" rel="noreferrer">Open verifier ↗</a>
      <button class="btn" data-copy="${esc(digest)}">Copy digest</button>
    </div>
    <p class="fine">${real ? esc(evidence.disclaimer) : `<strong>SIMULATED_ATTESTATION</strong> — ${esc(evidence.reason ?? 'no real TEE call was made')}`}</p>
    <p class="fine">Report fetched ${esc(formatUtc(evidence.createdAt))} · full report archived under <code>artifacts/</code>.</p>`;
}

function renderChainCard() {
  const run = latestRun();
  const contract = state.data.contractId;
  const fullLog = run?.policy?.log ?? [];
  const entries = fullLog.slice(-8).reverse();

  const rows = entries
    .map(
      (entry) => `
      <tr>
        <td class="ref">${esc(entry.invoiceRef)}</td>
        <td>${esc(entry.to)}</td>
        <td class="amt">${esc(entry.amountUsdc)} USDC</td>
        <td class="${entry.result === 'SUCCESS' ? 'ok' : 'no'}">${esc(entry.result.replace(/^BLOCKED_/, '').replace(/_/g, ' '))}</td>
        <td class="ts">${esc(formatUtc(entry.ts).replace(' UTC', ''))}</td>
      </tr>`,
    )
    .join('');

  const table = entries.length
    ? `<table class="log">
         <caption>Policy contract log · newest first</caption>
         <thead><tr><th>Ref</th><th>To</th><th>Amount</th><th>Result</th><th>Time</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : '<p class="log-empty">No policy attempts recorded yet.</p>';

  $('#chain-card').innerHTML = `
    <div class="card__head">
      <h3>Chain record</h3>
      <span class="card__src">${contract ? 'testnet' : 'no contract'}</span>
    </div>
    ${table}
    <div class="btn-row">
      ${contract ? `<a class="btn btn--dark" href="${accountLink(contract)}" target="_blank" rel="noreferrer">Contract ↗</a>` : ''}
      <a class="btn btn--dark" href="data/dashboard.json" download>Download JSON</a>
    </div>
    <p class="fine">${fullLog.length > entries.length ? `Showing the latest ${entries.length} of ${fullLog.length} attempts. ` : ''}The contract stores the invoice reference, recipient, amount, result and timestamp. No invoice text.</p>`;
}

/* --------------------------------------------------------------- controls */

function applyFilter(filter) {
  state.filter = filter;
  for (const button of document.querySelectorAll('.filter')) {
    const active = button.dataset.filter === filter;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (state.data !== null) renderLedger();
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-copy]');
  if (!target) return;
  const value = target.getAttribute('data-copy') ?? '';
  try {
    await navigator.clipboard.writeText(value);
    const label = target.textContent;
    target.textContent = 'copied';
    setTimeout(() => {
      target.textContent = label;
    }, 1200);
  } catch {
    target.textContent = 'copy failed';
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load(true);
});

for (const button of document.querySelectorAll('.filter')) {
  button.addEventListener('click', () => applyFilter(button.dataset.filter ?? 'all'));
}

setInterval(() => {
  if (!document.hidden) load(false);
}, 5000);

load(true);

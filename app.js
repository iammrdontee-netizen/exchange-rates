"use strict";

/* ==========================================================================
   Config
   ========================================================================== */

// Primary CDN first, mirror second. Both serve the same data.
const API_URLS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json"
];

const FETCH_TIMEOUT_MS = 8000;
const CACHE_KEY = "fx-rates-v1";
const PREFS_KEY = "fx-prefs-v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (source updates daily)
const SEARCH_DEBOUNCE_MS = 150;

const DEFAULTS = { from: "xof", to: "ngn", base: "usd" };

// Shown first in the dropdowns, in this order
const PRIORITY = [
  "usd", "eur", "gbp", "ngn", "xof", "ghs", "kes", "zar",
  "jpy", "cny", "aud", "cad", "chf", "inr", "aed", "sar"
];

// Names Intl.DisplayNames doesn't know (crypto, metals) or that we want to override
const NAME_OVERRIDES = {
  btc: "Bitcoin",
  eth: "Ethereum",
  xau: "Gold (troy oz)",
  xag: "Silver (troy oz)"
};

/* ==========================================================================
   State and DOM
   ========================================================================== */

const state = {
  rates: {},        // relative to USD
  currencies: [],   // sorted codes
  date: "",
  note: ""          // e.g. "offline" notice
};

const $ = id => document.getElementById(id);
const els = {
  amount: $("amount"),
  from: $("from-currency"),
  to: $("to-currency"),
  swap: $("swap-btn"),
  resultAmount: $("result-amount"),
  resultRate: $("result-rate"),
  resultInverse: $("result-inverse"),
  updated: $("last-updated"),
  errorBox: $("error-box"),
  errorText: $("error-text"),
  retry: $("retry-btn"),
  base: $("base-currency"),
  baseLabel: $("base-label"),
  search: $("search"),
  tbody: $("rates-body"),
  converter: $("converter")
};

/* ==========================================================================
   Helpers
   ========================================================================== */

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }
};

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

const displayNames = (() => {
  try { return new Intl.DisplayNames(undefined, { type: "currency" }); } catch { return null; }
})();
const nameCache = new Map();

function getName(code) {
  if (nameCache.has(code)) return nameCache.get(code);

  let name = NAME_OVERRIDES[code];
  if (!name && displayNames) {
    try {
      const n = displayNames.of(code.toUpperCase());
      if (n && n.toUpperCase() !== code.toUpperCase()) name = n;
    } catch { /* invalid code for Intl */ }
  }
  name = name || code.toUpperCase();
  nameCache.set(code, name);
  return name;
}

// Display-only rounding; calculations always use full precision.
function formatNumber(n) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs === 0) return "0";
  if (abs < 0.01) return n.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  if (abs < 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function isValidRates(r) {
  return r && typeof r === "object" && Number.isFinite(r.eur) && Object.keys(r).length > 10;
}

function cleanRates(raw) {
  const cleaned = Object.fromEntries(
    Object.entries(raw || {}).filter(([, v]) => Number.isFinite(v) && v > 0)
  );
  cleaned.usd = 1;
  return cleaned;
}

/* ==========================================================================
   Data loading (cache -> network -> mirror -> stale cache)
   ========================================================================== */

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemote() {
  let lastError;
  for (const url of API_URLS) {
    try {
      const data = await fetchJson(url);
      const rates = cleanRates(data.usd);
      if (!isValidRates(rates)) throw new Error("Unexpected data format");
      return { rates, date: data.date || new Date().toISOString().slice(0, 10) };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function loadRates() {
  setLoading();

  const cached = store.get(CACHE_KEY);
  const cacheUsable = cached && isValidRates(cached.rates);

  if (cacheUsable && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    applyData(cached.rates, cached.date, "");
    return;
  }

  try {
    const { rates, date } = await fetchRemote();
    store.set(CACHE_KEY, { fetchedAt: Date.now(), date, rates });
    applyData(rates, date, "");
  } catch (err) {
    console.error("Failed to load rates:", err);
    if (cacheUsable) {
      applyData(cached.rates, cached.date, " (offline, showing saved rates)");
    } else {
      showError("Couldn't load exchange rates. Check your connection and try again.");
    }
  }
}

function applyData(rates, date, note) {
  state.rates = rates;
  state.date = date;
  state.note = note;
  state.currencies = sortCurrencies(Object.keys(rates));

  els.errorBox.hidden = true;
  populateSelects();
  convert();
  renderTable(els.search.value);
  els.updated.textContent = `Rates date: ${date}${note}`;
}

function sortCurrencies(codes) {
  return codes.sort((a, b) => {
    const ia = PRIORITY.indexOf(a);
    const ib = PRIORITY.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

/* ==========================================================================
   UI states
   ========================================================================== */

function setLoading() {
  els.errorBox.hidden = true;
  els.resultAmount.textContent = "Loading rates…";
  els.resultRate.textContent = "";
  els.resultInverse.textContent = "";
  els.updated.textContent = "";
  els.tbody.innerHTML = `<tr><td colspan="3" class="loading">Loading rates…</td></tr>`;
}

function showError(message) {
  els.errorText.textContent = message;
  els.errorBox.hidden = false;
  els.resultAmount.textContent = "Rates unavailable";
  els.resultRate.textContent = "";
  els.resultInverse.textContent = "";
  els.tbody.innerHTML = `<tr><td colspan="3" class="loading">Rates unavailable. Use Retry above.</td></tr>`;
}

/* ==========================================================================
   Selects, preferences, URL
   ========================================================================== */

function readInitialSelection() {
  const params = new URLSearchParams(location.search);
  const prefs = store.get(PREFS_KEY) || {};
  const pick = key => (params.get(key) || prefs[key] || DEFAULTS[key]).toLowerCase();

  const amountParam = params.get("amount");
  if (amountParam !== null && amountParam.trim() !== "" && Number.isFinite(Number(amountParam))) {
    els.amount.value = amountParam;
  }
  return { from: pick("from"), to: pick("to"), base: pick("base") };
}

let initialSelection = null;

function populateSelects() {
  // First load: URL > saved prefs > defaults. Later (retry/refresh): keep what the user picked.
  if (!initialSelection) initialSelection = readInitialSelection();
  const wanted = {
    from: els.from.value || initialSelection.from,
    to: els.to.value || initialSelection.to,
    base: els.base.value || initialSelection.base
  };

  const popular = state.currencies.filter(c => PRIORITY.includes(c));
  const others = state.currencies.filter(c => !PRIORITY.includes(c));

  [els.from, els.to, els.base].forEach(sel => (sel.innerHTML = ""));

  const buildGroup = (label, codes, withName) => {
    const groups = [els.from, els.to, els.base].map(() => {
      const g = document.createElement("optgroup");
      g.label = label;
      return g;
    });
    codes.forEach(code => {
      const full = `${code.toUpperCase()} – ${getName(code)}`;
      groups[0].append(new Option(full, code));
      groups[1].append(new Option(full, code));
      groups[2].append(new Option(code.toUpperCase(), code));
    });
    [els.from, els.to, els.base].forEach((sel, i) => {
      if (codes.length) sel.append(groups[i]);
    });
  };

  buildGroup("Popular", popular);
  buildGroup("All currencies", others);

  const valid = (code, fallback) => (state.rates[code] ? code : fallback);
  els.from.value = valid(wanted.from, DEFAULTS.from in state.rates ? DEFAULTS.from : "usd");
  els.to.value = valid(wanted.to, DEFAULTS.to in state.rates ? DEFAULTS.to : "eur");
  els.base.value = valid(wanted.base, "usd");
}

function persistSelection() {
  store.set(PREFS_KEY, { from: els.from.value, to: els.to.value, base: els.base.value });

  try {
    const params = new URLSearchParams({
      from: els.from.value.toUpperCase(),
      to: els.to.value.toUpperCase(),
      amount: els.amount.value
    });
    history.replaceState(null, "", `${location.pathname}?${params}`);
  } catch { /* e.g. file:// or sandboxed frames */ }
}

/* ==========================================================================
   Converter
   ========================================================================== */

function convert() {
  const raw = els.amount.value.trim();
  const amount = Number(raw);
  const from = els.from.value;
  const to = els.to.value;

  if (!state.rates[from] || !state.rates[to]) return;

  if (raw === "" || !Number.isFinite(amount) || amount < 0) {
    els.resultAmount.textContent = "Enter an amount of 0 or more";
    els.resultRate.textContent = "";
    els.resultInverse.textContent = "";
    return;
  }

  const rate = state.rates[to] / state.rates[from];
  const result = amount * rate;
  const F = from.toUpperCase();
  const T = to.toUpperCase();

  els.resultAmount.textContent = `${formatNumber(amount)} ${F} = ${formatNumber(result)} ${T}`;
  els.resultRate.textContent = `1 ${F} = ${formatNumber(rate)} ${T}`;
  els.resultInverse.textContent = `1 ${T} = ${formatNumber(1 / rate)} ${F}`;

  persistSelection();
}

/* ==========================================================================
   Rates table
   ========================================================================== */

function renderTable(filter = "") {
  const base = els.base.value || "usd";
  const q = filter.trim().toLowerCase();

  els.baseLabel.textContent = base.toUpperCase();

  const frag = document.createDocumentFragment();

  state.currencies.forEach(code => {
    if (code === base) return;
    const name = getName(code);
    if (q && !code.includes(q) && !name.toLowerCase().includes(q)) return;

    const rate = state.rates[code] / state.rates[base];

    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-btn";
    btn.dataset.code = code;
    btn.textContent = name;
    btn.title = `Convert ${base.toUpperCase()} to ${code.toUpperCase()}`;
    tdName.append(btn);

    const tdCode = document.createElement("td");
    tdCode.className = "code";
    tdCode.textContent = code.toUpperCase();

    const tdRate = document.createElement("td");
    tdRate.className = "num";
    tdRate.textContent = formatNumber(rate);

    tr.append(tdName, tdCode, tdRate);
    frag.append(tr);
  });

  els.tbody.replaceChildren();
  if (frag.childNodes.length) {
    els.tbody.append(frag);
  } else {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "loading";
    td.textContent = "No matching currencies";
    tr.append(td);
    els.tbody.append(tr);
  }
}

/* ==========================================================================
   Events
   ========================================================================== */

els.amount.addEventListener("input", convert);
els.from.addEventListener("change", convert);
els.to.addEventListener("change", convert);

els.swap.addEventListener("click", () => {
  [els.from.value, els.to.value] = [els.to.value, els.from.value];
  convert();
});

els.base.addEventListener("change", () => {
  renderTable(els.search.value);
  persistSelection();
});

els.search.addEventListener("input", debounce(e => renderTable(e.target.value), SEARCH_DEBOUNCE_MS));

// Clicking a currency in the table converts base -> that currency
els.tbody.addEventListener("click", e => {
  const btn = e.target.closest(".row-btn");
  if (!btn) return;

  els.from.value = els.base.value;
  els.to.value = btn.dataset.code;
  convert();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  els.converter.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  els.amount.focus({ preventScroll: true });
});

els.retry.addEventListener("click", loadRates);

/* ==========================================================================
   Start
   ========================================================================== */

loadRates();
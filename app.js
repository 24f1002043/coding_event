'use strict';
/* ═══════════════════════════════════════════════════════════════
   Redline — forensic expense auditor
   Everything runs client-side. No build step, no dependencies.
   ═══════════════════════════════════════════════════════════════ */

// ───────────── constants ─────────────
const LS_KEY = 'redline.v1';
let APPROVAL_LIMIT = 5000;
const SENS_Z = [5, 4.25, 3.5, 3, 2.6]; // outlier threshold per sensitivity step
const CATEGORIES = ['Food', 'Groceries', 'Transport', 'Shopping', 'Bills', 'Subscriptions', 'Health', 'Entertainment', 'Travel', 'Other'];
const DISCRETIONARY = ['Food', 'Shopping', 'Entertainment', 'Transport'];
const KEYWORDS = {
  Food: ['swiggy', 'zomato', 'cafe', 'chai', 'pizza', 'restaurant', 'domino', 'kfc', 'mcdonald', 'biryani', 'food', 'starbucks', 'dinner', 'lunch', 'breakfast', 'bakery', 'truffles'],
  Groceries: ['bigbasket', 'dmart', 'zepto', 'blinkit', 'grocery', 'groceries', 'instamart', 'supermarket', 'vegetable', 'milk', 'kirana'],
  Transport: ['uber', 'ola', 'rapido', 'metro', 'petrol', 'fuel', 'parking', 'toll', 'cab', 'auto', 'bus', 'fastag'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'ajio', 'croma', 'nykaa', 'mall', 'store', 'shopping', 'clothes', 'gift', 'decathlon'],
  Bills: ['airtel', 'jio', 'electricity', 'bescom', 'water', 'gas', 'fibernet', 'broadband', 'rent', 'bill', 'recharge', 'insurance'],
  Subscriptions: ['netflix', 'spotify', 'prime', 'hotstar', 'youtube', 'icloud', 'subscription', 'gym'],
  Health: ['apollo', 'pharmacy', 'medplus', 'hospital', 'clinic', 'doctor', 'medicine', 'lab', 'pharmeasy'],
  Entertainment: ['bookmyshow', 'pvr', 'inox', 'movie', 'concert', 'game', 'steam'],
  Travel: ['irctc', 'indigo', 'makemytrip', 'airbnb', 'hotel', 'flight', 'train', 'oyo', 'goibibo'],
};
const RULE_LABEL = {
  duplicate: 'Duplicate', split: 'Split purchase', outlier: 'Outlier', threshold: 'Threshold',
  offhours: 'Off-habit', newpayee: 'Unknown payee', round: 'Round sum',
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ───────────── state ─────────────
let state = { tx: [], dismissed: [], confirmed: [], trusted: [], budget: 40000, limit: 5000, sens: 3, theme: 'light' };
let ui = {
  page: 'overview', caseTab: 'open', sev: 'all', sel: null, txPage: 0,
  f: { q: '', cat: '', flag: false, month: null, date: null, dow: null, hour: null },
  plan: { Food: 15, Shopping: 20, Entertainment: 10, Transport: 10 },
};
let audit = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && Array.isArray(s.tx)) state = { ...state, ...s };
  } catch (e) { /* storage unavailable — run in memory */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

// ───────────── helpers ─────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const inrExact = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ts = (t) => new Date(`${t.date}T${t.time || '12:00'}`).getTime();
const uid = () => Math.random().toString(36).slice(2, 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
const median = (a) => quantile(a, 0.5);
function groupBy(arr, fn) {
  const m = {};
  for (const x of arr) (m[fn(x)] ||= []).push(x);
  return m;
}
const weekdayIdx = (d) => (d.getDay() + 6) % 7; // Monday = 0
const prettyDate = (iso) => {
  const d = new Date(iso + 'T00:00');
  return `${DAYS[weekdayIdx(d)]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const gap = (mins) => mins < 60 ? `${mins} min` : mins < 1440 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const daysAgoTs = (n) => startOfToday().getTime() - n * 86400000 + 86400000; // end of that day window

// ───────────── categorisation ─────────────
function categorize(merchant, text = '') {
  const m = merchant.toLowerCase().trim();
  const counts = {};
  for (const t of state.tx) if (t.merchant.toLowerCase() === m) counts[t.category] = (counts[t.category] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best) return { category: best[0], source: 'learned from your books' };
  const hay = `${m} ${text}`.toLowerCase();
  for (const c of CATEGORIES) if (new RegExp(`\\b${c.toLowerCase()}\\b`).test(hay)) return { category: c, source: 'stated' };
  for (const [cat, words] of Object.entries(KEYWORDS)) if (words.some((w) => hay.includes(w))) return { category: cat, source: 'keyword' };
  return { category: 'Other', source: 'no match' };
}

// ═══════════════ the audit engine ═══════════════
function runAudit() {
  APPROVAL_LIMIT = Math.max(500, +state.limit || 5000);
  const tx = [...state.tx].sort((a, b) => ts(a) - ts(b));
  const dismissed = new Set(state.dismissed);
  const confirmed = new Set(state.confirmed);
  const trusted = new Set(state.trusted.map((s) => s.toLowerCase()));
  const flags = new Map();
  const flag = (t, rule, weight, text) => {
    if (!flags.has(t.id)) flags.set(t.id, { tx: t, reasons: [] });
    flags.get(t.id).reasons.push({ rule, weight, text });
  };
  if (!tx.length) return emptyAudit();

  // per-category robust statistics
  const stats = {};
  for (const [c, list] of Object.entries(groupBy(tx, (t) => t.category))) {
    const a = list.map((t) => t.amount);
    const la = a.map((x) => Math.log(x));
    const lmed = median(la);
    const lmad = median(la.map((x) => Math.abs(x - lmed))) || 0.25;
    stats[c] = { med: median(a), lmed, lmad, p90: quantile(a, 0.9), n: a.length };
  }
  const globalP90 = quantile(tx.map((t) => t.amount), 0.9);
  const firstTs = ts(tx[0]);

  // hour-of-day habit histogram
  const hourCount = Array(24).fill(0);
  for (const t of tx) hourCount[+(t.time || '12:00').slice(0, 2)]++;

  const globalMed = median(tx.map((t) => t.amount));

  // 1 · robust outlier: modified z-score (Iglewicz & Hoaglin) in log space, since spending is log-normal
  for (const t of tx) {
    const s = stats[t.category];
    if (s.n < 6) continue;
    const z = (0.6745 * (Math.log(t.amount) - s.lmed)) / s.lmad;
    if (z > SENS_Z[(state.sens || 3) - 1]) flag(t, 'outlier', Math.min(55, 30 + Math.round(z * 1.5)),
      `${inr(t.amount)} is ${(t.amount / s.med).toFixed(1)}× your typical ${t.category} spend of ${inr(s.med)} (modified z = ${z.toFixed(1)}).`);
  }

  // 2 · duplicate charge
  const last = {};
  for (const t of tx) {
    const key = `${t.merchant.toLowerCase()}|${t.amount}`;
    const p = last[key];
    const window = t.amount >= 500 ? 48 * 3600e3 : 2 * 3600e3;
    if (p && ts(t) - ts(p) <= window) {
      flag(t, 'duplicate', 55, `Same merchant, same amount (${inrExact(t.amount)}) charged again ${gap(Math.round((ts(t) - ts(p)) / 60000))} after the previous charge.`);
    }
    last[key] = t;
  }

  // 3 · split purchase
  for (const list of Object.values(groupBy(tx, (t) => `${t.date}|${t.merchant.toLowerCase()}`))) {
    if (list.length < 2) continue;
    const total = sum(list.map((t) => t.amount));
    if (list.every((t) => t.amount < APPROVAL_LIMIT) && total >= APPROVAL_LIMIT) {
      for (const t of list) flag(t, 'split', 45,
        `One of ${list.length} charges at ${t.merchant} that day, together ${inr(total)}. Each one stays under the ${inr(APPROVAL_LIMIT)} approval limit.`);
    }
  }

  for (const t of tx) {
    const s = stats[t.category];
    const isTrusted = trusted.has(t.merchant.toLowerCase());
    const hour = +(t.time || '12:00').slice(0, 2);

    // 4 · threshold hugging
    if (t.amount >= APPROVAL_LIMIT * 0.95 && t.amount < APPROVAL_LIMIT)
      flag(t, 'threshold', 35, `Sits just ${inrExact(APPROVAL_LIMIT - t.amount)} under the ${inr(APPROVAL_LIMIT)} approval limit.`);

    // 5 · off-habit timing
    const share = hourCount[hour] / tx.length;
    if (!isTrusted && share < 0.02 && t.amount > (s.n >= 6 ? s.med : globalMed) * 1.5 && t.amount >= 500)
      flag(t, 'offhours', 25, `Logged at ${t.time}. Only ${(share * 100).toFixed(1)}% of your spending ever happens in this hour.`);

    // 6 · unknown payee (needs 3 weeks of baseline)
    if (!isTrusted && ts(t) - firstTs > 21 * 86400000) {
      const prior = tx.find((x) => x.merchant.toLowerCase() === t.merchant.toLowerCase());
      const p90 = s.n >= 6 ? s.p90 : globalP90;
      if (prior === t && t.amount > p90)
        flag(t, 'newpayee', 25, `First time you've ever paid ${t.merchant}, and it's above 90% of your ${s.n >= 6 ? t.category : ''} purchases.`.replace('  ', ' '));
    }

    // 7 · round sum (weak signal, only adds weight)
    if (!isTrusted && t.amount >= 1000 && t.amount % 500 === 0)
      flag(t, 'round', 10, 'A perfectly round amount, which is common in manual or invented entries.');
  }

  // score cases
  const cases = [];
  for (const f of flags.values()) {
    const score = Math.min(99, sum(f.reasons.map((r) => r.weight)));
    if (score < 30) continue;
    f.reasons.sort((a, b) => b.weight - a.weight);
    f.score = score;
    f.sev = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
    f.status = confirmed.has(f.tx.id) ? 'confirmed' : dismissed.has(f.tx.id) ? 'dismissed' : 'open';
    cases.push(f);
  }
  [...cases].sort((a, b) => ts(a.tx) - ts(b.tx)).forEach((c, i) => (c.no = i + 1));
  cases.sort((a, b) => b.score - a.score || ts(b.tx) - ts(a.tx));
  const byId = new Map(cases.map((c) => [c.tx.id, c]));

  return { tx, cases, byId, stats, patterns: surgePatterns(tx), benford: benford(tx), recurring: recurring(tx) };
}
function emptyAudit() {
  return { tx: [], cases: [], byId: new Map(), stats: {}, patterns: [], benford: benford([]), recurring: [] };
}

// 8 · category surge — rolling 30-day windows so it works on any day of the month
function surgePatterns(tx) {
  const out = [];
  const end = daysAgoTs(0);
  const win = (k) => tx.filter((t) => ts(t) <= end - k * 30 * 86400000 && ts(t) > end - (k + 1) * 30 * 86400000);
  if (!tx.length || ts(tx[0]) > end - 100 * 86400000) return out;
  const w = [0, 1, 2, 3].map((k) => groupBy(win(k), (t) => t.category));
  for (const c of CATEGORIES) {
    const cur = sum((w[0][c] || []).map((t) => t.amount));
    const base = mean([1, 2, 3].map((k) => sum((w[k][c] || []).map((t) => t.amount))));
    if (base > 0 && cur > base * 1.6 && cur - base > 1500) out.push({ cat: c, cur, base, ratio: cur / base });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// Benford's first-digit law, tested with Pearson chi-square
function benford(tx) {
  const counts = Array(10).fill(0);
  let n = 0;
  for (const t of tx) {
    if (t.amount < 10) continue;
    counts[+String(Math.floor(t.amount))[0]]++;
    n++;
  }
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => Math.log10(1 + 1 / d));
  const observed = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (n ? counts[d] / n : 0));
  const mad = mean(observed.map((o, i) => Math.abs(o - expected[i])));
  // Pearson chi-square, 8 degrees of freedom (critical 15.51 at p=.05, 20.09 at p=.01)
  const chi = n ? sum(expected.map((e, i) => (counts[i + 1] - e * n) ** 2 / (e * n))) : 0;
  const verdict = n < 50 ? 'Not enough entries yet' : chi < 15.51 ? 'Consistent with Benford' : chi < 20.09 ? 'Mild deviation' : 'Significant deviation';
  let worst = 0;
  observed.forEach((o, i) => { if (o - expected[i] > observed[worst] - expected[worst]) worst = i; });
  return { n, expected, observed, mad, chi, verdict, worstDigit: worst + 1 };
}

// recurring charges: same merchant, ≥3 distinct months, stable amount
function recurring(tx) {
  const out = [];
  for (const list of Object.values(groupBy(tx, (t) => t.merchant.toLowerCase()))) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    if (months.size < 3) continue;
    const a = list.map((t) => t.amount);
    const m = mean(a);
    const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
    if (sd / m < 0.08) out.push({ merchant: list[0].merchant, amount: median(a), yearly: median(a) * 12 });
  }
  return out.sort((a, b) => b.yearly - a.yearly);
}

// ═══════════════ natural-language entry ═══════════════
function parseEntry(text) {
  let s = ' ' + text.toLowerCase().replace(/,/g, '') + ' ';
  const r = { amount: null, date: null, time: null, method: null, merchant: null };
  const take = (re) => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };

  // time first so "9pm" isn't read as an amount
  let m = take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let h = +m[1] % 12; if (m[3] === 'pm') h += 12;
    r.time = `${pad(h)}:${pad(+(m[2] || 0))}`;
  } else if ((m = take(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/))) r.time = `${pad(+m[1])}:${m[2]}`;
  else if (take(/\b(midnight)\b/)) r.time = '00:00';
  else if (take(/\b(noon)\b/)) r.time = '12:00';

  const d = startOfToday();
  if (take(/\byesterday\b/)) d.setDate(d.getDate() - 1), (r.date = isoDate(d));
  else if (take(/\btoday\b/)) r.date = isoDate(d);
  else if ((m = take(/\b(\d+)\s+days?\s+ago\b/))) d.setDate(d.getDate() - +m[1]), (r.date = isoDate(d));
  else if ((m = take(/\b(?:on\s+|last\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/))) {
    const target = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(m[1]);
    let back = (weekdayIdx(d) - target + 7) % 7 || 7;
    d.setDate(d.getDate() - back); r.date = isoDate(d);
  } else if ((m = take(/\b(\d{4}-\d{2}-\d{2})\b/))) r.date = m[1];

  if ((m = take(/\b(?:via|using|by|with|on)?\s*(upi|gpay|phonepe|paytm|credit card|debit card|card|cash|net ?banking)\b/))) {
    const v = m[1];
    r.method = /upi|gpay|phonepe|paytm/.test(v) ? 'UPI' : v === 'cash' ? 'Cash' : v.startsWith('debit') ? 'Debit Card' : v.startsWith('net') ? 'Net Banking' : 'Credit Card';
  }

  if ((m = take(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(k)?\b(?:\s*(?:rs|rupees|inr))?/))) r.amount = +m[1] * (m[2] ? 1000 : 1);

  const stop = new Set(['spent', 'spend', 'paid', 'pay', 'bought', 'for', 'at', 'on', 'to', 'from', 'in', 'the', 'a', 'an', 'my', 'via', 'using', 'rs', 'inr', 'rupees', 'i', 'and', 'of', 'some']);
  const words = s.replace(/[^a-z0-9&'\s.-]/g, ' ').split(/\s+/).filter((w) => w && !stop.has(w));
  if (words.length) r.merchant = words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (r.merchant) Object.assign(r, categorize(r.merchant, text));
  return r;
}

function submitEntry() {
  const v = $('#cmd').value.trim();
  if (!v) return;
  const p = parseEntry(v);
  if (!p.amount || !p.merchant) return toast('I need at least an amount and a payee, e.g. "320 at uber".', true);
  const now = new Date();
  addTx({
    date: p.date || isoDate(now), time: p.time || `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    amount: p.amount, merchant: p.merchant, category: p.category, method: p.method || 'UPI', note: '',
  });
  $('#cmd').value = '';
  renderPreview();
}

function addTx(t) {
  const tx = { id: uid(), ...t, amount: Math.round(+t.amount * 100) / 100 };
  state.tx.push(tx);
  save();
  render();
  const c = audit.byId.get(tx.id);
  if (c) toast(`Redlined: ${tx.merchant} ${inrExact(tx.amount)}. ${c.reasons[0].text}`, true);
  else toast(`Entered ${tx.merchant} ${inrExact(tx.amount)} under ${tx.category}. Nothing unusual.`);
}

// ═══════════════ sample books ═══════════════
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function generateSample() {
  const rnd = mulberry32(20261007);
  const randn = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const today = startOfToday();
  const tx = [];
  const add = (ago, time, amount, merchant, category, method, note = '') => {
    const d = new Date(today); d.setDate(d.getDate() - ago);
    tx.push({ id: uid(), date: isoDate(d), time, amount, merchant, category, method, note });
  };
  const profiles = [
    { cat: 'Food', m: ['Swiggy', 'Zomato', 'Chai Point', 'Truffles Cafe'], rate: 0.9, wk: 1.4, med: 320, sd: 0.7, hrs: [[12, 14], [19, 22]], pay: ['UPI', 'UPI', 'Credit Card'] },
    { cat: 'Groceries', m: ['BigBasket', 'DMart', 'Zepto', 'Blinkit'], rate: 0.32, wk: 1.6, med: 780, sd: 0.75, hrs: [[9, 12], [17, 21]], pay: ['UPI', 'Debit Card'] },
    { cat: 'Transport', m: ['Uber', 'Ola', 'Rapido', 'Namma Metro'], rate: 0.85, wk: 0.6, med: 170, sd: 0.75, hrs: [[8, 10], [18, 20]], pay: ['UPI'] },
    { cat: 'Shopping', m: ['Amazon', 'Myntra', 'Flipkart', 'Decathlon'], rate: 0.12, wk: 1.8, med: 1200, sd: 0.8, hrs: [[11, 21]], pay: ['Credit Card', 'UPI'] },
    { cat: 'Health', m: ['Apollo Pharmacy', 'MedPlus'], rate: 0.05, wk: 1, med: 480, sd: 0.6, hrs: [[10, 20]], pay: ['UPI'] },
    { cat: 'Entertainment', m: ['BookMyShow', 'PVR Cinemas'], rate: 0.06, wk: 2.2, med: 600, sd: 0.5, hrs: [[17, 21]], pay: ['Credit Card'] },
  ];
  for (let ago = 179; ago >= 0; ago--) {
    const d = new Date(today); d.setDate(d.getDate() - ago);
    const weekend = weekdayIdx(d) >= 5;
    for (const p of profiles) {
      let rate = p.rate * (weekend ? p.wk : 1);
      while (rate > 0) {
        if (rnd() < Math.min(rate, 1)) {
          const [lo, hi] = pick(p.hrs);
          const time = `${pad(lo + Math.floor(rnd() * (hi - lo + 1)))}:${pad(Math.floor(rnd() * 60))}`;
          const amt = Math.max(20, Math.round(p.med * Math.exp(p.sd * randn())));
          add(ago, time, amt, pick(p.m), p.cat, pick(p.pay));
        }
        rate -= 1;
      }
    }
    const dom = d.getDate();
    if (dom === 5) { add(ago, '09:12', 799, 'Airtel', 'Bills', 'UPI'); add(ago, '09:15', 1179, 'ACT Fibernet', 'Bills', 'UPI'); }
    if (dom === 8) add(ago, '18:40', Math.round(900 + rnd() * 1100), 'BESCOM Electricity', 'Bills', 'Net Banking');
    if (dom === 12) add(ago, '06:00', 649, 'Netflix', 'Subscriptions', 'Credit Card');
    if (dom === 20) add(ago, '06:00', 119, 'Spotify', 'Subscriptions', 'Credit Card');
    if (dom === 13 && ago >= 28 && ago <= 55) add(ago, '06:02', 649, 'Netflix', 'Subscriptions', 'Credit Card'); // double billing
  }
  add(122, '10:30', 5620, 'IndiGo', 'Travel', 'Credit Card', 'Goa trip');
  add(64, '21:05', 1840, 'IRCTC', 'Travel', 'UPI');

  // planted anomalies, each one a pattern Redline should catch
  add(2, '03:40', 9000, 'QuickCash Loans', 'Other', 'UPI');
  add(4, '02:14', 4860, 'Swiggy', 'Food', 'Credit Card');
  add(9, '15:02', 2349, 'Amazon', 'Shopping', 'Credit Card');
  add(9, '15:07', 2349, 'Amazon', 'Shopping', 'Credit Card');
  add(15, '23:52', 2780, 'Uber', 'Transport', 'UPI');
  add(20, '11:10', 3200, 'Croma', 'Shopping', 'Credit Card');
  add(20, '11:24', 2900, 'Croma', 'Shopping', 'Credit Card');
  add(20, '11:41', 2650, 'Croma', 'Shopping', 'Credit Card');
  add(35, '16:20', 4990, 'Corporate Gifts Co', 'Shopping', 'Debit Card', 'client gifts');
  return tx;
}

// ═══════════════ CSV ═══════════════
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function normDate(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${pad(+m[2])}-${pad(+m[1])}`; // Indian DD/MM/YYYY
  }
  const d = new Date(s);
  return isNaN(d) ? null : isoDate(d);
}
function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return toast('That file has no rows I can read.', true);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const ci = {
    date: col('date'), time: col('time'), amount: col('amount', 'debit', 'withdrawal', 'value'),
    merchant: col('merchant', 'description', 'narration', 'payee', 'name', 'details'),
    category: col('category'), method: col('method', 'mode', 'payment'), note: col('note', 'remark', 'memo'),
  };
  if (ci.date < 0 || ci.amount < 0 || ci.merchant < 0) return toast('I need date, amount and merchant/description columns.', true);
  const before = audit ? audit.cases.filter((c) => c.status === 'open').length : 0;
  let added = 0;
  for (const r of rows.slice(1)) {
    const date = normDate(r[ci.date] || '');
    const amount = Math.abs(parseFloat(String(r[ci.amount] || '').replace(/[₹,\s]/g, '')));
    const merchant = (r[ci.merchant] || '').trim();
    if (!date || !amount || !merchant) continue;
    let time = ci.time >= 0 ? (r[ci.time] || '').trim().slice(0, 5) : '';
    const dtTime = (r[ci.date] || '').match(/(\d{1,2}):(\d{2})/);
    if (!/^\d{1,2}:\d{2}$/.test(time)) time = dtTime ? `${pad(+dtTime[1])}:${dtTime[2]}` : '12:00';
    else time = time.padStart(5, '0');
    let category = ci.category >= 0 ? (r[ci.category] || '').trim() : '';
    const match = CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
    category = match || categorize(merchant).category;
    state.tx.push({
      id: uid(), date, time, amount: Math.round(amount * 100) / 100, merchant, category,
      method: ci.method >= 0 && r[ci.method] ? r[ci.method].trim() : 'UPI', note: ci.note >= 0 ? (r[ci.note] || '').trim() : '',
    });
    added++;
  }
  save(); render();
  const after = audit.cases.filter((c) => c.status === 'open').length;
  toast(`Imported ${added} entries, categorised automatically. ${Math.max(0, after - before)} new redlines.`, after > before);
}
function exportCSV() {
  if (!audit.tx.length) return toast('Nothing to export yet.');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['date', 'time', 'merchant', 'category', 'method', 'amount', 'note', 'risk_score', 'severity', 'status', 'reasons'].join(',')];
  for (const t of audit.tx) {
    const c = audit.byId.get(t.id);
    lines.push([t.date, t.time, q(t.merchant), t.category, q(t.method), t.amount, q(t.note), c ? c.score : 0, c ? c.sev : '', c ? c.status : '', q(c ? c.reasons.map((r) => r.text).join(' | ') : '')].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `redline-audit-${isoDate(new Date())}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  toast('Audit exported.');
}

// ═══════════════ interface ═══════════════
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  printer: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8" rx="1"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  split: '<path d="M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.2-2.8L3 3M15 9l6-6"/>',
  trend: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  userplus: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M19 8v6M22 11h-6"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  sigma: '<path d="M18 7V4H6l6 8-6 8h12v-3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v4M3 5v14a2 2 0 0 0 2 2h15v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  piggy: '<path d="M5 11a7 7 0 0 1 7-5h2a7 7 0 0 1 7 7v1a4 4 0 0 1-2 3.5V20h-3v-2h-4v2H9v-2.3A6 6 0 0 1 5 13z"/><path d="M15 10h.01M2 10a3 3 0 0 0 3 3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H5"/>',
};
const icon = (n, s = 16) => `<svg class="i" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, +(el.dataset.size || 16)); });
}

const CAT_COLOR = {
  Food: '#e0612b', Groceries: '#5c9a2c', Transport: '#1f8db0', Shopping: '#7b5cd6', Bills: '#5b6b82',
  Subscriptions: '#cf4577', Health: '#1d9a74', Entertainment: '#c38c0a', Travel: '#3b6fe0', Other: '#8a877e',
};
const RULE_META = {
  outlier: { icon: 'trend', title: 'Unusual amount' },
  duplicate: { icon: 'copy', title: 'Duplicate charge' },
  split: { icon: 'split', title: 'Split purchase' },
  threshold: { icon: 'gauge', title: 'Just under approval limit' },
  offhours: { icon: 'clock', title: 'Off-habit timing' },
  newpayee: { icon: 'userplus', title: 'Unknown payee' },
  round: { icon: 'hash', title: 'Round amount' },
};
const SENS_LABEL = ['Relaxed', 'Lenient', 'Balanced', 'Sharp', 'Strict'];
const TAB_LABEL = { open: 'Open', confirmed: 'Fraud', dismissed: 'Cleared' };
const PAGES = ['overview', 'cases', 'transactions', 'analytics', 'methods'];
const FULL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const PAGE_SIZE = 20;

const hue = (s) => { let h = 7; for (const ch of String(s).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const initials = (s) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const avatar = (m, cls = '') => `<span class="avatar ${cls}" style="--h:${hue(m)}">${esc(initials(m))}</span>`;
const catPill = (c) => `<span class="pill cat" style="--c:${CAT_COLOR[c] || CAT_COLOR.Other}">${esc(c)}</span>`;
const isLive = (c) => c && c.status !== 'dismissed';
function riskPill(c) {
  if (!c) return '<span class="sev none">·</span>';
  if (c.status === 'dismissed') return '<span class="sev cleared">Cleared</span>';
  if (c.status === 'confirmed') return '<span class="sev fraud">Fraud</span>';
  return `<span class="sev ${c.sev}">${c.score}</span>`;
}
const svgEl = (w, h, body, cls = '') => `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="${cls}">${body}</svg>`;
const kfmt = (n) => (n >= 100000 ? (n / 100000).toFixed(1) + 'L' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n)));
const tipAttr = (html) => `data-tip="${esc(html)}"`;
const plural = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;

// month-end projection: extrapolate ordinary spending, count flagged one-offs once
function projectMonth(tx, byId) {
  const today = startOfToday();
  const key = isoDate(today).slice(0, 7);
  const list = tx.filter((t) => t.date.startsWith(key));
  const odd = sum(list.filter((t) => isLive(byId.get(t.id))).map((t) => t.amount));
  const clean = sum(list.map((t) => t.amount)) - odd;
  const dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return (clean / today.getDate()) * dim + odd;
}
function dailySeries(days) {
  const map = {};
  for (const t of audit.tx) {
    const m = (map[t.date] ||= { sum: 0, n: 0, flag: 0, flagAmt: 0 });
    m.sum += t.amount; m.n++;
    const c = audit.byId.get(t.id);
    if (isLive(c)) { m.flag++; m.flagAmt += t.amount; }
  }
  const end = startOfToday();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end); d.setDate(d.getDate() - i);
    const k = isoDate(d);
    out.push({ date: k, d, ...(map[k] || { sum: 0, n: 0, flag: 0, flagAmt: 0 }) });
  }
  return out;
}

// ───────────── render root ─────────────
function render() {
  audit = runAudit();
  renderChrome();
  renderOverview();
  renderCases();
  renderTransactions();
  renderAnalytics();
  renderMethods();
  animateCounts();
}

function renderChrome() {
  const open = audit.cases.filter((c) => c.status === 'open');
  $('#navCases').textContent = open.length || '';
  $('#navTx').textContent = audit.tx.length || '';
  const atRisk = sum(open.map((c) => c.tx.amount));
  const months = new Set(audit.tx.map((t) => t.date.slice(0, 7))).size;
  $('#verdict').innerHTML = audit.tx.length
    ? `Audited <b>${audit.tx.length}</b> payments across ${plural(months, 'month')}. <b class="red">${plural(open.length, 'open case')}</b>, <b class="red">${inr(atRisk)}</b> under review.`
    : 'No payments yet. Load sample data, import a statement or add an entry.';
}

// ───────────── count-up animation ─────────────
const lastCount = {};
function animateCounts() {
  $$('[data-count]').forEach((el) => {
    const to = +el.dataset.count, key = el.dataset.key;
    const from = lastCount[key] ?? 0;
    lastCount[key] = to;
    if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = inr(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = inr(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// ═══════════════ Overview ═══════════════
function renderOverview() {
  const { tx, cases, benford: bf, byId } = audit;
  const open = cases.filter((c) => c.status === 'open');
  const hi = open.filter((c) => c.sev === 'High');

  $('#alertBanner').innerHTML = hi.length ? `<div class="banner">${icon('alert', 18)}<div><b>${plural(hi.length, 'high-risk case')} need review</b>, ${inr(sum(hi.map((c) => c.tx.amount)))} in total. The top one is ${esc(hi[0].tx.merchant)} for ${inrExact(hi[0].tx.amount)}.</div><button class="btn danger sm" data-case="${hi[0].tx.id}">Investigate ${icon('arrow', 14)}</button></div>` : '';

  // KPIs
  const today = startOfToday();
  const key = isoDate(today).slice(0, 7);
  const pkey = isoDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
  const mtd = sum(tx.filter((t) => t.date.startsWith(key)).map((t) => t.amount));
  const lmtd = sum(tx.filter((t) => t.date.startsWith(pkey) && +t.date.slice(8) <= today.getDate()).map((t) => t.amount));
  const d = lmtd ? (mtd / lmtd - 1) * 100 : 0;
  const spark = dailySeries(30).map((x) => x.sum);
  const md = open.filter((c) => c.sev === 'Medium').length;
  const proj = tx.length ? projectMonth(tx, byId) : 0;
  const ratio = state.budget ? proj / state.budget : 0;
  const ok = bf.n >= 50 && bf.chi < 15.51;
  $('#kpis').innerHTML = `
    <div class="card kpi link" data-go="transactions">
      <div class="kpi-label">${icon('wallet', 15)}Spent this month</div>
      <div class="kpi-value num" data-count="${Math.round(mtd)}" data-key="mtd">${inr(mtd)}</div>
      <div class="kpi-foot">${lmtd ? `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d).toFixed(0)}%</span> vs same days last month` : 'No prior month to compare'}</div>
      ${sparkline(spark)}
    </div>
    <div class="card kpi link" data-go="cases">
      <div class="kpi-label">${icon('shield', 15)}Under review</div>
      <div class="kpi-value num" data-count="${Math.round(sum(open.map((c) => c.tx.amount)))}" data-key="risk">${inr(sum(open.map((c) => c.tx.amount)))}</div>
      <div class="sevbar"><span style="flex:${hi.length};background:var(--red)"></span><span style="flex:${md};background:var(--amber)"></span><span style="flex:${Math.max(0, open.length - hi.length - md)};background:var(--green)"></span></div>
      <div class="kpi-foot">${plural(open.length, 'open case')} · <b class="red">${hi.length} high</b> · ${md} medium</div>
    </div>
    <div class="card kpi">
      <div class="kpi-label">${icon('target', 15)}Projected month-end</div>
      <div class="kpi-value num" data-count="${Math.round(proj)}" data-key="proj">${inr(proj)}</div>
      <div class="bar ${ratio > 1 ? 'over' : ''}"><span style="width:${Math.min(100, ratio * 100)}%"></span></div>
      <div class="kpi-foot">${state.budget ? `<b class="${ratio > 1 ? 'red' : ''}">${(ratio * 100).toFixed(0)}%</b> of ${inr(state.budget)} budget` : 'Set a budget to track it'}</div>
    </div>
    <div class="card kpi link" data-go="analytics">
      <div class="kpi-label">${icon('sigma', 15)}Ledger integrity</div>
      <div class="kpi-value">${bf.n < 50 ? 'Pending' : ok ? 'Pass' : 'Review'}</div>
      <div class="kpi-foot"><span class="badge ${bf.n < 50 ? 'mute' : ok ? 'ok' : 'bad'}">${bf.n < 50 ? 'Needs 50+ payments' : ok ? 'Matches Benford' : 'Deviates from Benford'}</span>${bf.n >= 50 ? `χ² ${bf.chi.toFixed(1)}` : ''}</div>
      <div class="mini-digits">${bf.observed.map((o) => `<i style="height:${Math.max(6, (o / 0.32) * 100)}%"></i>`).join('')}</div>
    </div>`;

  renderTimeline();
  renderMonthChart();
  renderRisk(open);
  renderPriority(open);
  $('#notes').innerHTML = insights().map((n) => `<li><span class="ins-ic ${n.red ? 'red' : ''}">${icon(n.icon, 15)}</span><span>${n.html}</span></li>`).join('') || '<li><span class="ins-ic">' + icon('sparkle', 15) + '</span><span>Insights appear once there is something to analyse.</span></li>';
  renderCategories();
  $('#recurring').innerHTML = recurringHTML();
}

function sparkline(vals, w = 96, h = 34) {
  if (!vals.length) return '';
  const max = Math.max(1, ...vals), step = w / (vals.length - 1 || 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 6)).toFixed(1)}`);
  return `<svg class="kpi-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="M0,${h} L${pts.join(' L')} L${w},${h} Z" fill="var(--text-2)" opacity=".08"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--text-2)" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
}

function renderTimeline() {
  const days = dailySeries(182);
  if (!audit.tx.length) { $('#timeline').innerHTML = `<div class="empty">${icon('activity', 28)}<strong>No activity yet</strong></div>`; return; }
  const W = 1100, H = 150, T = 14, B = 24;
  const bw = W / days.length;
  const max = Math.max(1, ...days.map((d) => d.sum));
  const y = (v) => H - B - Math.sqrt(v / max) * (H - B - T);
  let body = `<line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="var(--border-2)"/>`;
  days.forEach((d, i) => {
    const x = i * bw;
    if (d.d.getDate() === 1) body += `<line x1="${x}" x2="${x}" y1="${T - 6}" y2="${H - B}" stroke="var(--border)" stroke-dasharray="2 3"/><text x="${x + 4}" y="${H - 7}" class="lbl">${MONTHS[d.d.getMonth()]}</text>`;
    const tip = `<b>${prettyDate(d.date)}</b><br>${inr(d.sum)} · ${plural(d.n, 'payment')}${d.flag ? `<br><span class="t-red">${d.flag} flagged · ${inr(d.flagAmt)}</span>` : ''}`;
    const h = H - B - y(d.sum);
    body += `<g class="hov" data-date="${d.date}" ${tipAttr(tip)}><rect class="hit" x="${x}" y="${T - 8}" width="${bw}" height="${H - B - T + 8}"/>`;
    if (d.sum) body += `<rect class="b" x="${x + bw * 0.18}" y="${y(d.sum)}" width="${Math.max(1, bw * 0.64)}" height="${h}" rx="1" fill="${d.flag ? 'var(--red)' : 'var(--ink)'}" opacity="${d.flag ? 1 : 0.55}"/>`;
    if (d.flag) body += `<circle cx="${x + bw / 2}" cy="${y(d.sum) - 6}" r="2.6" fill="var(--red)"/>`;
    body += '</g>';
  });
  $('#timeline').innerHTML = svgEl(W, H, body);
}

function renderMonthChart() {
  const { tx, byId } = audit;
  const today = startOfToday();
  const data = [5, 4, 3, 2, 1, 0].map((k) => {
    const d = new Date(today.getFullYear(), today.getMonth() - k, 1);
    const key = isoDate(d).slice(0, 7);
    const list = tx.filter((t) => t.date.startsWith(key));
    return { key, label: MONTHS[d.getMonth()], total: sum(list.map((t) => t.amount)), flagged: sum(list.filter((t) => isLive(byId.get(t.id))).map((t) => t.amount)), n: list.length };
  });
  data[5].proj = tx.length ? projectMonth(tx, byId) : 0;
  const W = 640, H = 250, L = 40, B = 26, T = 18;
  const max = Math.max(1, ...data.map((d) => Math.max(d.total, d.proj || 0)), state.budget || 0) * 1.1;
  const y = (v) => H - B - (v / max) * (H - B - T);
  const bw = (W - L) / 6;
  let body = '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-3)" stroke-width="1.3"/></pattern></defs>';
  for (let g = 0; g <= 4; g++) {
    const v = (max / 1.1) * (g / 4);
    body += `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)" ${g ? 'stroke-dasharray="2 4"' : ''}/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${kfmt(v)}</text>`;
  }
  data.forEach((d, i) => {
    const x = L + i * bw + bw * 0.22, w = bw * 0.56;
    const tip = `<b>${d.label}</b> · ${plural(d.n, 'payment')}<br>Spent ${inr(d.total)}${d.flagged ? `<br><span class="t-red">Under review ${inr(d.flagged)}</span>` : ''}${d.proj ? `<br><span class="t-mute">Projected ${inr(d.proj)}</span>` : ''}`;
    body += `<g class="hov" data-month="${d.key}" ${tipAttr(tip)}><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - B - T}" rx="6"/>`;
    if (d.proj && d.proj > d.total) body += `<rect x="${x}" y="${y(d.proj)}" width="${w}" height="${y(d.total) - y(d.proj)}" fill="url(#hatch)" stroke="var(--text-3)" stroke-dasharray="3 2" rx="3"/>`;
    if (d.total) body += `<rect class="b" x="${x}" y="${y(d.total)}" width="${w}" height="${H - B - y(d.total)}" fill="var(--ink)" rx="3"/>`;
    if (d.flagged) body += `<rect class="b" x="${x}" y="${y(d.total)}" width="${w}" height="${Math.max(3, H - B - y(d.flagged))}" fill="var(--red)" rx="3"/>`;
    const top = Math.max(d.total, d.proj || 0);
    if (top) body += `<text x="${x + w / 2}" y="${y(top) - 7}" text-anchor="middle" class="lbl">${kfmt(top)}</text>`;
    body += `<text x="${x + w / 2}" y="${H - 7}" text-anchor="middle" class="lbl">${d.label}</text></g>`;
  });
  if (state.budget) body += `<line x1="${L}" x2="${W}" y1="${y(state.budget)}" y2="${y(state.budget)}" stroke="var(--red)" stroke-dasharray="6 4" stroke-width="1.4"/><text x="${W}" y="${y(state.budget) - 6}" text-anchor="end" style="fill:var(--red-text)">budget ${kfmt(state.budget)}</text>`;
  $('#monthChart').innerHTML = svgEl(W, H, body);
}

function renderRisk(open) {
  if (!open.length) { $('#riskBreakdown').innerHTML = `<div class="empty">${icon('check', 28)}<strong>No open risk</strong>Everything has been reviewed.</div>`; return; }
  const segs = [['High', 'var(--red)'], ['Medium', 'var(--amber)'], ['Low', 'var(--green)']].map(([s, c]) => ({ s, c, n: open.filter((x) => x.sev === s).length, amt: sum(open.filter((x) => x.sev === s).map((x) => x.tx.amount)) }));
  const R = 50, C = 2 * Math.PI * R;
  let off = 0, arcs = '';
  for (const g of segs) {
    if (!g.n) continue;
    const len = (g.n / open.length) * C;
    arcs += `<circle cx="62" cy="62" r="${R}" fill="none" stroke="${g.c}" stroke-width="14" stroke-dasharray="${Math.max(0, len - 2)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 62 62)" ${tipAttr(`<b>${g.s}</b> · ${plural(g.n, 'case')}<br>${inr(g.amt)}`)}/>`;
    off += len;
  }
  const donut = `<svg class="donut" viewBox="0 0 124 124"><circle cx="62" cy="62" r="${R}" fill="none" stroke="var(--surface-3)" stroke-width="14"/>${arcs}<text x="62" y="60" text-anchor="middle" font-size="26" font-weight="600" fill="var(--text)">${open.length}</text><text x="62" y="78" text-anchor="middle" font-size="11" fill="var(--text-3)">open cases</text></svg>`;
  const counts = {};
  for (const c of open) for (const r of c.reasons) counts[r.rule] = (counts[r.rule] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mx = Math.max(1, ...top.map((x) => x[1]));
  $('#riskBreakdown').innerHTML = `<div class="donut-row">${donut}<div class="sev-legend">${segs.map((g) => `<div><span class="dotc" style="background:${g.c}"></span>${g.s}<b>${g.n}</b></div>`).join('')}</div></div>
    <div class="signals"><div class="ttl">Signals behind them</div>${top.map(([r, n]) => `<div class="signal">${icon(RULE_META[r].icon, 15)}<span>${RULE_META[r].title}</span><div class="bar"><span style="width:${(n / mx) * 100}%"></span></div><b>${n}</b></div>`).join('')}</div>`;
}

function renderPriority(open) {
  $('#priority').innerHTML = open.slice(0, 5).map((c) => `<div class="prow" data-case="${c.tx.id}">${avatar(c.tx.merchant)}<div><div class="t">${esc(c.tx.merchant)}</div><div class="s">${RULE_META[c.reasons[0].rule].title} · ${prettyDate(c.tx.date)}, ${esc(c.tx.time)}</div></div><span class="num amt">${inrExact(c.tx.amount)}</span>${riskPill(c)}${icon('chevron', 16)}</div>`).join('')
    || `<div class="empty">${icon('check', 28)}<strong>Queue is clear</strong>Nothing needs your attention.</div>`;
}

function insights() {
  const { tx, cases, recurring: rec, benford: bf, byId } = audit;
  const out = [];
  if (!tx.length) return out;
  const today = startOfToday();
  const proj = projectMonth(tx, byId);
  const prevTotals = [1, 2, 3].map((k) => isoDate(new Date(today.getFullYear(), today.getMonth() - k, 1)).slice(0, 7))
    .map((k) => sum(tx.filter((t) => t.date.startsWith(k)).map((t) => t.amount))).filter((x) => x > 0);
  const avg3 = mean(prevTotals);
  let s = `At this pace ${MONTHS[today.getMonth()]} closes near <b>${inr(proj)}</b>`;
  if (avg3) { const d = (proj / avg3 - 1) * 100; s += `, <b class="${d > 0 ? 'red' : ''}">${Math.abs(d).toFixed(0)}% ${d > 0 ? 'above' : 'below'}</b> your three-month average`; }
  if (state.budget && proj > state.budget) s += `, <b class="red">${inr(proj - state.budget)}</b> over budget`;
  out.push({ icon: 'target', html: s + '.', red: state.budget && proj > state.budget });
  const hi = cases.filter((c) => c.status === 'open' && c.sev === 'High');
  if (hi.length) out.push({ icon: 'alert', red: true, html: `<b class="red">${inr(sum(hi.map((c) => c.tx.amount)))}</b> sits in ${plural(hi.length, 'high-risk case')}. Start with <b>${esc(hi[0].tx.merchant)}</b>: ${esc(RULE_META[hi[0].reasons[0].rule].title.toLowerCase())}.` });
  if (rec.length) out.push({ icon: 'repeat', html: `${plural(rec.length, 'recurring charge')} (${rec.slice(0, 3).map((r) => esc(r.merchant)).join(', ')}${rec.length > 3 ? '…' : ''}) cost <b>${inr(sum(rec.map((r) => r.yearly)))}</b> a year.` });
  const daySum = Array(7).fill(0), hourSum = Array(24).fill(0);
  for (const t of tx) { daySum[weekdayIdx(new Date(t.date + 'T00:00'))] += t.amount; hourSum[+t.time.slice(0, 2)] += t.amount; }
  const pd = daySum.indexOf(Math.max(...daySum)), ph = hourSum.indexOf(Math.max(...hourSum));
  out.push({ icon: 'clock', html: `You spend the most on <b>${FULL_DAYS[pd]}s</b>, and your busiest hour is <b>${pad(ph)}:00–${pad((ph + 1) % 24)}:00</b>.` });
  const span = Math.max(1, new Set(tx.map((t) => t.date.slice(0, 7))).size);
  const top = DISCRETIONARY.map((c) => [c, sum(tx.filter((t) => t.category === c).map((t) => t.amount)) / span]).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1]) out.push({ icon: 'piggy', html: `${top[0]} is your largest flexible spend at about <b>${inr(top[1])}</b> a month. Trimming it by 15% saves <b>${inr(top[1] * 0.15 * 12)}</b> a year.` });
  return out;
}

function renderCategories() {
  const end = startOfToday().getTime() + 86400000;
  const win = (a, b) => audit.tx.filter((t) => ts(t) < end - a * 86400000 && ts(t) >= end - b * 86400000);
  const cur = groupBy(win(0, 30), (t) => t.category), prev = groupBy(win(30, 60), (t) => t.category);
  const rows = CATEGORIES.map((c) => ({ c, cur: sum((cur[c] || []).map((t) => t.amount)), prev: sum((prev[c] || []).map((t) => t.amount)) })).filter((r) => r.cur || r.prev).sort((a, b) => b.cur - a.cur);
  if (!rows.length) { $('#catBreakdown').innerHTML = `<div class="empty">${icon('chart', 28)}<strong>No recent spending</strong></div>`; return; }
  const mx = Math.max(1, ...rows.map((r) => r.cur));
  const total = sum(rows.map((r) => r.cur));
  $('#catBreakdown').innerHTML = `<div class="cats">${rows.map((r) => {
    const ch = r.prev ? (r.cur / r.prev - 1) * 100 : 0;
    const cls = !r.prev || Math.abs(ch) < 5 ? 'flat' : ch > 0 ? 'up' : 'down';
    return `<div class="catrow" data-cat="${r.c}" ${tipAttr(`<b>${r.c}</b><br>${inr(r.cur)} (${total ? ((r.cur / total) * 100).toFixed(0) : 0}% of spend)<br><span class="t-mute">Previous 30 days ${inr(r.prev)}</span>`)}>${catPill(r.c)}<div class="bar" style="--c:${CAT_COLOR[r.c]}"><span style="width:${(r.cur / mx) * 100}%"></span></div><span class="num">${inr(r.cur)}</span><span class="chg ${cls}">${!r.prev ? 'new' : cls === 'flat' ? '±0%' : `${ch > 0 ? '+' : ''}${ch.toFixed(0)}%`}</span></div>`;
  }).join('')}</div>`;
}

function recurringHTML() {
  const rec = audit.recurring;
  if (!rec.length) return `<div class="empty">${icon('repeat', 28)}<strong>No recurring charges yet</strong>They appear after three months of history.</div>`;
  return `<div class="rows">${rec.map((r) => `<div class="row">${avatar(r.merchant)}<div><div class="t">${esc(r.merchant)}</div><div class="s">Monthly · ${inrExact(r.amount)}</div></div><div class="r"><span class="num">${inr(r.yearly)}</span><span class="s">per year</span></div></div>`).join('')}</div>
    <div class="totalrow"><span>Total committed per year</span><b>${inr(sum(rec.map((r) => r.yearly)))}</b></div>`;
}

// ═══════════════ Cases ═══════════════
function caseList() {
  return audit.cases.filter((c) => c.status === ui.caseTab && (ui.sev === 'all' || (ui.sev === 'High' ? c.sev === 'High' : c.sev !== 'Low')));
}
function renderCases() {
  const counts = { open: 0, confirmed: 0, dismissed: 0 };
  audit.cases.forEach((c) => counts[c.status]++);
  $$('#caseTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === ui.caseTab);
    b.innerHTML = `${TAB_LABEL[b.dataset.tab]}<span class="n">${counts[b.dataset.tab]}</span>`;
  });
  $$('#sevChips button').forEach((b) => b.classList.toggle('on', b.dataset.sev === ui.sev));
  const list = caseList();
  if (!list.some((c) => c.tx.id === ui.sel)) ui.sel = list[0]?.tx.id || null;
  $('#caseList').innerHTML = list.map((c) => `<div class="citem ${c.tx.id === ui.sel ? 'on' : ''}" data-pick="${c.tx.id}">${avatar(c.tx.merchant)}<div><div class="t">${esc(c.tx.merchant)}</div><div class="s">${RULE_META[c.reasons[0].rule].title} · ${prettyDate(c.tx.date)}</div></div><div class="r"><span class="num">${inrExact(c.tx.amount)}</span>${riskPill(c)}</div></div>`).join('')
    || `<div class="empty">${icon('check', 28)}<strong>No cases here</strong>${ui.caseTab === 'open' ? 'The ledger looks clean.' : ''}</div>`;
  renderCaseDetail(audit.byId.get(ui.sel));
}

function gauge(score, sev) {
  const R = 62, cx = 80, cy = 78, C = Math.PI * R;
  const col = sev === 'High' ? 'var(--red)' : sev === 'Medium' ? 'var(--amber)' : 'var(--green)';
  const arc = `M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`;
  let ticks = '';
  for (const v of [35, 60]) {
    const a = Math.PI * (1 - v / 100);
    ticks += `<line x1="${cx + (R - 12) * Math.cos(a)}" y1="${cy - (R - 12) * Math.sin(a)}" x2="${cx + (R + 9) * Math.cos(a)}" y2="${cy - (R + 9) * Math.sin(a)}" stroke="var(--surface)" stroke-width="2.5"/>`;
  }
  return `<svg class="gauge" viewBox="0 0 160 96"><path d="${arc}" fill="none" stroke="var(--surface-3)" stroke-width="13" stroke-linecap="round"/><path class="arc" d="${arc}" fill="none" stroke="${col}" stroke-width="13" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - score / 100)}"/>${ticks}<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="32" font-weight="600" fill="var(--text)">${score}</text><text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="11.5" fill="var(--text-3)">${sev} risk</text></svg>`;
}

function contextPlot(c) {
  const list = audit.tx.filter((t) => t.category === c.tx.category);
  if (list.length < 5) return '<p class="muted">Not enough history in this category to compare yet.</p>';
  const W = 600, H = 112, L = 10, R = 10, base = 84;
  const logs = list.map((t) => Math.log10(t.amount));
  const lo = Math.min(...logs) - 0.08, hi = Math.max(...logs) + 0.08;
  const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R);
  const med = audit.stats[c.tx.category].med;
  let body = `<line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" stroke="var(--border-2)"/>`;
  for (const v of [10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5]) {
    const lv = Math.log10(v);
    if (lv < lo || lv > hi) continue;
    body += `<line x1="${x(v)}" x2="${x(v)}" y1="${base}" y2="${base + 4}" stroke="var(--border-2)"/><text x="${x(v)}" y="${base + 17}" text-anchor="middle">${kfmt(v)}</text>`;
  }
  for (const t of list) {
    if (t.id === c.tx.id) continue;
    const jit = (hue(t.id) % 33) - 16;
    const live = isLive(audit.byId.get(t.id));
    body += `<circle cx="${x(t.amount)}" cy="${56 + jit}" r="3.2" fill="${live ? 'var(--red)' : 'var(--text-3)'}" opacity="${live ? 0.6 : 0.32}" ${tipAttr(`${esc(t.merchant)} · ${inrExact(t.amount)}<br><span class="t-mute">${prettyDate(t.date)}</span>`)}/>`;
  }
  body += `<line x1="${x(med)}" x2="${x(med)}" y1="22" y2="${base}" stroke="var(--text-2)" stroke-dasharray="3 3"/><text x="${x(med)}" y="14" text-anchor="middle" style="fill:var(--text-2)">usual ${inr(med)}</text>`;
  const cx = x(c.tx.amount), anchor = cx > W * 0.75 ? 'end' : cx < W * 0.25 ? 'start' : 'middle';
  body += `<line x1="${cx}" x2="${cx}" y1="30" y2="${base}" stroke="var(--red)" stroke-width="1.5"/><circle cx="${cx}" cy="56" r="7" fill="var(--red)" stroke="var(--surface)" stroke-width="2.5"/><text x="${cx + (anchor === 'end' ? -10 : anchor === 'start' ? 10 : 0)}" y="26" text-anchor="${anchor}" style="fill:var(--red-text);font-weight:600">this ${inrExact(c.tx.amount)}</text>`;
  return svgEl(W, H + 6, body);
}

function renderCaseDetail(c) {
  const el = $('#caseDetail');
  if (!c) { el.innerHTML = `<div class="empty" style="padding:80px 20px">${icon('shield', 36)}<strong>Select a case</strong>Pick a flagged payment on the left to see its evidence.</div>`; return; }
  const t = c.tx;
  const related = audit.tx.filter((x) => x.merchant.toLowerCase() === t.merchant.toLowerCase() && Math.abs(ts(x) - ts(t)) <= 7 * 86400000).slice(-7);
  const s = audit.stats[t.category];
  const stack = c.reasons.map((r) => `<span style="flex:${r.weight}" ${tipAttr(`${RULE_META[r.rule].title} +${r.weight}`)}></span>`).join('');
  const statusPill = c.status === 'open' ? '<span class="pill plain">Open</span>' : c.status === 'confirmed' ? '<span class="sev fraud">Confirmed fraud</span>' : '<span class="sev cleared">Cleared</span>';
  el.innerHTML = `
    <div class="cd-head">
      ${avatar(t.merchant, 'lg')}
      <div class="cd-title">
        <div class="eyebrow">CASE ${String(c.no).padStart(3, '0')} ${statusPill}</div>
        <h2>${esc(t.merchant)}</h2>
        <div class="meta">${catPill(t.category)}<span>${icon('calendar', 14)}</span>${prettyDate(t.date)}, ${esc(t.time)}<span>·</span>${esc(t.method)}${t.note ? `<span>·</span>“${esc(t.note)}”` : ''}</div>
      </div>
      <div class="cd-amt"><span class="num">${inrExact(t.amount)}</span><span>${s ? `${(t.amount / s.med).toFixed(1)}× your usual ${t.category}` : ''}</span></div>
    </div>
    <div class="cd-body">
      <div class="cd-score">
        ${gauge(c.score, c.sev)}
        <div style="width:100%"><div class="ttl" style="text-align:left">Score build-up</div><div class="stack">${stack}</div></div>
        <p>${plural(c.reasons.length, 'independent signal')} combined. High starts at 60.</p>
      </div>
      <div class="cd-main">
        <div><div class="ttl">Why it was flagged</div><div class="evidence">${c.reasons.map((r, i) => `<div class="ev ${i === 0 ? 'top' : ''}" style="animation-delay:${i * 60}ms"><span class="ev-ic">${icon(RULE_META[r.rule].icon, 17)}</span><div><div class="t">${RULE_META[r.rule].title}</div><div class="d">${esc(r.text)}</div></div><span class="w">+${r.weight}</span></div>`).join('')}</div></div>
        <div class="context"><div class="ttl">Against every ${esc(t.category)} payment you've made</div>${contextPlot(c)}</div>
        <div><div class="ttl">${esc(t.merchant)} within a week of this payment</div><table class="related">${related.map((x) => { const rc = audit.byId.get(x.id); return `<tr class="${x.id === t.id ? 'self' : ''}"><td>${prettyDate(x.date)} · ${esc(x.time)}</td><td>${esc(x.method)}</td><td class="r num">${inrExact(x.amount)}</td><td class="r">${riskPill(rc)}</td></tr>`; }).join('')}</table></div>
      </div>
    </div>
    <div class="cd-actions">
      <span class="hint">${icon('eye', 14)} Your decision trains Redline</span>
      ${c.status === 'open'
        ? `<button class="btn ghost" data-act="dismiss" data-id="${t.id}">${icon('check', 15)}Legitimate, trust payee <kbd>L</kbd></button><button class="btn danger" data-act="confirm" data-id="${t.id}">${icon('flag', 15)}Confirm fraud <kbd>F</kbd></button>`
        : `<button class="btn ghost" data-act="reopen" data-id="${t.id}">${icon('repeat', 15)}Reopen case</button>`}
    </div>`;
}

function caseAction(act, id) {
  const c = audit.byId.get(id);
  if (!c) return;
  const before = caseList().map((x) => x.tx.id);
  const idx = before.indexOf(id);
  state.dismissed = state.dismissed.filter((x) => x !== id);
  state.confirmed = state.confirmed.filter((x) => x !== id);
  const m = c.tx.merchant;
  if (act === 'confirm') { state.confirmed.push(id); toast(`Case ${c.no} confirmed as fraud. It stays in the exported report.`, true); }
  if (act === 'dismiss') {
    state.dismissed.push(id);
    if (!state.trusted.some((x) => x.toLowerCase() === m.toLowerCase())) state.trusted.push(m);
    toast(`Cleared. Redline now trusts ${m}.`, false, { label: 'Undo', fn: () => { state.dismissed = state.dismissed.filter((x) => x !== id); state.trusted = state.trusted.filter((x) => x.toLowerCase() !== m.toLowerCase()); ui.sel = id; save(); render(); } });
  }
  if (act === 'reopen') { state.trusted = state.trusted.filter((x) => x.toLowerCase() !== m.toLowerCase()); toast(`Case ${c.no} reopened.`); }
  save();
  audit = runAudit();
  const after = caseList();
  if (!after.some((x) => x.tx.id === id)) ui.sel = (after[Math.min(idx, after.length - 1)] || {}).tx?.id || null;
  render();
}

function openCase(id) {
  const c = audit.byId.get(id);
  if (!c) return;
  ui.caseTab = c.status; ui.sev = 'all'; ui.sel = id;
  if (location.hash !== '#cases') location.hash = '#cases';
  renderCases();
}

// ═══════════════ Transactions ═══════════════
function filteredTx() {
  const f = ui.f;
  return [...audit.tx].reverse().filter((t) => {
    if (f.cat && t.category !== f.cat) return false;
    if (f.q && !`${t.merchant} ${t.note}`.toLowerCase().includes(f.q)) return false;
    if (f.flag && !isLive(audit.byId.get(t.id))) return false;
    if (f.month && !t.date.startsWith(f.month)) return false;
    if (f.date && t.date !== f.date) return false;
    if (f.dow != null && weekdayIdx(new Date(t.date + 'T00:00')) !== f.dow) return false;
    if (f.hour != null && +t.time.slice(0, 2) !== f.hour) return false;
    return true;
  });
}
function renderTransactions() {
  const list = filteredTx();
  const f = ui.f;
  const chips = [];
  if (f.month) { const [y, m] = f.month.split('-'); chips.push(['month', `${MONTHS[+m - 1]} ${y}`]); }
  if (f.date) chips.push(['date', prettyDate(f.date)]);
  if (f.dow != null) chips.push(['dow', `${FULL_DAYS[f.dow]}s, ${pad(f.hour)}:00`]);
  $('#filterChips').innerHTML = chips.map(([k, l]) => `<button class="fchip" data-clearf="${k}">${l}${icon('x', 13)}</button>`).join('');
  const total = sum(list.map((t) => t.amount));
  const flagged = list.filter((t) => isLive(audit.byId.get(t.id))).length;
  $('#txSub').innerHTML = `${plural(list.length, 'payment')} · ${inr(total)}${flagged ? ` · <b class="red">${flagged} flagged</b>` : ''}`;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  ui.txPage = Math.min(ui.txPage, pages - 1);
  const rows = list.slice(ui.txPage * PAGE_SIZE, (ui.txPage + 1) * PAGE_SIZE);
  $('#txBody').innerHTML = rows.map((t) => {
    const c = audit.byId.get(t.id);
    return `<tr class="${isLive(c) ? `sev-${c.sev} flagged` : c ? 'flagged' : ''}" ${c ? `data-case="${t.id}"` : ''}>
      <td><div class="merch">${avatar(t.merchant)}<div><div class="t">${esc(t.merchant)}</div>${t.note ? `<div class="s">${esc(t.note)}</div>` : ''}</div></div></td>
      <td>${catPill(t.category)}</td>
      <td class="dt">${prettyDate(t.date)}<span>${esc(t.time)}</span></td>
      <td class="dt">${esc(t.method)}</td>
      <td class="r amt">${inrExact(t.amount)}</td>
      <td class="r">${riskPill(c)}</td>
      <td class="r"><button class="del" data-del="${t.id}" title="Delete">${icon('trash', 15)}</button></td></tr>`;
  }).join('') || `<tr><td colspan="7"><div class="empty">${icon('search', 28)}<strong>No payments match</strong>Try clearing a filter.</div></td></tr>`;
  $('#pager').innerHTML = `<span>${list.length ? `Showing ${ui.txPage * PAGE_SIZE + 1}–${Math.min(list.length, (ui.txPage + 1) * PAGE_SIZE)} of ${list.length}` : 'Nothing to show'}</span>
    <div><button class="btn ghost sm" data-pg="-1" ${ui.txPage === 0 ? 'disabled' : ''}>${icon('left', 14)}Previous</button><button class="btn ghost sm" data-pg="1" ${ui.txPage >= pages - 1 ? 'disabled' : ''}>Next${icon('chevron', 14)}</button></div>`;
}
function showTx(patch) {
  ui.f = { ...ui.f, month: null, date: null, dow: null, hour: null, ...patch };
  ui.txPage = 0;
  if (patch.cat !== undefined) $('#catFilter').value = patch.cat;
  location.hash = '#transactions';
  renderTransactions();
}

// ═══════════════ Analytics ═══════════════
function renderAnalytics() {
  const bf = audit.benford;
  const ok = bf.chi < 15.51;
  $('#benfordBadge').innerHTML = bf.n < 50 ? '<span class="badge mute">Needs 50+ payments</span>' : `<span class="badge ${ok ? 'ok' : bf.chi < 20.09 ? 'warn' : 'bad'}">${bf.verdict}</span>`;
  const W = 600, H = 240, B = 26, T = 14, L = 34;
  const max = 0.36;
  const y = (v) => H - B - (v / max) * (H - B - T);
  const bw = (W - L) / 9;
  let body = '';
  for (const g of [0, 0.1, 0.2, 0.3]) body += `<line x1="${L}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="var(--border)" ${g ? 'stroke-dasharray="2 4"' : ''}/><text x="${L - 8}" y="${y(g) + 4}" text-anchor="end">${g * 100}%</text>`;
  const pts = [];
  bf.observed.forEach((o, i) => {
    const x = L + i * bw + bw * 0.24, w = bw * 0.52;
    const diff = o - bf.expected[i];
    const tip = `<b>Leading digit ${i + 1}</b><br>Your ledger ${(o * 100).toFixed(1)}%<br><span class="t-mute">Benford ${(bf.expected[i] * 100).toFixed(1)}%</span>`;
    body += `<g class="hov" ${tipAttr(tip)}><rect class="hit" x="${L + i * bw}" y="${T}" width="${bw}" height="${H - B - T}" rx="6"/><rect class="b" x="${x}" y="${y(o)}" width="${w}" height="${H - B - y(o)}" rx="3" fill="${diff > 0.03 ? 'var(--red)' : 'var(--ink)'}" opacity="${bf.n ? 0.9 : 0.15}"/><text x="${x + w / 2}" y="${H - 7}" text-anchor="middle" class="lbl">${i + 1}</text></g>`;
    pts.push([x + w / 2, y(bf.expected[i])]);
  });
  body += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--text-2)" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none"/>`;
  pts.forEach(([cx, cy]) => { body += `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--surface)" stroke="var(--text-2)" stroke-width="1.8" pointer-events="none"/>`; });
  $('#benfordChart').innerHTML = svgEl(W, H, body);
  $('#benfordStats').innerHTML = `<div class="kv"><div><span>Payments</span><b>${bf.n}</b></div><div><span>χ² (crit. 15.5)</span><b>${bf.chi.toFixed(1)}</b></div><div><span>MAD</span><b>${bf.mad.toFixed(3)}</b></div></div>
    <table class="stats"><tr><th>Digit</th><th>Observed</th><th>Expected</th><th>Diff</th></tr>${bf.observed.map((o, i) => { const d = (o - bf.expected[i]) * 100; return `<tr><td>${i + 1}</td><td>${(o * 100).toFixed(1)}%</td><td>${(bf.expected[i] * 100).toFixed(1)}%</td><td class="${d > 3 ? 'hi' : d < -3 ? 'lo' : ''}">${d > 0 ? '+' : ''}${d.toFixed(1)}</td></tr>`; }).join('')}</table>`;
  renderHeatmap();
  renderPlanner();
  $('#patterns').innerHTML = audit.patterns.length
    ? `<div class="rows">${audit.patterns.map((p) => `<div class="row" data-cat="${p.cat}" style="cursor:pointer"><span class="ins-ic red">${icon('activity', 15)}</span><div><div class="t">${p.cat} is surging</div><div class="s">${inr(p.cur)} in the last 30 days against a usual ${inr(p.base)}</div></div><div class="r"><span class="sev High">${p.ratio.toFixed(1)}×</span></div></div>`).join('')}</div>`
    : `<div class="empty">${icon('activity', 28)}<strong>No surges</strong>Every category is within its usual range.</div>`;
}

function renderHeatmap() {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const amt = Array.from({ length: 7 }, () => Array(24).fill(0));
  const flagged = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of audit.tx) {
    const d = weekdayIdx(new Date(t.date + 'T00:00')), h = +t.time.slice(0, 2);
    grid[d][h]++; amt[d][h] += t.amount;
    if (isLive(audit.byId.get(t.id))) flagged[d][h]++;
  }
  const max = Math.max(1, ...grid.flat());
  const cs = 34, L = 44, T = 22, W = L + 24 * cs, H = T + 7 * cs;
  let body = '';
  for (let h = 0; h < 24; h += 3) body += `<text x="${L + h * cs + cs / 2}" y="12" text-anchor="middle">${pad(h)}:00</text>`;
  for (let d = 0; d < 7; d++) {
    body += `<text x="${L - 10}" y="${T + d * cs + cs / 2 + 4}" text-anchor="end" class="lbl">${DAYS[d]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const op = v ? 0.1 + 0.9 * Math.sqrt(v / max) : 0;
      const tip = `<b>${FULL_DAYS[d]}s, ${pad(h)}:00–${pad((h + 1) % 24)}:00</b><br>${plural(v, 'payment')} · ${inr(amt[d][h])}${flagged[d][h] ? `<br><span class="t-red">${flagged[d][h]} flagged</span>` : ''}`;
      body += `<rect class="cell" data-heat="${d},${h}" ${tipAttr(tip)} x="${L + h * cs + 2}" y="${T + d * cs + 2}" width="${cs - 4}" height="${cs - 4}" rx="5" fill="${v ? `rgba(var(--heat), ${op.toFixed(2)})` : 'var(--surface-2)'}" stroke="var(--border)" stroke-width="${v ? 0 : 1}"/>`;
      if (flagged[d][h]) body += `<circle cx="${L + h * cs + cs / 2}" cy="${T + d * cs + cs / 2}" r="${cs / 2 - 4}" fill="none" stroke="var(--red)" stroke-width="2.4" pointer-events="none"/>`;
    }
  }
  $('#heatmap').innerHTML = svgEl(W, H, body);
}

function plannerBase() {
  const end = startOfToday().getTime() + 86400000;
  const recent = audit.tx.filter((t) => ts(t) > end - 90 * 86400000 && !isLive(audit.byId.get(t.id)));
  return DISCRETIONARY.map((c) => ({ c, avg: sum(recent.filter((t) => t.category === c).map((t) => t.amount)) / 3 }));
}
function renderPlanner() {
  const base = plannerBase();
  if (!audit.tx.length) { $('#planner').innerHTML = `<div class="empty">${icon('piggy', 28)}<strong>Nothing to plan yet</strong></div>`; return; }
  $('#planner').innerHTML = `<div class="plan">${base.map((b) => `<div class="plan-row">
      <div>${catPill(b.c)}<span class="avg">${inr(b.avg)}/mo now</span></div>
      <input type="range" min="0" max="50" step="5" value="${ui.plan[b.c] ?? 10}" data-plan="${b.c}" style="--p:${((ui.plan[b.c] ?? 10) / 50) * 100}%" aria-label="Cut ${b.c}" />
      <span class="pc" data-pc="${b.c}">${ui.plan[b.c] ?? 10}%</span>
      <output data-out="${b.c}">${inr((b.avg * (ui.plan[b.c] ?? 10)) / 100)}/mo</output></div>`).join('')}
    <div class="plan-total"><div><span>You would save</span><b id="planYear">₹0</b><span>per year</span></div><div class="side"><span>per month</span><b id="planMonth" style="font-size:18px">₹0</b></div></div></div>`;
  updatePlanner();
}
function updatePlanner() {
  const base = plannerBase();
  let m = 0;
  for (const b of base) {
    const p = ui.plan[b.c] ?? 10;
    m += (b.avg * p) / 100;
    const out = document.querySelector(`[data-out="${b.c}"]`);
    if (out) out.textContent = `${inr((b.avg * p) / 100)}/mo`;
    const pc = document.querySelector(`[data-pc="${b.c}"]`);
    if (pc) pc.textContent = `${p}%`;
  }
  if ($('#planYear')) { $('#planYear').textContent = inr(m * 12); $('#planMonth').textContent = inr(m); }
}

// ═══════════════ Methods ═══════════════
function renderMethods() {
  $('#limitInput').value = state.limit;
  $('#sensInput').value = state.sens;
  $('#sensInput').style.setProperty('--p', `${((state.sens - 1) / 4) * 100}%`);
  $('#sensLabel').textContent = `${SENS_LABEL[state.sens - 1]} · z > ${SENS_Z[state.sens - 1]}`;
  $('#budgetInput').value = state.budget || '';
  $('#budget').value = state.budget || '';
  const open = audit.cases.filter((c) => c.status === 'open').length;
  $('#tuneResult').textContent = `${plural(open, 'open case')} at these settings`;
  const hits = {};
  for (const c of audit.cases) for (const r of c.reasons) hits[r.rule] = (hits[r.rule] || 0) + 1;
  const L = inr(APPROVAL_LIMIT);
  const rules = [
    ['outlier', '+30 to 55', `Median and median absolute deviation of log-amounts per category, so one huge charge can't hide by inflating the average. Flags a modified z-score above ${SENS_Z[state.sens - 1]}.`],
    ['duplicate', '+55', 'Same merchant and the same amount within 48 hours (2 hours for amounts under ₹500).'],
    ['split', '+45', `Two or more same-day charges at one merchant, each under ${L} but adding up to more than it.`],
    ['threshold', '+35', `Amounts in the last 5% below the ${L} approval limit, a classic expense-fraud tell.`],
    ['offhours', '+25', 'Large payments in an hour that holds less than 2% of your history. Learned from you, not hard-coded.'],
    ['newpayee', '+25', 'First-ever payment to a merchant, above your 90th percentile for that category. Starts after 3 weeks of history.'],
    ['round', '+10', '₹1,000 or more and a multiple of ₹500. A weak signal that only adds to others.'],
  ];
  $('#methods').innerHTML = rules.map(([k, w, d]) => `<div class="card method"><div class="method-top"><span class="ev-ic">${icon(RULE_META[k].icon, 17)}</span><span class="w">${w}</span></div><h3>${RULE_META[k].title}</h3><p>${d}</p><div class="hits">Fired on <b>${hits[k] || 0}</b> ${(hits[k] || 0) === 1 ? 'case' : 'cases'} in your ledger</div></div>`).join('')
    + `<div class="card method"><div class="method-top"><span class="ev-ic">${icon('activity', 17)}</span><span class="w mute">pattern</span></div><h3>Category surge</h3><p>Last 30 days against the mean of the three prior 30-day windows. Flags 1.6× or more.</p><div class="hits">Active surges: <b>${audit.patterns.length}</b></div></div>`
    + `<div class="card method"><div class="method-top"><span class="ev-ic">${icon('sigma', 17)}</span><span class="w mute">ledger</span></div><h3>Benford's law</h3><p>Leading-digit distribution tested with Pearson's χ² (8 df) against log₁₀(1 + 1/d). Critical value 15.51 at p = 0.05.</p><div class="hits">Current χ²: <b>${audit.benford.chi.toFixed(1)}</b></div></div>`
    + `<div class="card method"><div class="method-top"><span class="ev-ic">${icon('repeat', 17)}</span><span class="w mute">learning</span></div><h3>Feedback loop</h3><p>Clearing a case adds the merchant to a trusted list, which skips timing, unknown-payee and round-amount checks for it.</p><div class="hits">Trusted merchants: <b>${state.trusted.length}</b></div></div>`;
}

// ═══════════════ quick add preview ═══════════════
function renderPreview() {
  const v = $('#cmd').value.trim();
  const box = $('#cmdPreview');
  if (!v) { box.classList.remove('show'); box.innerHTML = ''; return; }
  const p = parseEntry(v);
  const cell = (k, val, miss = '') => `<div><span class="k">${k}</span><span class="v ${val ? '' : 'miss'}">${val ? esc(val) : miss}</span></div>`;
  box.innerHTML = `<div class="qp-grid">${cell('Amount', p.amount && inrExact(p.amount), 'Missing')}${cell('Payee', p.merchant, 'Missing')}${cell('Category', p.category, 'Unknown')}${cell('Date', prettyDate(p.date || isoDate(startOfToday())))}${cell('Time', p.time || 'Now')}${cell('Paid with', p.method || 'UPI')}</div>
    <div class="qp-foot"><span>${p.source ? `Category ${esc(p.source)}` : 'Type an amount and a payee'}</span><span>Press <kbd>Enter</kbd> to add and audit</span></div>`;
  box.classList.add('show');
}

// ───────────── toast & tooltip ─────────────
let toastTimer;
function toast(msg, alert = false, action = null) {
  const el = $('#toast');
  el.innerHTML = `<span class="ti">${icon(alert ? 'alert' : 'check', 14)}</span><span>${esc(msg)}</span>${action ? `<button class="tbtn">${esc(action.label)}</button>` : ''}`;
  el.className = 'toast show' + (alert ? ' alert' : '');
  if (action) el.querySelector('.tbtn').onclick = () => { el.className = 'toast'; action.fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), action ? 6500 : 4200);
}
function initTooltip() {
  const tip = $('#tip');
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tip.classList.remove('show'); return; }
    if (tip.dataset.src !== t.dataset.tip) { tip.innerHTML = t.dataset.tip; tip.dataset.src = t.dataset.tip; }
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    tip.classList.add('show');
  });
  document.addEventListener('scroll', () => tip.classList.remove('show'), true);
}

// ───────────── routing & theme ─────────────
function route() {
  const p = location.hash.slice(1);
  ui.page = PAGES.includes(p) ? p : 'overview';
  $$('.page').forEach((s) => (s.hidden = s.dataset.page !== ui.page));
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === ui.page));
  $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show');
  window.scrollTo(0, 0);
}
function applyTheme() {
  if (!['light', 'dark'].includes(state.theme)) state.theme = 'light';
  document.documentElement.dataset.theme = state.theme;
  $('#themeLabel').textContent = state.theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('#themeIcon').innerHTML = icon(state.theme === 'dark' ? 'sun' : 'moon');
}

// ═══════════════ wiring ═══════════════
function init() {
  load();
  if (!state.limit) state.limit = 5000;
  if (!state.sens) state.sens = 3;
  hydrateIcons();
  applyTheme();
  initTooltip();
  const now = new Date();
  $('#today').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const catOpts = CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  $('#catFilter').insertAdjacentHTML('beforeend', catOpts);
  $('#expForm [name=category]').insertAdjacentHTML('beforeend', catOpts);

  // quick add
  $('#cmd').addEventListener('input', renderPreview);
  $('#cmd').addEventListener('focus', renderPreview);
  $('#cmd').addEventListener('blur', () => setTimeout(() => $('#cmdPreview').classList.remove('show'), 150));
  $('#cmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitEntry();
    if (e.key === 'Escape') { $('#cmd').value = ''; renderPreview(); $('#cmd').blur(); }
  });

  // dialog
  const dlg = $('#entryDialog');
  $('#btnNew').addEventListener('click', () => {
    $('#expForm').reset();
    $('#expForm [name=date]').value = isoDate(new Date());
    $('#expForm [name=time]').value = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
    dlg.showModal();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  $('#expForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.category) f.category = categorize(f.merchant, f.note).category;
    dlg.close();
    addTx({ ...f, merchant: f.merchant.trim(), amount: +f.amount });
  });

  // top actions
  $('#btnDemo').addEventListener('click', () => {
    if (state.tx.length && !confirm('Replace your current ledger with six months of sample data?')) return;
    state = { ...state, tx: generateSample(), dismissed: [], confirmed: [], trusted: [] };
    ui.sel = null; save(); render();
    toast(`Sample data loaded: ${audit.tx.length} payments, ${audit.cases.filter((c) => c.status === 'open').length} flagged.`, true);
  });
  $('#btnClear').addEventListener('click', () => {
    if (!state.tx.length) return;
    const snap = JSON.stringify(state);
    state = { ...state, tx: [], dismissed: [], confirmed: [], trusted: [] };
    save(); render();
    toast('Ledger cleared.', false, { label: 'Undo', fn: () => { state = JSON.parse(snap); save(); render(); } });
  });
  $('#btnExport').addEventListener('click', exportCSV);
  $('#btnPrint').addEventListener('click', () => window.print());
  $('#btnTheme').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; save(); applyTheme(); render(); });
  $('#csvInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) file.text().then((txt) => { importCSV(txt); location.hash = '#overview'; });
    e.target.value = '';
  });
  $('#menuBtn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
  $('#scrim').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); });

  // settings
  const setBudget = (v) => { state.budget = Math.max(0, +v || 0); save(); render(); };
  $('#budget').addEventListener('change', (e) => setBudget(e.target.value));
  $('#budgetInput').addEventListener('change', (e) => setBudget(e.target.value));
  $('#limitInput').addEventListener('change', (e) => { state.limit = Math.max(500, +e.target.value || 5000); save(); render(); toast(`Approval limit set to ${inr(state.limit)}. Audit re-run.`); });
  $('#sensInput').addEventListener('input', (e) => { state.sens = +e.target.value; save(); render(); });

  // cases controls
  $('#caseTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { ui.caseTab = b.dataset.tab; ui.sel = null; renderCases(); } });
  $('#sevChips').addEventListener('click', (e) => { const b = e.target.closest('[data-sev]'); if (b) { ui.sev = b.dataset.sev; ui.sel = null; renderCases(); } });

  // table controls
  $('#search').addEventListener('input', (e) => { ui.f.q = e.target.value.trim().toLowerCase(); ui.txPage = 0; renderTransactions(); });
  $('#catFilter').addEventListener('change', (e) => { ui.f.cat = e.target.value; ui.txPage = 0; renderTransactions(); });
  $('#onlyFlagged').addEventListener('change', (e) => { ui.f.flag = e.target.checked; ui.txPage = 0; renderTransactions(); });

  // planner sliders
  $('#planner').addEventListener('input', (e) => {
    const r = e.target.closest('[data-plan]');
    if (!r) return;
    ui.plan[r.dataset.plan] = +r.value;
    r.style.setProperty('--p', `${(r.value / 50) * 100}%`);
    updatePlanner();
  });

  // delegated clicks
  document.addEventListener('click', (e) => {
    const t = e.target;
    let el;
    if ((el = t.closest('[data-del]'))) {
      e.stopPropagation();
      const tx = state.tx.find((x) => x.id === el.dataset.del);
      state.tx = state.tx.filter((x) => x.id !== el.dataset.del);
      save(); render();
      if (tx) toast(`Deleted ${tx.merchant} ${inrExact(tx.amount)}.`, false, { label: 'Undo', fn: () => { state.tx.push(tx); save(); render(); } });
      return;
    }
    if ((el = t.closest('[data-act]'))) return caseAction(el.dataset.act, el.dataset.id);
    if ((el = t.closest('[data-pick]'))) { ui.sel = el.dataset.pick; renderCases(); return; }
    if ((el = t.closest('[data-case]'))) return openCase(el.dataset.case);
    if ((el = t.closest('[data-go]'))) { location.hash = '#' + el.dataset.go; return; }
    if ((el = t.closest('[data-month]'))) return showTx({ month: el.dataset.month });
    if ((el = t.closest('[data-date]'))) return showTx({ date: el.dataset.date });
    if ((el = t.closest('[data-heat]'))) { const [d, h] = el.dataset.heat.split(',').map(Number); return showTx({ dow: d, hour: h }); }
    if ((el = t.closest('[data-cat]'))) { ui.f.cat = el.dataset.cat; return showTx({ cat: el.dataset.cat }); }
    if ((el = t.closest('[data-clearf]'))) {
      const k = el.dataset.clearf;
      if (k === 'dow') { ui.f.dow = null; ui.f.hour = null; } else ui.f[k] = null;
      ui.txPage = 0; renderTransactions(); return;
    }
    if ((el = t.closest('[data-pg]'))) { ui.txPage += +el.dataset.pg; renderTransactions(); $('.table-wrap').scrollIntoView({ block: 'nearest' }); }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || $('#entryDialog').open;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('#cmd').focus(); return; }
    if (ui.page !== 'cases') return;
    const list = caseList(), i = list.findIndex((c) => c.tx.id === ui.sel);
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const n = list[Math.min(list.length - 1, i + 1)]; if (n) { ui.sel = n.tx.id; renderCases(); } }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const n = list[Math.max(0, i - 1)]; if (n) { ui.sel = n.tx.id; renderCases(); } }
    const c = audit.byId.get(ui.sel);
    if (c && c.status === 'open' && e.key === 'f') caseAction('confirm', ui.sel);
    if (c && c.status === 'open' && e.key === 'l') caseAction('dismiss', ui.sel);
  });

  window.addEventListener('hashchange', route);

  // first visit: open with the sample data so the page is never empty
  let seen = false;
  try { seen = !!localStorage.getItem(LS_KEY + '.seen'); localStorage.setItem(LS_KEY + '.seen', '1'); } catch (e) { /* ignore */ }
  if (!state.tx.length && !seen) { state.tx = generateSample(); save(); }
  route();
  render();
}

document.addEventListener('DOMContentLoaded', init);

'use strict';
/* ═══════════════════════════════════════════════════════════════
   Redline — forensic expense auditor
   Everything runs client-side. No build step, no dependencies.
   ═══════════════════════════════════════════════════════════════ */

// ───────────── constants ─────────────
const LS_KEY = 'redline.v1';
const APPROVAL_LIMIT = 5000;
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
let state = { tx: [], dismissed: [], confirmed: [], trusted: [], budget: 40000, theme: 'paper' };
let ui = { tab: 'open', showAll: false };
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
    if (z > 3.5) flag(t, 'outlier', Math.min(55, 30 + Math.round(z * 1.5)),
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

function renderPreview() {
  const v = $('#cmd').value.trim();
  const box = $('#cmdPreview');
  if (!v) { box.innerHTML = ''; return; }
  const p = parseEntry(v);
  const chip = (k, val, fallback) => `<span><span class="k">${k}</span>${val ? esc(val) : `<span class="miss">${fallback}</span>`}</span>`;
  box.innerHTML = [
    chip('amount', p.amount && inrExact(p.amount), 'missing'),
    chip('payee', p.merchant, 'missing'),
    chip('category', p.category && `${p.category} (${p.source})`, '…'),
    chip('date', prettyDate(p.date || isoDate(startOfToday())), ''),
    chip('time', p.time || 'now', ''),
    chip('paid with', p.method || 'UPI', ''),
  ].join('');
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

// ═══════════════ rendering ═══════════════
function render() {
  audit = runAudit();
  renderVerdict();
  renderCases();
  renderNotes();
  renderMonthChart();
  renderBenford();
  renderHeatmap();
  renderTable();
}

function renderVerdict() {
  const { tx, cases } = audit;
  if (!tx.length) { $('#verdict').innerHTML = 'The books are empty. Write an entry above or <b>load the sample books</b>.'; return; }
  const open = cases.filter((c) => c.status === 'open');
  const atRisk = sum(open.map((c) => c.tx.amount));
  const months = new Set(tx.map((t) => t.date.slice(0, 7))).size;
  $('#verdict').innerHTML = `Audited <b style="color:var(--ink)">${tx.length}</b> entries across ${months} month${months > 1 ? 's' : ''}. ` +
    `<b>${open.length}</b> open redline${open.length === 1 ? '' : 's'}, <b>${inr(atRisk)}</b> under question.`;
}

function renderCases() {
  const { cases } = audit;
  const counts = { open: 0, confirmed: 0, dismissed: 0 };
  cases.forEach((c) => counts[c.status]++);
  document.querySelectorAll('#caseTabs button').forEach((b) => {
    const k = b.dataset.tab;
    b.classList.toggle('on', k === ui.tab);
    b.innerHTML = `${{ open: 'Open', confirmed: 'Confirmed', dismissed: 'Cleared' }[k]}<span class="n">${counts[k] || ''}</span>`;
  });
  const list = cases.filter((c) => c.status === ui.tab);
  if (!list.length) {
    $('#cases').innerHTML = `<div class="empty">${!audit.tx.length ? 'No books to audit yet.' : ui.tab === 'open' ? 'Nothing redlined. The books look clean.' : 'No cases here.'}</div>`;
    return;
  }
  $('#cases').innerHTML = list.map((c, i) => {
    const t = c.tx;
    const stampText = c.status === 'dismissed' ? 'Cleared' : c.status === 'confirmed' ? 'Fraud' : RULE_LABEL[c.reasons[0].rule];
    return `<article class="case sev-${c.sev} status-${c.status}" style="animation-delay:${Math.min(i, 8) * 40}ms">
      <div class="case-head"><span>Case ${String(c.no).padStart(3, '0')} · ${c.sev} risk</span><span>${prettyDate(t.date)} · ${esc(t.time)}</span></div>
      <div class="case-main">
        <div><div class="case-merchant">${esc(t.merchant)}</div><div class="case-meta">${esc(t.category)} · ${esc(t.method)}${t.note ? ' · “' + esc(t.note) + '”' : ''}</div></div>
        <div class="case-amt">${inrExact(t.amount)}</div>
      </div>
      <span class="stamp">${stampText}</span>
      <ul class="reasons">${c.reasons.map((r) => `<li><span class="w">+${r.weight}</span><span><span class="rule">${RULE_LABEL[r.rule]}</span>${esc(r.text)}</span></li>`).join('')}</ul>
      <div class="case-foot">
        <div class="meter" title="Risk score"><span style="width:${c.score}%"></span></div><span class="score">${c.score}/100</span>
        <div class="case-actions">${c.status === 'open'
          ? `<button class="fraud" data-act="confirm" data-id="${t.id}">Confirm fraud</button><button data-act="dismiss" data-id="${t.id}">Legitimate, trust payee</button>`
          : `<button data-act="reopen" data-id="${t.id}">Reopen</button>`}</div>
      </div>
    </article>`;
  }).join('');
}

// month-end projection: extrapolate ordinary spending, count flagged one-offs only once
function projectMonth(tx, byId) {
  const today = startOfToday();
  const key = isoDate(today).slice(0, 7);
  const list = tx.filter((t) => t.date.startsWith(key));
  const odd = sum(list.filter((t) => byId.get(t.id) && byId.get(t.id).status !== 'dismissed').map((t) => t.amount));
  const clean = sum(list.map((t) => t.amount)) - odd;
  const dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return (clean / today.getDate()) * dim + odd;
}

function renderNotes() {
  const { tx, cases, recurring: rec, benford: bf, patterns } = audit;
  const notes = [];
  if (tx.length) {
    const today = startOfToday();
    const proj = projectMonth(tx, audit.byId);
    const prevKeys = [1, 2, 3].map((k) => isoDate(new Date(today.getFullYear(), today.getMonth() - k, 1)).slice(0, 7));
    const prevTotals = prevKeys.map((k) => sum(tx.filter((t) => t.date.startsWith(k)).map((t) => t.amount))).filter((x) => x > 0);
    const avg3 = mean(prevTotals);
    let n1 = `At this pace ${MONTHS[today.getMonth()]} closes near <b>${inr(proj)}</b>`;
    if (avg3) { const d = (proj / avg3 - 1) * 100; n1 += `, <b class="${d > 0 ? 'red' : ''}">${Math.abs(d).toFixed(0)}% ${d > 0 ? 'above' : 'below'}</b> your recent average of ${inr(avg3)}`; }
    if (state.budget && proj > state.budget) n1 += `, overshooting your budget by <b class="red">${inr(proj - state.budget)}</b>`;
    notes.push(n1 + '.');

    const open = cases.filter((c) => c.status === 'open');
    const hi = open.filter((c) => c.sev === 'High');
    if (hi.length) notes.push(`<b class="red">${inr(sum(hi.map((c) => c.tx.amount)))}</b> sits in ${hi.length} high-risk entr${hi.length > 1 ? 'ies' : 'y'}. Start with ${esc(hi[0].tx.merchant)}: ${esc(hi[0].reasons[0].text.charAt(0).toLowerCase() + hi[0].reasons[0].text.slice(1))}`);

    if (rec.length) notes.push(`${rec.length} recurring charge${rec.length > 1 ? 's' : ''} (${rec.slice(0, 4).map((r) => esc(r.merchant)).join(', ')}) quietly cost <b>${inr(sum(rec.map((r) => r.yearly)))}</b> a year.`);

    const daySum = Array(7).fill(0), hourSum = Array(24).fill(0);
    for (const t of tx) { daySum[weekdayIdx(new Date(t.date + 'T00:00'))] += t.amount; hourSum[+t.time.slice(0, 2)] += t.amount; }
    const peakDay = daySum.indexOf(Math.max(...daySum)), peakHour = hourSum.indexOf(Math.max(...hourSum));
    const fullDay = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][peakDay];
    notes.push(`Your money moves most on <b>${fullDay}</b>, and the busiest hour is <b>${pad(peakHour)}:00–${pad((peakHour + 1) % 24)}:00</b>.`);

    const months = groupBy(tx.filter((t) => DISCRETIONARY.includes(t.category)), (t) => t.category);
    const span = Math.max(1, new Set(tx.map((t) => t.date.slice(0, 7))).size);
    const top = Object.entries(months).map(([c, l]) => [c, sum(l.map((t) => t.amount)) / span]).sort((a, b) => b[1] - a[1])[0];
    if (top) notes.push(`${top[0]} is your largest flexible spend at about <b>${inr(top[1])}</b> a month. Trimming it by 15% frees <b>${inr(top[1] * 0.15)}</b> monthly, or ${inr(top[1] * 0.15 * 12)} a year.`);

    if (bf.n >= 50) notes.push(`Benford's test: <b>${bf.verdict}</b> (χ² = ${bf.chi.toFixed(1)}, 8 df). ${bf.chi >= 15.51 ? `Leading digit ${bf.worstDigit} shows up more than it should.` : 'The leading digits look like those of honest books.'}`);
  } else notes.push('Notes appear once there is something to audit.');
  $('#notes').innerHTML = notes.map((n) => `<li>${n}</li>`).join('');

  $('#patterns').innerHTML = patterns.map((p) => `<div class="pattern"><h4>Pattern · ${p.cat} surge</h4>
    <p>${inr(p.cur)} on ${p.cat} in the last 30 days, <b class="num-ink">${p.ratio.toFixed(1)}×</b> your usual ${inr(p.base)}.</p></div>`).join('');
}

// ───────────── SVG charts ─────────────
const svgEl = (w, h, body) => `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">${body}</svg>`;
const kfmt = (n) => (n >= 100000 ? (n / 100000).toFixed(1) + 'L' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : Math.round(n));

function renderMonthChart() {
  const { tx, byId } = audit;
  const today = startOfToday();
  const keys = [5, 4, 3, 2, 1, 0].map((k) => new Date(today.getFullYear(), today.getMonth() - k, 1));
  const data = keys.map((d) => {
    const key = isoDate(d).slice(0, 7);
    const list = tx.filter((t) => t.date.startsWith(key));
    const total = sum(list.map((t) => t.amount));
    const flagged = sum(list.filter((t) => byId.get(t.id)?.status === 'open' || byId.get(t.id)?.status === 'confirmed').map((t) => t.amount));
    return { label: MONTHS[d.getMonth()], total, flagged };
  });
  data[5].proj = projectMonth(tx, byId);
  const W = 560, H = 250, L = 10, B = 26, T = 22;
  const max = Math.max(1, ...data.map((d) => Math.max(d.total, d.proj || 0)), state.budget || 0) * 1.08;
  const y = (v) => H - B - (v / max) * (H - B - T);
  const bw = (W - L * 2) / 6;
  let body = `<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--ink-2)" stroke-width="1.2"/></pattern></defs>`;
  body += `<line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="var(--ink)" />`;
  data.forEach((d, i) => {
    const x = L + i * bw + bw * 0.18, w = bw * 0.64;
    if (d.proj && d.proj > d.total) body += `<rect x="${x}" y="${y(d.proj)}" width="${w}" height="${y(d.total) - y(d.proj)}" fill="url(#hatch)" stroke="var(--ink-2)" stroke-dasharray="3 2"><title>Projected ${inr(d.proj)}</title></rect>`;
    body += `<rect x="${x}" y="${y(d.total)}" width="${w}" height="${H - B - y(d.total)}" fill="var(--ink)"><title>${d.label}: ${inr(d.total)}</title></rect>`;
    if (d.flagged) body += `<rect x="${x}" y="${y(d.total)}" width="${w}" height="${Math.max(2, H - B - y(d.flagged))}" fill="var(--red)"><title>Under question: ${inr(d.flagged)}</title></rect>`;
    const top = d.proj && d.proj > d.total ? d.proj : d.total;
    body += `<text x="${x + w / 2}" y="${y(top) - 6}" text-anchor="middle" font-size="11">${d.total ? kfmt(top) + (d.proj > d.total ? '*' : '') : ''}</text>`;
    body += `<text x="${x + w / 2}" y="${H - 8}" text-anchor="middle" font-size="11" style="fill:var(--ink)">${d.label}</text>`;
  });
  if (state.budget) body += `<line x1="0" x2="${W}" y1="${y(state.budget)}" y2="${y(state.budget)}" stroke="var(--red)" stroke-dasharray="6 4"/><text x="${W}" y="${y(state.budget) - 5}" text-anchor="end" font-size="10" style="fill:var(--red)">budget ${kfmt(state.budget)}</text>`;
  $('#monthChart').innerHTML = svgEl(W, H, body);
}

function renderBenford() {
  const bf = audit.benford;
  const W = 560, H = 230, B = 24, T = 16, L = 6;
  const max = 0.36;
  const y = (v) => H - B - (v / max) * (H - B - T);
  const bw = (W - L * 2) / 9;
  let body = `<line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" stroke="var(--ink)" />`;
  const pts = [];
  bf.observed.forEach((o, i) => {
    const x = L + i * bw + bw * 0.22, w = bw * 0.56;
    const off = o - bf.expected[i] > 0.03;
    body += `<rect x="${x}" y="${y(o)}" width="${w}" height="${H - B - y(o)}" fill="${off ? 'var(--red)' : 'var(--ink)'}" opacity="${bf.n ? 0.9 : 0.15}"><title>Digit ${i + 1}: ${(o * 100).toFixed(1)}% observed, ${(bf.expected[i] * 100).toFixed(1)}% expected</title></rect>`;
    body += `<text x="${x + w / 2}" y="${H - 7}" text-anchor="middle" font-size="12" style="fill:var(--ink)">${i + 1}</text>`;
    pts.push(`${x + w / 2},${y(bf.expected[i])}`);
  });
  body += `<polyline points="${pts.join(' ')}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  pts.forEach((p) => { const [cx, cy] = p.split(','); body += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="var(--paper)" stroke="var(--ink-2)" stroke-width="1.5"/>`; });
  body += `<text x="${W - 4}" y="${T}" text-anchor="end" font-size="10">○ Benford expected   ■ your books</text>`;
  $('#benfordChart').innerHTML = svgEl(W, H, body);
  $('#benfordVerdict').innerHTML = bf.n < 50 ? `${bf.n} usable entries. The test needs at least 50.` :
    `${bf.n} entries · χ² ${bf.chi.toFixed(1)} (8 df, critical 15.5) · MAD ${bf.mad.toFixed(4)} · <b class="${bf.chi < 15.51 ? 'ok' : ''}">${bf.verdict}</b>`;
}

function renderHeatmap() {
  const { tx, byId } = audit;
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const flagged = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of tx) {
    const d = weekdayIdx(new Date(t.date + 'T00:00')), h = +t.time.slice(0, 2);
    grid[d][h]++;
    const c = byId.get(t.id);
    if (c && c.status !== 'dismissed') flagged[d][h]++;
  }
  const max = Math.max(1, ...grid.flat());
  const cs = 24, L = 38, T = 18, W = L + 24 * cs + 4, H = T + 7 * cs + 4;
  let body = '';
  for (let h = 0; h < 24; h += 3) body += `<text x="${L + h * cs + cs / 2}" y="11" text-anchor="middle" font-size="10">${pad(h)}</text>`;
  for (let d = 0; d < 7; d++) {
    body += `<text x="${L - 8}" y="${T + d * cs + cs / 2 + 4}" text-anchor="end" font-size="11" style="fill:var(--ink)">${DAYS[d]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h];
      const op = v ? 0.12 + 0.88 * Math.sqrt(v / max) : 0;
      body += `<rect x="${L + h * cs + 1}" y="${T + d * cs + 1}" width="${cs - 2}" height="${cs - 2}" fill="${v ? 'var(--ink)' : 'none'}" fill-opacity="${op.toFixed(2)}" stroke="var(--rule)" stroke-width="0.6"><title>${DAYS[d]} ${pad(h)}:00 · ${v} entr${v === 1 ? 'y' : 'ies'}</title></rect>`;
      if (flagged[d][h]) body += `<circle cx="${L + h * cs + cs / 2}" cy="${T + d * cs + cs / 2}" r="${cs / 2 - 1}" fill="none" stroke="var(--red)" stroke-width="2.2"/>`;
    }
  }
  $('#heatmap').innerHTML = svgEl(W, H, body);
}

function renderTable() {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#catFilter').value;
  const only = $('#onlyFlagged').checked;
  let list = [...audit.tx].reverse().filter((t) => {
    if (cat && t.category !== cat) return false;
    if (q && !`${t.merchant} ${t.note}`.toLowerCase().includes(q)) return false;
    if (only) { const c = audit.byId.get(t.id); if (!c || c.status === 'dismissed') return false; }
    return true;
  });
  $('#txCount').textContent = `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`;
  const LIMIT = 60;
  $('#showMore').hidden = ui.showAll || list.length <= LIMIT;
  if (!ui.showAll) list = list.slice(0, LIMIT);
  $('#txBody').innerHTML = list.map((t) => {
    const c = audit.byId.get(t.id);
    const live = c && c.status !== 'dismissed';
    return `<tr class="${live ? 'flag-' + c.sev : ''}">
      <td class="mono">${t.date}</td><td class="mono">${esc(t.time)}</td><td>${esc(t.merchant)}</td><td>${esc(t.category)}</td><td>${esc(t.method)}</td>
      <td class="r mono amt">${inrExact(t.amount)}</td>
      <td class="r">${c ? `<span class="risk ${live ? c.sev : ''}">${c.status === 'dismissed' ? 'cleared' : c.status === 'confirmed' ? 'fraud' : c.score}</span>` : '<span class="risk">·</span>'}</td>
      <td class="r"><button class="del" data-del="${t.id}" title="Delete entry">×</button></td></tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:24px">No entries.</td></tr>`;
}

// ───────────── toast ─────────────
let toastTimer;
function toast(msg, alert = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (alert ? ' alert' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4200);
}

// ───────────── theme ─────────────
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('#btnTheme').textContent = state.theme === 'night' ? 'Day' : 'Night';
}

// ═══════════════ wiring ═══════════════
function init() {
  load();
  applyTheme();
  const now = new Date();
  $('#today').textContent = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const catOpts = CATEGORIES.map((c) => `<option>${c}</option>`).join('');
  $('#catFilter').insertAdjacentHTML('beforeend', catOpts);
  $('#expForm [name=category]').insertAdjacentHTML('beforeend', catOpts);
  $('#expForm [name=date]').value = isoDate(now);
  $('#budget').value = state.budget || '';

  $('#cmd').addEventListener('input', renderPreview);
  $('#cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitEntry(); });
  $('#cmdGo').addEventListener('click', submitEntry);

  $('#expForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.category) f.category = categorize(f.merchant, f.note).category;
    addTx({ ...f, merchant: f.merchant.trim(), amount: +f.amount });
    e.target.reset();
    $('#expForm [name=date]').value = isoDate(new Date());
    $('#expForm [name=time]').value = '12:00';
  });

  $('#btnDemo').addEventListener('click', () => {
    if (state.tx.length && !confirm('Replace your current books with the sample books?')) return;
    state = { ...state, tx: generateSample(), dismissed: [], confirmed: [], trusted: [] };
    save(); render();
    const open = audit.cases.filter((c) => c.status === 'open').length;
    toast(`Sample books loaded: ${audit.tx.length} entries over six months. ${open} redlined.`, true);
  });
  $('#btnClear').addEventListener('click', () => {
    if (!confirm('Erase every entry and everything Redline has learned?')) return;
    state = { ...state, tx: [], dismissed: [], confirmed: [], trusted: [] };
    save(); render(); toast('Books cleared.');
  });
  $('#btnExport').addEventListener('click', exportCSV);
  $('#btnTheme').addEventListener('click', () => { state.theme = state.theme === 'night' ? 'paper' : 'night'; save(); applyTheme(); render(); });
  $('#csvInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(importCSV);
    e.target.value = '';
  });
  $('#budget').addEventListener('change', (e) => { state.budget = Math.max(0, +e.target.value || 0); save(); render(); });

  $('#caseTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) { ui.tab = b.dataset.tab; renderCases(); }
  });
  $('#cases').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.dataset.id;
    const c = audit.byId.get(id);
    state.dismissed = state.dismissed.filter((x) => x !== id);
    state.confirmed = state.confirmed.filter((x) => x !== id);
    if (b.dataset.act === 'confirm') { state.confirmed.push(id); toast(`Case ${c.no} confirmed as fraud. It stays in the report.`, true); }
    if (b.dataset.act === 'dismiss') {
      state.dismissed.push(id);
      const m = c.tx.merchant;
      if (!state.trusted.some((x) => x.toLowerCase() === m.toLowerCase())) state.trusted.push(m);
      toast(`Cleared. Redline now trusts ${m}, so unusual hours and unknown-payee checks won't flag it again.`);
    }
    if (b.dataset.act === 'reopen') {
      state.trusted = state.trusted.filter((x) => x.toLowerCase() !== c.tx.merchant.toLowerCase());
      toast(`Case ${c.no} reopened.`);
    }
    save(); render();
  });

  ['#search', '#catFilter', '#onlyFlagged'].forEach((s) => $(s).addEventListener('input', renderTable));
  $('#showMore').addEventListener('click', () => { ui.showAll = true; renderTable(); });
  $('#txBody').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-del]');
    if (!b) return;
    state.tx = state.tx.filter((t) => t.id !== b.dataset.del);
    save(); render();
  });

  // first visit: open with the sample books so the page is never empty
  let seen = false;
  try { seen = !!localStorage.getItem(LS_KEY + '.seen'); localStorage.setItem(LS_KEY + '.seen', '1'); } catch (e) { /* ignore */ }
  if (!state.tx.length && !seen) { state.tx = generateSample(); save(); }
  render();
}

document.addEventListener('DOMContentLoaded', init);

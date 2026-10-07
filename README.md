# Redline. A forensic auditor for your spending

**Problem statement:** Intelligent Expense Management & Anomaly Detection System

Most expense apps are pie charts with a budget bar. Redline works like a forensic accountant instead. It reads every entry, checks it against **your own spending habits** and against **Benford's law**, and *redlines* what doesn't belong. Each flagged entry becomes a case file with plain-English reasons and a risk score you can trace back to its rules.

**Live demo:** _add your Vercel / GitHub Pages / Netlify URL here_

## What makes it different
- **Machine learning:** an Isolation Forest (120 trees, 7 behavioural features) trained in the browser on your own payments. It gives a second opinion on every case, boosts the cases the rules caught, and keeps an ML watchlist of payments that only the model found unusual.
- **Risk console UI:** a sidebar app with Overview, Case investigator, Transactions, Analytics and Methods & tuning pages, plus dark mode.
- **Risk timeline:** six months of daily spending like a seismograph, with red spikes on days with flagged payments. Click any day to inspect it.
- **Case investigator:** a score gauge, weighted evidence, a plot showing where the payment sits against every payment in its category, and related payments. Keyboard shortcuts: J/K to move, F for fraud, L for legitimate.
- **Interactive charts:** hover tooltips everywhere. Clicking a month, a day, a heatmap cell or a category opens the matching transactions.
- **Live tuning:** change the approval limit and the detection sensitivity and the whole audit re-runs instantly.
- **Savings planner:** sliders that show how much trimming each flexible category saves per month and year.
- **Benford's law test** with a chi-square verdict, and a **habit fingerprint** heatmap.
- **Natural-language entry:** type `spent 450 at swiggy yesterday 9pm via upi`.
- **Learns from you:** clearing a case makes Redline trust that payee. Undo for every destructive action.
- **Printable audit report** and CSV export.
- **Privacy-first:** no backend, no API keys, nothing leaves the browser.

## Detection methods
| Rule | Weight | How |
|---|---|---|
| Robust outlier | 30–55 | Modified z-score (Iglewicz–Hoaglin) on log-amounts per category; flags z > 3.5 |
| Duplicate charge | 55 | Same merchant and amount within 48 h (2 h if < ₹500) |
| Split purchase | 45 | ≥ 2 same-day charges at one merchant, each < ₹5,000 limit, total ≥ limit |
| Threshold hugging | 35 | Amount within 5% below the ₹5,000 approval limit |
| Off-habit timing | 25 | Large spend in an hour holding < 2% of your history |
| Unknown payee | 25 | First-ever merchant above the category's 90th percentile (after 3 weeks of baseline) |
| Round sum | 10 | ≥ ₹1,000 and a multiple of ₹500 (adds weight, never flags alone) |
| Category surge | pattern | Last 30 days > 1.6× the mean of the three prior 30-day windows |
| Benford's law | ledger | χ² goodness-of-fit, 8 df, critical 15.51 (p = .05) |

Score = sum of weights (capped at 99). **High** ≥ 60, **Medium** ≥ 35, shown when ≥ 30.

The sample books hold six months of realistic spending (~480 entries) with 9 planted frauds. Redline flags exactly those 9 and nothing else.

## Run locally
No build step. Open `index.html`, or serve the folder:
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy (pick one, about 2 minutes)
- **Vercel:** push to GitHub → vercel.com → *Add New Project* → import the repo → Framework preset **Other** → Deploy.
- **GitHub Pages:** repo *Settings → Pages →* Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
- **Netlify Drop:** drag the project folder onto app.netlify.com/drop.

## Files
```
index.html            page structure
styles.css            paper & ink theme (day / night)
app.js                audit engine, NL parser, CSV import/export, SVG charts, UI
sample-statement.csv  bank-statement-style file to import live during the demo
```

## 2-minute demo script
1. **Hook (10s):** "Expense apps tell you *what* you spent. Redline tells you what *shouldn't be there*."
2. **Masthead (15s):** six months of books are already audited, with 9 open redlines and the amount under question.
3. **A case file (30s):** open the Swiggy ₹4,860 case. Show the weighted reasons: 16× typical, ₹140 under the approval limit, 2 am, which is 0.2% of your history. Then the Croma split purchase and the Amazon double charge.
4. **Benford + fingerprint (20s):** "Honest books follow Benford's law, and ours pass with χ² 13.8 against a critical 15.5." On the heatmap, the red rings sit outside the dark habit zone.
5. **Live entry (20s):** type `spent 4999 at royal gifts at 2am via card` and it gets redlined instantly.
6. **Import (15s):** import `sample-statement.csv`. A raw bank statement with no categories gets categorised automatically and 4 new redlines appear (duplicate Myntra charge, 3 am betting site, threshold hugger).
7. **Learning (10s):** click *Legitimate, trust payee* and Redline learns. Close with "Runs entirely in your browser, and it's live at …"

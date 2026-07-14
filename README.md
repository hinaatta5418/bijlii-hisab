# BijliHisaab — Pakistan Electricity Bill Estimator

A free, bilingual (English / اردو) electricity-bill calculator for Pakistan, built on the
NEPRA uniform tariff. Estimates the bill for any government DISCO (LESCO, IESCO, MEPCO,
FESCO, GEPCO, PESCO, HAZECO, HESCO, SEPCO, QESCO) plus K-Electric, and breaks down every
charge — energy, FPA, surcharge/QTA, fixed charges, GST, electricity duty, PTV fee and
Section 235 income tax.

## Files
- `index.html` — the page shell (open this).
- `app.js` — the whole app, pre-compiled into one file (React is bundled in; no internet build step needed).
- `BijliHisaab_1.jsx` — the editable React source (kept for reference; you edit this and rebuild to change the app).

## Run it locally
Just open `index.html` in a browser. (Because `app.js` is loaded as a separate file,
some browsers block it from `file://` for security. If the page stays on "Loading…",
run a tiny local server instead:)

```bash
# from this folder
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Publish free on GitHub Pages
1. Create a new GitHub repository and upload `index.html` and `app.js` (keep them in the repo root).
2. In the repo: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick branch **main** and folder **/ (root)**, then **Save**.
5. Wait a minute; your site appears at `https://<your-username>.github.io/<repo-name>/`.

That's it — no build tools required, because `app.js` is already compiled.

## Editing later
The human-readable source is `BijliHisaab_1.jsx`. If you change it, it must be
re-compiled into `app.js` before the change shows up on the site (the browser can't run
raw JSX directly). Ask and this can be rebuilt for you, or set up a Vite project to build it yourself.

## Note
Estimates only — actual bills vary with the monthly fuel adjustment, quarterly
adjustments, government subsidies (which are not modelled) and your DISCO. Not affiliated
with NEPRA or any distribution company.

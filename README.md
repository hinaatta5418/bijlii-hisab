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

## SEO & deployment files (added)
These make the site fully crawlable and give rich link previews. For a **static deploy**
(Vercel/Hostinger) they sit next to `index.html` at the web root. In a **Vite project**,
put the assets (`robots.txt`, `sitemap.xml`, `site.webmanifest`, `favicon.*`, `icon-*.png`,
`apple-touch-icon.png`, `og-image.png`) in the `public/` folder and keep the `<head>` tags
in your `index.html`; Vite copies `public/` to the build root.

- `robots.txt` — allows all crawlers, points to the sitemap.
- `sitemap.xml` — lists the one canonical URL (the app is a single-page app; its sections
  are in-page views, not separate routes, so there is one real URL).
- `site.webmanifest` — PWA manifest (name, icons, theme colours) for "Add to home screen".
- `favicon.svg` / `favicon.ico` / `favicon-16/32/48` / `apple-touch-icon.png` — browser/tab icons.
- `icon-192.png` / `icon-512.png` — maskable PWA icons referenced by the manifest.
- `og-image.png` — 1200×630 social share preview used by Open Graph + Twitter.
- `vercel.json` — cache headers only (no rewrites), safe to deploy as-is.

Canonical domain: `https://bijlihisab.online`. In the Vercel dashboard, set the apex domain
as primary and redirect `www` → apex so both resolve to the canonical URL.

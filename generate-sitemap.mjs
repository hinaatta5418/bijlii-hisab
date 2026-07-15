// generate-sitemap.mjs
// Regenerates sitemap.xml with today's date so <lastmod> never goes stale.
// Run it whenever you update the site:  node generate-sitemap.mjs
//
// If you later split the app into separate pages (e.g. /lesco, /fesco, /300-units),
// just add their paths to the `routes` array below and re-run.

import { writeFileSync } from "node:fs";

const ORIGIN = "https://bijlihisab.online";

// One entry per real URL. The app is currently a single page, so there is one route.
const routes = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
];

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

const urls = routes
  .map(
    (r) => `  <url>
    <loc>${ORIGIN}${r.path}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${r.changefreq}</changefreq>
    <priority>${r.priority}</priority>
    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${r.path}"/>
    <xhtml:link rel="alternate" hreflang="ur" href="${ORIGIN}${r.path}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${r.path}"/>
  </url>`
  )
  .join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;

writeFileSync(new URL("./sitemap.xml", import.meta.url), xml);
console.log(`sitemap.xml regenerated with lastmod ${today}`);

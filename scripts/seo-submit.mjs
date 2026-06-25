#!/usr/bin/env node
// Re-submit every sismo911.com URL to IndexNow (Bing, Yandex, Seznam, Naver, Yep).
// Google does not use IndexNow — its sitemap is submitted via Search Console
// (see scripts/seo-submit.md). Run after publishing new pages/blog posts:
//   node scripts/seo-submit.mjs
const ORIGIN = "https://sismo911.com";
const KEY = "12f9568ca65e901017e55ced867b4089";
const SITEMAPS = [`${ORIGIN}/sitemap.xml`, `${ORIGIN}/sitemap-blog.xml`];

async function collectUrls() {
  const set = new Set();
  for (const sm of SITEMAPS) {
    const xml = await (await fetch(sm)).text();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) set.add(m[1].trim());
  }
  return [...set];
}

async function submit(urls) {
  const body = JSON.stringify({
    host: "sismo911.com",
    key: KEY,
    keyLocation: `${ORIGIN}/${KEY}.txt`,
    urlList: urls,
  });
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  for (const ep of [
    "https://api.indexnow.org/indexnow",
    "https://www.bing.com/indexnow",
    "https://yandex.com/indexnow",
  ]) {
    const r = await fetch(ep, { method: "POST", headers, body });
    console.log(`${ep} -> HTTP ${r.status}`);
  }
}

const urls = await collectUrls();
console.log(`Submitting ${urls.length} URLs to IndexNow…`);
await submit(urls);

// THCa vendor scraper. Node 18+ (no dependencies).
// Usage: node scrape.mjs [--only jgrows,kache] [--no-reddit] [--no-reviews]
// Output: data.json (read by the dashboard). Caches live in ./cache.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(DIR, 'cache');
fs.mkdirSync(CACHE, { recursive: true });
const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ONLY = argVal('--only')?.split(',');
const NO_REDDIT = args.includes('--no-reddit');
const NO_REVIEWS = args.includes('--no-reviews');
const REDDIT_ONLY = args.includes('--reddit-only'); // re-score existing data.json with fresh Reddit buzz
const FROM_CACHE = args.includes('--from-cache'); // rebuild items from cached raw catalogs, no store requests
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'vendors.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ---------- polite fetch: per-host spacing + 429 backoff ----------
const CURL_HOSTS = new Set(cfg.vendors.filter((v) => v.fetcher === 'curl').map((v) => new URL(v.url).host));
const lastHit = new Map();
async function get(url, { json = false, gap = 3500, tries = 5 } = {}) {
  const host = new URL(url).host;
  for (let t = 0; t < tries; t++) {
    const wait = (lastHit.get(host) || 0) + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    let res;
    if (CURL_HOSTS.has(host)) {
      // some firewalls block Node's fetch fingerprint but allow curl (bundled with Windows 10+)
      const r = await new Promise((ok) => execFile('curl', ['-s', '-m', '30', '-A', UA, '-w', '\n%{http_code}', url], { maxBuffer: 50e6 }, (e, out) => ok(e ? null : out)));
      if (r == null) { await sleep(5000); continue; }
      const cut = r.lastIndexOf('\n'); const status = +r.slice(cut + 1); const text = r.slice(0, cut);
      if (status === 429) { await sleep(65000); continue; }
      if (status !== 200) return { status, body: null };
      if (json) { try { return { status, body: JSON.parse(text) }; } catch { return { status, body: null }; } }
      return { status, body: text };
    }
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
    } catch (e) { log('  net error', url, e.message); await sleep(5000); continue; }
    if (res.status === 429 || res.status === 503) {
      const ra = Math.min(180, Number(res.headers.get('retry-after')) || 60);
      log(`  ${res.status} on ${host}, waiting ${ra + 5}s`);
      await sleep((ra + 5) * 1000);
      continue;
    }
    if (!res.ok) return { status: res.status, body: null };
    const text = await res.text();
    if (/<title>Just a moment/i.test(text)) return { status: 403, body: null };
    if (json) { try { return { status: 200, body: JSON.parse(text) }; } catch { return { status: 200, body: null }; } }
    return { status: 200, body: text };
  }
  return { status: 429, body: null };
}

// ---------- classification ----------
const EXCLUDE = /gumm|edible|jell(y|ies)|chocolate|tincture|beverage|drink|seltzer|soda|t-?shirt|hoodie|\bhat\b|merch|apparel|gift ?card|sticker|lighter|grinder|\brig\b|banger|torch|bong|pipe\b|carb cap|topical|lotion|capsule|softgel|cookie|candy|syrup|\bpet\b|delta[- ]?8|delta[- ]?9 gumm|mushroom|amanita|kratom|bundle builder|subscription|sample pack|mystery|bottle|bites\b|taffy|\bmints?\b|\bchews?\b|lozenge|honey|caramel|\btea\b|delivery fee|discount|loyalty|testing product|mood ?mats?|\bmats?\b|dab swabs?|\bcbd (flower|hemp)|hemp flower cbd|\bcbg\b|massage oil|\brub\b|balm|accessor|cbd isolate|isolate powder|feminized|autoflower seeds|\bseeds\b|dabber|\bbatter(y|ies)\b|\bkit\b|splashers?|\bliter\b|lollipops?|popsicles?|ice pops?|brookie|\d+\s*pcs\b/i;
function classify(text) {
  const t = text.toLowerCase();
  if (EXCLUDE.test(t)) return null;
  if (/\bcbd\b/.test(t) && !/thc/.test(t)) return null; // CBD-only products
  if (/\b(carts?|cartridges?|vapes?|disposables?|pods?|aio|a\.i\.o|all[- ]in[- ]one|510|pens?)\b/.test(t)) return 'vape';
  if (/pre-?rolls?|\bjoints?\b|\bblunts?\b|infused roll|hash hole|cannarillo|cannagar/.test(t)) return 'preroll';
  if (/\bflower\b|\bsmalls\b/.test(t) && !/rosin|hash/.test(t)) return 'flower';
  if (/rosin|solventless|bubble hash|ice ?water hash|temple ball|\bhash\b|piatella|full melt|cold cure|fresh press|\bhrc\b|thumbprint/.test(t)) return 'rosin';
  if (/live resin|diamond|sauce|badder|batter|budder|sugar|\bwax\b|shatter|crumble|concentrate|isolate|\bdab|distillate|hte|caviar|moonrock/.test(t)) return 'concentrate';
  if (/flower|eighth|\bbuds?\b|smalls|indoor|greenhouse|exotic|\boz\b|ounce|strain|indica|sativa|hybrid/.test(t)) return 'flower';
  return null;
}
function parseGrams(s) {
  if (!s) return null;
  s = s.replace(/\$\s*\d+(\.\d+)?/g, ' '); // ignore prices like "$100 Oz's"
  const t = s.toLowerCase();
  let m;
  if (/half ?(a )?gram/.test(t)) return 0.5;
  // ranges like "0.5-0.6 grams each": use the low end so $/g isn't flattered
  if ((m = t.match(/(\d*\.?\d+)\s*(?:-|to)\s*(\d*\.?\d+)\s*(?:g|gr|gram|grams)\b/))) return parseFloat(m[1]);
  if ((m = t.match(/(\d*\.?\d+)\s*(?:g|gr|gram|grams|ml)\b/))) return parseFloat(m[1]);
  if (/^\s*(full |one |1 )?gram\s*$/.test(t)) return 1;
  if ((m = t.match(/(\d*\.?\d+)\s*mg\b/)) && parseFloat(m[1]) >= 100) return parseFloat(m[1]) / 1000;
  if (/\b1\/8|eighth/.test(t)) return 3.5;
  if (/\b1\/4(?!\s*(lb|pound))|quarter(?! pound)/.test(t)) return 7;
  if (/\b1\/2\s*(oz|ounce)|half ?(oz|ounce)/.test(t)) return 14;
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:oz|ounces?)\b/))) return parseFloat(m[1]) * 28;
  if (/\bounce\b|\bzip\b|\boz'?s\b/.test(t)) return 28;
  if (/\bqp\b|quarter pound/.test(t)) return 112;
  if (/\bhp\b|half pound|half lb/.test(t)) return 224;
  if (/\bpound\b|\blb\b/.test(t)) return 448;
  return null;
}
const HM = cfg.hashmakers;
const SOLVENTLESS = [...cfg.hashmakers, ...(cfg.solventlessBrands || [])];
function findHashmaker(text) {
  const t = text.toLowerCase();
  return HM.find((h) => t.includes(h.toLowerCase())) || null;
}
const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function isThirdParty(v, brand) {
  const b = norm(brand); if (b.length < 3) return false;
  // generic product-type labels that stores put in the brand field
  if (/flower|thc|cbd|vape|indoor|outdoor|type\d|hemp|exotic|concentrate|rosin$|dablicator|default|preroll/.test(b)) return false;
  const initials = (s) => (s || '').split(/[^A-Za-z]+/).filter(Boolean).map((w) => w[0].toLowerCase()).join('');
  if (b === initials(v.name) || b === initials(v.name) + 's') return false;
  const own = [norm(v.name), norm(v.id), norm(new URL(v.url).host.replace(/^www\./, '').split('.')[0])];
  return !own.some((o) => o && (b.includes(o.slice(0, 6)) || o.includes(b.slice(0, 6))));
}
const strip = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;|&rsquo;/g, "'").replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

// Lab report (COA) link and test date from product HTML. Generic store-wide lab pages are sorted out later.
const COA_TEXT = /\bcoa\b|certificate of analysis|lab (?:test|result|report)s?|test results|third[- ]party (?:lab|test)|view (?:the )?lab/i;
const COA_HREF = /coa|certificate|lab[-_ ]?(?:result|report|test)|labresult|testing|\.pdf(?:$|\?)/i;
function extractCoa(html, base) {
  if (!html) return null;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const text = strip(m[2]); let href = m[1].replace(/&amp;/g, '&');
    if (!(COA_TEXT.test(text) || (COA_HREF.test(href) && /coa|lab|test|certif/i.test(href + text)))) continue;
    try { href = new URL(href, base).href; } catch { continue; }
    if (!/^https?:/.test(href) || /\/(collections|products?|product-category|cart|account)\b/.test(new URL(href).pathname) && !/\.pdf/i.test(href)) continue;
    return { url: href, date: coaDate(`${href} ${text} ${strip(html).slice(0, 4000)}`) };
  }
  return null;
}
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
function coaDate(s) {
  const now = Date.now(), ok = (d) => d && !isNaN(d) && d <= now + 864e5 && now - d < 3 * 365 * 864e5 ? new Date(d).toISOString().slice(0, 10) : null;
  const near = s.match(new RegExp(`(?:tested|test date|date tested|date of (?:test|analysis)|analy[sz]ed|reported|harvest(?:ed)?(?: date)?)[^0-9a-z]{0,12}((?:${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`, 'i'));
  const any = near?.[1] || s.match(/\b(20\d\d)[-_.](\d\d)[-_.](\d\d)\b/)?.[0] || s.match(new RegExp(`\\b(?:${MONTHS})[a-z]*\\.? \\d{1,2},? 20\\d\\d\\b`, 'i'))?.[0];
  if (!any) return null;
  const m = any.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) return ok(Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], m[1] - 1, +m[2]));
  return ok(Date.parse(any.replace(/[_.]/g, '-')));
}

function makeItem(v, p) {
  // classify on title+brand first; tags are noisy, so only use them as a fallback
  let category = classify(`${p.title} ${p.brand || ''}`) ?? classify([p.title, p.type, (p.cats || []).join(' '), (p.tags || []).join(' ')].join(' '));
  // boutique solventless makers often get filed under generic "Concentrates"
  if (category === 'concentrate' && (SOLVENTLESS.some((b) => norm(p.brand).includes(norm(b))) || /solventless|hash|melt|sift|rosin|ice ?water/i.test(p.brand || ''))) category = 'rosin';
  if (!category) return null;
  const anyLabelWeight = p.variants.some((y) => parseGrams(y.label));
  // vendors that sell fixed-size jars without saying so (e.g. Quantum's 1g singles); flagged as assumed on the site
  const assumedG = !anyLabelWeight && !parseGrams(p.title) && !/pack|sampler|mystery|bundle|\d+\s*ct\b/i.test(p.title) ? v.defaultGrams?.[category] : null;
  const variants = p.variants.map((x) => {
    let g = parseGrams(x.label) ?? (!anyLabelWeight ? parseGrams(p.title) ?? (p.variants.length === 1 ? parseGrams(p.desc?.slice(0, 600)) : null) : null);
    let assumed = false;
    if (!g && assumedG) { g = assumedG; assumed = true; }
    return { label: x.label || 'Default', grams: g, assumed: assumed || undefined, price: x.price, compareAt: x.compareAt > x.price ? x.compareAt : null, available: x.available, ppg: g && x.price ? +(x.price / g).toFixed(2) : null };
  }).filter((x) => x.price > 0);
  if (!variants.length) return null;
  const avail = variants.filter((x) => x.available);
  const pool = avail.length ? avail : variants;
  const withPpg = pool.filter((x) => x.ppg);
  const best = withPpg.sort((a, b) => a.ppg - b.ppg)[0] || null;
  return {
    id: `${v.id}:${p.handle}`, vendorId: v.id, title: strip(p.title), brand: p.brand || null, category,
    url: p.url, image: p.image || null, variants,
    available: avail.length > 0, minPrice: Math.min(...pool.map((x) => x.price)),
    bestPpg: best?.ppg ?? null, bestPpgLabel: best?.label ?? null, bestPpgGrams: best?.grams ?? null, bestPpgPrice: best?.price ?? null,
    weightAssumed: best?.assumed || undefined,
    onSale: variants.some((x) => x.compareAt),
    hashmaker: findHashmaker(`${p.title} ${p.brand || ''} ${(p.tags || []).join(' ')}`),
    thirdParty: isThirdParty(v, p.brand) ? strip(p.brand) : null,
    rating: p.rating ?? null, reviewCount: p.reviewCount ?? null,
    thca: potency(category, [p.title, p.desc, ...(p.tags || []), ...p.variants.map((x) => x.label)].join(' | ')),
    coa: p.coa || null,
    ...strainInfo(`${p.title} | ${(p.tags || []).join(' ')} | ${p.desc || ''}`),
  };
}
// Indica / sativa / hybrid and effects, as the store describes the product (same words as Ayr's mood chips).
const EFFECT_WORDS = {
  relaxed: /\brelax(?:ed|ing|ation)?\b|\bmellow\b|\bunwind\b|\bchill(?:ed)?\b/i,
  sleepy: /\bsleep(?:y)?\b|\binsomnia\b|\bsedat(?:ing|ive)\b|\bcouch[- ]?lock\b|\bnight ?time\b|\bbedtime\b/i,
  calm: /\bcalm(?:ing)?\b|\bpeaceful\b|\bstress relief\b|\banxiety\b|\bsoothing\b/i,
  happy: /\bhapp(?:y|iness)\b|\bgiggl(?:y|es)\b|\bcheerful\b|\bmood[- ]?(?:boost|lift)|\buplift(?:ed|ing)\b/i,
  euphoric: /\beuphori[ac]\b|\bblissful\b/i,
  energetic: /\benerg(?:y|etic|izing)\b|\bdaytime\b|\bwake ?(?:and|n) ?bake\b|\bactive\b/i,
  creative: /\bcreativ(?:e|ity)\b|\bartistic\b/i,
  focused: /\bfocus(?:ed)?\b|\bclear[- ]headed\b|\bproductiv(?:e|ity)\b/i,
  'pain relief': /\bpain\b|\baches?\b|\binflammation\b|\bbody high\b/i,
};
function strainInfo(text) {
  const t = text.slice(0, 2500);
  const ind = /\bindica\b/i.test(t), sat = /\bsativa\b/i.test(t), hyb = /\bhybrid\b|\b50\s*\/\s*50\b/i.test(t);
  const strainType = hyb || (ind && sat) ? (/\bindica[- ]dominant\b/i.test(t) ? 'Indica-dominant hybrid' : /\bsativa[- ]dominant\b/i.test(t) ? 'Sativa-dominant hybrid' : 'Hybrid') : ind ? 'Indica' : sat ? 'Sativa' : null;
  const effects = Object.entries(EFFECT_WORDS).filter(([, re]) => re.test(t)).map(([k]) => k);
  return { ...(strainType ? { strainType } : {}), ...(effects.length ? { effects } : {}) };
}
// THCa (or total THC) % as stated in the listing. Not read from COA PDFs; only what the store writes.
function potency(category, text) {
  if (!text) return null;
  const pats = [
    /\b(?:thc-?a|thca-?a?|total thc-?a)\b[^\d%|]{0,18}(\d{1,2}(?:\.\d{1,2})?)\s*%/i,
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:thc-?a)\b/i,
    /\b(?:total (?:potential )?thc|total cannabinoids|potency)\b[^\d%|]{0,18}(\d{1,2}(?:\.\d{1,2})?)\s*%/i,
    /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:total )?thc\b/i,
  ];
  const [lo, hi] = category === 'flower' || category === 'preroll' ? [8, 45] : [35, 99.9];
  for (const re of pats) {
    const m = text.match(re); const n = m && parseFloat(m[1]);
    if (n >= lo && n <= hi) return n;
  }
  return null;
}

// ---------- platform scrapers ----------
async function shopify(v) {
  const out = [];
  for (let page = 1; page <= 12; page++) {
    const r = await get(`${v.url}/products.json?limit=250&page=${page}`, { json: true, gap: 6000 });
    if (!r.body?.products) { if (page === 1) throw new Error(`products.json ${r.status}`); break; }
    for (const p of r.body.products) {
      out.push({
        handle: p.handle, title: p.title, type: p.product_type, tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(','),
        brand: p.vendor, coa: extractCoa(p.body_html, v.url), desc: strip(p.body_html).slice(0, 1500), url: `${v.url}/products/${p.handle}`, image: p.images?.[0]?.src,
        variants: p.variants.map((x) => ({ label: x.title === 'Default Title' ? '' : x.title, price: +x.price, compareAt: +x.compare_at_price || null, available: !!x.available })),
      });
    }
    if (r.body.products.length < 250) break;
  }
  return out;
}

async function woo(v) {
  const base = `${v.url}/wp-json/wc/store/v1/products`;
  const parents = [];
  for (let page = 1; page <= 15; page++) {
    const r = await get(`${base}?per_page=99&page=${page}`, { json: true, gap: 2500 });
    if (!Array.isArray(r.body)) { if (page === 1) throw new Error(`store api ${r.status}`); break; }
    parents.push(...r.body);
    if (r.body.length < 99) break;
  }
  const vars = [];
  for (let page = 1; page <= 30; page++) {
    const r = await get(`${base}?type=variation&per_page=99&page=${page}`, { json: true, gap: 2500 });
    if (!Array.isArray(r.body) || !r.body.length) break;
    vars.push(...r.body);
    if (r.body.length < 99) break;
  }
  const byParent = new Map();
  for (const x of vars) { if (!byParent.has(x.parent)) byParent.set(x.parent, []); byParent.get(x.parent).push(x); }
  const money = (pr, k) => +(pr?.[k] || 0) / 10 ** (pr?.currency_minor_unit ?? 2);
  return parents.filter((p) => p.type !== 'variation').map((p) => {
    const kids = byParent.get(p.id) || [];
    let variants;
    if (kids.length) {
      variants = kids.map((k) => ({ label: (k.variation || k.name.replace(p.name, '')).replace(/^[\s\-–:]+/, ''), price: money(k.prices, 'price'), compareAt: money(k.prices, 'regular_price'), available: k.is_in_stock !== false && k.is_purchasable !== false }));
    } else if (p.prices?.price_range) {
      // fall back: map min/max price onto the smallest/largest size option
      const sizes = (p.attributes || []).flatMap((a) => a.terms.map((t) => t.name)).filter((s) => parseGrams(s)).sort((a, b) => parseGrams(a) - parseGrams(b));
      const lo = money(p.prices.price_range, 'min_amount'), hi = money(p.prices.price_range, 'max_amount');
      variants = sizes.length >= 2 ? [{ label: sizes[0], price: lo, available: p.is_in_stock }, { label: sizes.at(-1), price: hi, available: p.is_in_stock }] : [{ label: sizes[0] || '', price: lo, available: p.is_in_stock }];
    } else {
      variants = [{ label: '', price: money(p.prices, 'price'), compareAt: money(p.prices, 'regular_price'), available: p.is_in_stock }];
    }
    return {
      handle: p.slug, coa: extractCoa((p.description || '') + (p.short_description || ''), v.url), title: strip(p.name), desc: strip(p.short_description || p.description).slice(0, 1500), type: '', tags: (p.tags || []).map((t) => t.name), cats: (p.categories || []).map((c) => c.name),
      url: p.permalink, image: p.images?.[0]?.thumbnail || p.images?.[0]?.src, variants,
      rating: +p.average_rating || null, reviewCount: p.review_count || null,
    };
  });
}

// Square Online public store API (ids come from window.__BOOTSTRAP_STATE__ on any page)
async function square(v) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await get(`https://cdn5.editmysite.com/app/store/api/v28/editor/users/${v.squareUser}/sites/${v.squareSite}/products?page=${page}&per_page=100&include=images`, { json: true, gap: 1500 });
    if (!r.body?.data) { if (page === 1) throw new Error(`square api ${r.status}`); break; }
    for (const p of r.body.data) {
      if (p.visibility !== 'visible') continue;
      const lo = p.price?.low, hi = p.price?.high, reg = p.price?.regular_low;
      const avail = !p.badges?.out_of_stock && !p.inventory?.all_variations_sold_out;
      out.push({
        handle: p.id, title: strip(p.name), type: '', tags: [], cats: [], desc: strip(p.short_description),
        url: p.absolute_site_link, image: p.images?.data?.[0]?.absolute_url || null,
        variants: lo === hi || !hi ? [{ label: '', price: lo, compareAt: reg > lo ? reg : null, available: avail }]
          : [{ label: 'from', price: lo, available: avail }],
        rating: p.avg_rating || null,
      });
    }
    if (r.body.meta?.pagination?.current_page >= r.body.meta?.pagination?.total_pages) break;
  }
  return out;
}

function ldProducts(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (/Product/.test(o['@type'])) out.push(o); if (o['@graph']) walk(o['@graph']); };
    walk(j);
  }
  return out;
}
const THCA_URL = /thca|flower|rosin|hash|pre-?roll|smalls|diamond|badder|sauce|live|resin|jar|indoor|exotic|kief|temple|cart|vape/i;
async function jsonld(v) {
  const urls = new Set();
  // sitemaps named in robots.txt first (Arete: /sitemaps/sitemap-index.xml, BigCommerce: /xmlsitemap.php), then the usual spots
  const robots = (await get(`${v.url}/robots.txt`, { gap: 1500, tries: 2 })).body || '';
  const fromRobots = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = [...new Set([...fromRobots, `${v.url}/sitemap.xml`, `${v.url}/sitemap_index.xml`, `${v.url}/xmlsitemap.php`])];
  const seenMaps = new Set();
  while (queue.length && urls.size < 1500) {
    const sm = queue.shift(); if (seenMaps.has(sm)) continue; seenMaps.add(sm);
    const r = await get(sm, { gap: 1500, tries: 2 });
    if (!r.body || !/<(urlset|sitemapindex)/i.test(r.body)) continue;
    const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(r.body)) queue.push(...locs.filter((l) => /product|store|item|shop/i.test(l) && !/categor|tag|brand/i.test(l)).slice(0, 8));
    else locs.filter((l) => /\/(product|products|product-page|shop|store)\//i.test(l)).forEach((l) => urls.add(l));
  }
  if (!urls.size) throw new Error('no product URLs in sitemap');
  // product pages are cached; each run re-reads the ones not seen for the longest (THCa-looking first),
  // so big catalogs stay within a day or two without hundreds of page loads every refresh
  const cacheF = path.join(CACHE, `pages-${v.id}.json`);
  const cache = readJson(cacheF, {});
  const all = [...urls].sort((a, b) => THCA_URL.test(b) - THCA_URL.test(a));
  const relevant = all.filter((u) => THCA_URL.test(u)).length ? all.filter((u) => THCA_URL.test(u)) : all;
  const stale = relevant.filter((u) => !cache[u] || Date.now() - cache[u].t > 36 * 3600e3).sort((a, b) => (cache[a]?.t || 0) - (cache[b]?.t || 0));
  const budget = FROM_CACHE ? 0 : Object.keys(cache).length ? 180 : 320;
  log(`  ${urls.size} product pages (${relevant.length} look like THCa); reading ${Math.min(budget, stale.length)} new or stale`);
  for (const u of stale.slice(0, budget)) {
    const r = await get(u, { gap: 1500, tries: 2 });
    if (r.body) cache[u] = { t: Date.now(), p: pageProduct(r.body, u) };
  }
  for (const u of Object.keys(cache)) if (!urls.has(u)) delete cache[u]; // dropped from the store
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  return relevant.map((u) => cache[u]?.p).filter(Boolean);
}
// BigCommerce (WNC) leaves prices out of its structured data but embeds them in BCData: the price range
// (cheapest = smallest size, dearest = largest) and which size options are in stock.
function bigCommerceVariants(body) {
  const m = body.match(/var BCData = (\{[\s\S]*?\});\s*(?:<\/script>|var |\n)/);
  let bc; try { bc = JSON.parse(m[1]).product_attributes; } catch { return null; }
  const range = bc?.price?.price_range, base = bc?.price?.without_tax?.value;
  const opts = [...body.matchAll(/data-product-attribute-value="(\d+)"[\s\S]{0,400}?form-option-variant">\s*([^<]+?)\s*</g)].map((x) => ({ id: +x[1], label: x[2] }));
  const inStock = new Set(bc.in_stock_attributes || []);
  const avail = (o) => (o && inStock.size ? inStock.has(o.id) : !!bc.instock);
  if (!opts.length || !range) return base ? [{ label: '', price: base, available: !!bc.instock }] : null;
  const grams = (s) => parseGrams(s) ?? 0;
  const sorted = [...opts].sort((a, b) => grams(a.label) - grams(b.label));
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const out = [{ label: lo.label, price: range.min.without_tax.value, available: avail(lo) }];
  if (hi !== lo && range.max.without_tax.value !== range.min.without_tax.value) out.push({ label: hi.label, price: range.max.without_tax.value, available: avail(hi) });
  return out;
}
function pageProduct(body, u) {
  const r = { body };
  for (const p of ldProducts(body).slice(0, 1)) {
    {
      const offers = [].concat(p.offers?.offers || p.offers || []);
      let variants = offers.length && offers[0]['@type'] !== 'AggregateOffer'
        ? offers.map((o) => ({ label: o.name || o.sku || '', price: +o.price || +o.lowPrice, available: !/OutOfStock|SoldOut/i.test(o.availability || '') }))
        : [{ label: '', price: +(offers[0]?.lowPrice || offers[0]?.price || 0), available: !/OutOfStock|SoldOut/i.test(offers[0]?.availability || '') }];
      if (!variants.some((x) => x.price > 0)) variants = bigCommerceVariants(body) || variants;
      if (/%[0-9A-F]{2}/.test(p.description || '')) { try { p.description = decodeURIComponent(p.description); } catch {} }
      const im0 = Array.isArray(p.image) ? p.image[0] : p.image;
      const img = typeof im0 === 'string' ? im0 : im0?.url || im0?.contentUrl || im0?.thumbnailUrl || null;
      return {
        handle: u.split('/').filter(Boolean).pop(), coa: extractCoa(r.body, u), title: p.name, desc: strip(p.description).slice(0, 1500), type: p.category || '', tags: [], cats: [], brand: p.brand?.name || p.brand,
        url: u, image: typeof img === 'string' ? img : null, variants,
        rating: +p.aggregateRating?.ratingValue || null, reviewCount: +(p.aggregateRating?.reviewCount || p.aggregateRating?.ratingCount) || null,
      };
    }
  }
  return null;
}

// ---------- shipping terms and promo codes, read from the store's own homepage + shipping page ----------
// Manual values in vendors.json ("shipping": {"cost": 10, "freeOver": 99}) win over what's found.
const pageText = (h) => (h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$').replace(/&nbsp;|&#160;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
function findShipping(t) {
  const s = {};
  let m = t.match(/free (?:ground |standard |domestic |priority )?shipping[^$.]{0,45}\$\s?(\d{2,3})/i) || t.match(/\$\s?(\d{2,3})\s?\+?[^.]{0,25}free (?:ground |standard )?shipping/i);
  if (m) s.freeOver = +m[1];
  m = t.match(/(?:flat[- ]rate|standard|ground|usps|shipping (?:is|costs?|fee))[^$.]{0,30}\$\s?(\d{1,2}(?:\.\d\d)?)(?!\d)/i);
  if (m && +m[1] > 0 && +m[1] < 30 && +m[1] !== s.freeOver) s.cost = +m[1];
  return s;
}
function findPromos(t) {
  const out = [];
  for (const m of t.matchAll(/([^.!|]{0,60}?)\b(?:[Uu]se |[Pp]romo |[Cc]oupon |[Dd]iscount )?[Cc](?:ode|ODE)\s*(?:[:=]\s*|\s)["“']?([A-Z][A-Z0-9]{3,19})\b([^.!|]{0,50})/g)) {
    const code = m[2];
    if (/^(CODE|SHOP|HERE|BELOW|NOW|APPLY|FREE)$/.test(code) || out.some((x) => x.code === code)) continue;
    const text = strip(`${m[1]} code ${code}${m[3]}`).replace(/\s+/g, ' ').trim().slice(0, 120);
    // percent off near the code ("30% off ... use code X" or "code X for 20% off")
    const near = t.slice(Math.max(0, m.index - 120), m.index + m[0].length + 60);
    const pct = +(text.match(/(\d{1,2})\s?% off/i)?.[1] || near.match(/(\d{1,2})\s?% off/i)?.[1] || 0) || null;
    const firstOrder = /first|new (?:customer|shopper)|welcome|sign ?up|subscribe/i.test(text);
    out.push({ code, text, pct: pct && pct <= 60 ? pct : null, firstOrder: firstOrder || undefined });
  }
  const sale = t.match(/[^.!|]{0,40}\b(\d{1,2})% off (?:everything|sitewide|all|storewide)[^.!|]{0,30}/i);
  if (sale) {
    const withCode = out.find((p) => p.pct === +sale[1]);
    if (withCode) { withCode.sitewide = true; withCode.text = `${sale[0].trim()} with code ${withCode.code}`.slice(0, 120); }
    else out.push({ code: null, text: sale[0].trim().slice(0, 120), pct: +sale[1], sitewide: true });
  }
  return out.slice(0, 3);
}
// The best discount that applies to anyone (not first-order-only), as a fraction of price.
function bestPromo(promos) {
  const ok = (promos || []).filter((p) => p.pct && !p.firstOrder);
  return ok.sort((a, b) => b.pct - a.pct)[0] || null;
}
// States a store says it can't ship (THCa) to: sentences like "cannot be shipped to the following states: AR, CA, ... VA".
const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' };
function findNoShip(t) {
  const out = new Set();
  for (const m of t.matchAll(/[^.]{0,120}\b(?:can ?not|can't|cannot|do not|don't|does not|unable to|not able to|won't|will not|restrict(?:ed|s)?|prohibit(?:ed)?|exclud(?:e|ed|ing))\b[^.]{0,40}\bship[^.]{0,400}/gi)) {
    const s = m[0];
    // full names first ("west virginia" before "virginia"), then 2-letter codes in a list
    let rest = ' ' + s.toLowerCase() + ' ';
    for (const [ab, name] of Object.entries(STATES).sort((a, b) => b[1].length - a[1].length)) if (rest.includes(' ' + name)) { out.add(ab); rest = rest.split(name).join(' '); }
    const codes = s.match(/\b[A-Z]{2}\b(?=\s*(?:,|and|or|\.|;|$))/g) || [];
    if (codes.filter((c) => STATES[c]).length >= 3) codes.forEach((c) => STATES[c] && out.add(c));
  }
  return [...out];
}
async function storeInfo(v, prevInfo) {
  const cacheF = path.join(CACHE, `store-${v.id}.json`);
  const cached = readJson(cacheF, null);
  if (FROM_CACHE || v.platform === 'browser') return { ...(cached || prevInfo || {}), ...(v.shipping ? { shipping: v.shipping } : {}), ...(v.noShip ? { noShip: v.noShip } : {}), ...(v.promos ? { promos: v.promos } : {}) };
  const info = { shipping: {}, promos: [], checkedAt: new Date().toISOString() };
  const home = await get(v.url, { gap: 2500, tries: 2 });
  const ht = pageText(home.body);
  Object.assign(info.shipping, findShipping(ht));
  info.promos = v.promos || findPromos(ht);
  // the store's own shipping / FAQ / policy links, wherever its theme puts them
  const policyLinks = new Set();
  for (const m of (home.body || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const txt = strip(m[2]) + ' ' + m[1];
    if (!/shipping|delivery|faq|policies|terms|refund/i.test(txt) || /instagram|facebook|twitter|tiktok|mailto:/i.test(m[1])) continue;
    try { const u = new URL(m[1].replace(/&amp;/g, '&'), v.url); if (u.host === new URL(v.url).host) policyLinks.add(u.pathname); } catch {}
  }
  // the store's lab-results page, if the homepage links one
  for (const m of (home.body || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    if (/\bcoas?\b|lab (?:results|reports|tests|testing)|certificates? of analysis|test results/i.test(strip(m[2]))) { try { info.labPage = new URL(m[1].replace(/&amp;/g, '&'), v.url).href; break; } catch {} }
  }
  // the shipping page rarely changes: re-read it weekly
  if (cached?.policy?.v === 2 && Date.now() - new Date(cached.policy.t) < 7 * 864e5) info.policy = cached.policy;
  else {
    let pol = {}; const blocked = new Set(); let pages = 0, nationwide = false;
    const paths = [...new Set([...policyLinks].slice(0, 8).concat(['/policies/shipping-policy', '/shipping-policy', '/shipping', '/pages/shipping', '/pages/faq', '/pages/faqs', '/faq', '/faqs', '/policies/terms-of-service', '/terms-and-conditions']))].slice(0, 14);
    for (const p of paths) {
      const r = await get(v.url + p, { gap: 2000, tries: 1 });
      if (!r.body || !/ship/i.test(r.body)) continue;
      const t = pageText(r.body);
      pages++;
      if (!pol.freeOver && !pol.cost) pol = findShipping(t);
      else if (!pol.cost) { const s2 = findShipping(t); if (s2.cost) pol.cost = s2.cost; }
      for (const s of findNoShip(t)) blocked.add(s);
      if (/\b(?:all 50 (?:us |u\.s\. )?states|nationwide|anywhere in the (?:us|u\.s\.|united states)|all (?:us|u\.s\.) states|every state)\b/i.test(t)) nationwide = true;
    }
    info.policy = { v: 2, t: new Date().toISOString(), ...pol, noShip: [...blocked].sort(), pages, nationwide };
  }
  info.noShip = v.noShip || info.policy.noShip || [];
  const { t: _t, noShip: _n, v: _v, pages: _p, nationwide: _nw, ...polShip } = info.policy;
  info.shipping = { ...polShip, ...info.shipping };
  if (v.shipping) info.shipping = { ...info.shipping, ...v.shipping };
  fs.writeFileSync(cacheF, JSON.stringify(info));
  return info;
}
// Estimated price with shipping for buying just that size. Unknown flat rate → assume $10 (typical for hemp mail order).
const SHIP_GUESS = 10;
function landed(price, ship) {
  if (!ship || (ship.freeOver == null && ship.cost == null)) return null;
  if (ship.freeOver != null && price >= ship.freeOver) return price;
  return price + (ship.cost ?? SHIP_GUESS);
}

// ---------- product-page review scraping (Shopify review widgets), cached 7 days ----------
function pageRating(html) {
  for (const p of ldProducts(html)) {
    const a = p.aggregateRating; if (a && +a.ratingValue) return { rating: +a.ratingValue, count: +(a.reviewCount || a.ratingCount) || 0 };
  }
  const pats = [
    [/jdgm-prev-badge[^>]*data-average-rating=['"]([\d.]+)['"][^>]*data-number-of-reviews=['"](\d+)/i],
    [/data-average-rating=['"]([\d.]+)['"][\s\S]{0,200}?data-number-of-reviews=['"](\d+)/i],
    [/stamped-badge[^>]*data-rating=['"]([\d.]+)['"][^>]*data-count=['"](\d+)/i],
    [/data-rating=['"]([\d.]+)['"][^>]*data-raters=['"](\d+)/i],
    [/"ratingValue"\s*:\s*"?([\d.]+)"?[\s\S]{0,80}?"(?:reviewCount|ratingCount)"\s*:\s*"?(\d+)/i],
  ];
  for (const [re] of pats) { const m = html.match(re); if (m && +m[1] > 0 && +m[2] > 0) return { rating: +m[1], count: +m[2] }; }
  return null;
}
async function addPageReviews(v, items) {
  const cacheF = path.join(CACHE, `ratings-${v.id}.json`);
  const cache = readJson(cacheF, {});
  const WEEK = 7 * 864e5;
  // product pages give star ratings and, on many themes, the lab report link
  const todo = FROM_CACHE ? [] : items.filter((i) => (i.rating == null || !i.coa) && i.available).filter((i) => !(cache[i.id] && Date.now() - cache[i.id].t < WEEK)).slice(0, 40);
  if (todo.length) log(`  reviews/labs: fetching ${todo.length} product pages`);
  for (const i of todo) {
    const r = await get(i.url, { gap: 5000, tries: 3 });
    cache[i.id] = { t: Date.now(), ...(r.body ? pageRating(r.body) || {} : {}), coa: r.body ? extractCoa(r.body, i.url) : null };
  }
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  for (const i of items) {
    const c = cache[i.id];
    if (c?.rating && i.rating == null) { i.rating = c.rating; i.reviewCount = c.count; }
    if (c?.coa && !i.coa) i.coa = c.coa;
  }
}
// Most stores keep lab reports on one "Lab results" page, not on each product. Read that page (weekly),
// collect every report link with the words around it, and give a product the report that names its strain.
const LAB_FILE = /\.pdf|\.jpe?g|\.png|\.webp|drive\.google|docs\.google|kaycha|acslab|confidentcannabis|qrco\.de|cdn\.shopify\.com\/s\/files|wp-content\/uploads|lab|coa/i;
const GENERIC_LINK = /^(?:download(?: pdf)?|view(?: coa| results?| report)?|coa|lab results?|click here|here|pdf|results?|test results?|see coa|open)$/i;
const normLab = (s) => " " + (s || "").toLowerCase().replace(/%[0-9a-f]{2}/gi, " ").replace(/[^a-z0-9]+/g, " ").trim() + " ";
async function addLabMatches(v, items, labPage) {
  if (!labPage) return 0;
  const cacheF = path.join(CACHE, `lab-${v.id}.json`);
  let c = readJson(cacheF, null);
  if (!c || c.page !== labPage || Date.now() - c.t > 7 * 864e5) {
    if (FROM_CACHE) return 0;
    const r = await get(labPage, { gap: 2500, tries: 2 });
    const html = r.body || '';
    const links = [];
    for (const m of html.matchAll(/<a\b([^>]*)href=["']([^"'#]+)["']([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
      let href = m[2].replace(/&amp;/g, '&');
      if (!LAB_FILE.test(href) || /\/(collections|products?|cart|account|pages\/(?!.*coa))\b/i.test(href) && !/\.pdf/i.test(href)) continue;
      if (/drive\.google\.com\/drive\/folders/i.test(href)) continue; // a whole folder, not one report
      try { href = new URL(href, labPage).href; } catch { continue; }
      const text = strip(m[4]); const title = (m[1] + m[3]).match(/(?:title|aria-label)=["']([^"']+)/i)?.[1] || '';
      // generic button text ("Download PDF") → use the words just before the link (the card's heading)
      const before = GENERIC_LINK.test(text.trim()) || !text.trim() ? strip(html.slice(Math.max(0, m.index - 600), m.index)).slice(-140) : '';
      const file = decodeURIComponent(href.split('?')[0].split('/').pop() || '').replace(/[_-]+/g, ' ');
      links.push({ url: href, label: normLab(`${text} ${title} ${before} ${file}`), date: coaDate(`${file} ${text} ${title}`) });
    }
    c = { t: Date.now(), page: labPage, links };
    fs.writeFileSync(cacheF, JSON.stringify(c));
  }
  let n = 0;
  for (const i of items) {
    if (i.coa) continue;
    const key = (groupKey(i) || '').split(':')[1] || strainKey(i.title);
    if (!key || key.replace(/ /g, '').length < 5) continue;
    const k = normLab(key);
    const hit = c.links.find((l) => l.label.includes(k));
    if (hit) { i.coa = { url: hit.url, date: hit.date, fromLabPage: true }; n++; }
  }
  return n;
}

// Some stores leave the photo off a product in their catalog feed (Legendary's mix-and-match bundles)
// but still show one on the product page; read it from there. Cached for a week.
async function addPageImages(v, items) {
  const cacheF = path.join(CACHE, `images-${v.id}.json`);
  const cache = readJson(cacheF, {});
  const todo = FROM_CACHE ? [] : items.filter((i) => !i.image && i.available && i.url).filter((i) => !(cache[i.id] && Date.now() - cache[i.id].t < 7 * 864e5)).slice(0, 30);
  if (todo.length) log(`  photos: reading ${todo.length} product pages`);
  for (const i of todo) {
    const r = await get(i.url, { gap: 4000, tries: 2 });
    const h = r.body || '';
    const m = h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i)
      || h.match(/class="[^"]*wp-post-image[^"]*"[^>]*\bsrc="([^"]+)"/i) || h.match(/<img[^>]+\bsrc="([^"]+)"[^>]*class="[^"]*wp-post-image/i);
    cache[i.id] = { t: Date.now(), image: m && !/placeholder|logo/i.test(m[1]) ? m[1].replace(/&amp;/g, '&') : null };
  }
  fs.writeFileSync(cacheF, JSON.stringify(cache));
  for (const i of items) if (!i.image && cache[i.id]?.image) i.image = cache[i.id].image;
}

// ---------- Reddit buzz via PullPush archive ----------
const POS = /\b(fire|gas|gassy|amazing|great|best|love|loved|legit|quality|terpy|flavorful|flavor|recommend|solid|clean|smooth|impressed|favorite|insane|loud|potent|top ?tier|s ?tier|goat|go-to|reliable|fast shipping|excellent|incredible|bomb|dank|happy)\b/gi;
const NEG = /\b(mid|trash|scam|avoid|worst|bad|harsh|mold|moldy|disappointed|disappointing|overpriced|shady|garbage|never arrived|refund|weak|sketchy|burnt|ripped off|lab ?fake|fake coa|stale|seeds|seedy|hay|larf|terrible|awful|meh|lost package)\b/gi;
// Pull every post (12 months) and comment (90 days) from the relevant subreddits via the
// Arctic Shift archive, cache it, and match vendor names locally. Incremental after first run.
const RSUBS = cfg.redditSubs || ['THCaFlower', 'hashrosin', 'hempflowers', 'Rosin'];
let CORPUS = null;
async function buildCorpus() {
  const f = path.join(CACHE, 'reddit-corpus.json');
  const c = readJson(f, { docs: {}, newest: {} });
  const now = Math.floor(Date.now() / 1000);
  for (const sub of RSUBS) {
    for (const kind of ['posts', 'comments']) {
      const key = `${sub}:${kind}`;
      const floor = Math.max(now - (kind === 'posts' ? 365 : 90) * 86400, c.newest[key] || 0);
      const fields = kind === 'posts' ? 'id,title,selftext,created_utc,score,subreddit' : 'id,body,created_utc,score,link_id,subreddit';
      let before = now, newest = c.newest[key] || 0, n = 0, complete = false;
      for (let page = 0; page < 200; page++) {
        let r;
        for (let t = 0; t < 4; t++) {
          r = await get(`https://arctic-shift.photon-reddit.com/api/${kind}/search?subreddit=${sub}&after=${floor}&before=${before}&limit=100&sort=desc&fields=${fields}`, { json: true, gap: 1200 });
          if (r.body && !r.body.error) break;
          await sleep(8000);
        }
        const data = r.body?.data;
        if (!Array.isArray(data)) break;
        for (const d of data) {
          const text = kind === 'posts' ? `${d.title} ${d.selftext || ''}` : d.body || '';
          c.docs[d.id] = { sub: d.subreddit, t: d.created_utc, score: d.score || 0, text: text.slice(0, 2000), title: kind === 'posts' ? d.title : null,
            link: kind === 'posts' ? `https://reddit.com/r/${d.subreddit}/comments/${d.id}` : `https://reddit.com/r/${d.subreddit}/comments/${(d.link_id || '').slice(3)}/_/${d.id}` };
          newest = Math.max(newest, d.created_utc); n++;
        }
        if (data.length < 100) { complete = true; break; }
        before = Math.min(...data.map((d) => d.created_utc));
      }
      if (complete) c.newest[key] = newest;
      log(`  reddit ${key}: +${n}${complete ? '' : ' (partial)'}`);
    }
  }
  const cutoff = now - 365 * 86400;
  for (const [id, d] of Object.entries(c.docs)) if (d.t < cutoff) delete c.docs[id];
  fs.writeFileSync(f, JSON.stringify(c));
  return Object.values(c.docs);
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Phrases count more than single words; a negator just before a word flips it ("not fire", "never had mold").
const POS2 = /\b(would (?:buy|order) again|re-?up(?:ped)?|reorder(?:ed)?|no complaints|highly recommend|10\/10|can'?t go wrong|exceeded|blown away)\b/gi;
const NEG2 = /\b(never again|stay away|do not buy|don'?t buy|chargeback|bunk|ghosted|no response|never (?:got|received)|took (?:weeks|forever)|missing (?:order|package)|customer service (?:sucks|is terrible))\b/gi;
const NEGATOR = /\b(not|never|isn'?t|wasn'?t|ain'?t|no|don'?t|didn'?t|wouldn'?t|won'?t|hardly|zero)\b[^.!?,]{0,18}$/i;
function sentScore(text) {
  let p = 0, n = 0;
  const hit = (re, w, dir) => { for (const m of text.matchAll(re)) { const neg = NEGATOR.test(text.slice(Math.max(0, m.index - 30), m.index)); if ((dir > 0) !== neg) p += w; else n += w; } };
  hit(POS, 1, 1); hit(NEG, 1, -1); hit(POS2, 2, 1); hit(NEG2, 2, -1);
  return { p, n, s: (p - n) / (p + n + 2) };
}
async function reddit(v) {
  CORPUS ||= await buildCorpus();
  const res = v.reddit.map((t) => new RegExp(`\\b${reEsc(t)}\\b`, 'i'));
  const now = Date.now() / 1000;
  const quotes = [];
  const list = CORPUS.filter((d) => res.some((re) => re.test(d.text))).map((d) => {
    // score the sentences that name the vendor; fall back to the whole post
    const sents = d.text.split(/(?<=[.!?])\s+|\n+/).filter((s) => res.some((re) => re.test(s)));
    const sc = sentScore(sents.join(' ') || d.text);
    for (const s of sents) {
      const q = sentScore(s); const clean = strip(s).replace(/\s+/g, ' ').trim();
      if (Math.abs(q.s) >= 0.25 && clean.length >= 25 && clean.length <= 220) quotes.push({ text: clean, sent: +q.s.toFixed(2), score: d.score, link: d.link, t: d.t });
    }
    // upvoted and recent posts count more (half-life ~4 months)
    const w = (1 + Math.log10(1 + Math.max(0, d.score))) * Math.pow(0.5, (now - d.t) / (120 * 86400));
    return { ...d, sent: sc.s, w };
  });
  const wsum = list.reduce((s, d) => s + d.w, 0);
  const avg = wsum ? list.reduce((s, d) => s + d.sent * d.w, 0) / wsum : 0;
  const pick = (f, dir) => quotes.filter(f).sort((a, b) => dir * (b.sent - a.sent) || b.score - a.score || b.t - a.t).filter((q, i, a) => a.findIndex((x) => x.text === q.text) === i).slice(0, 2)
    .map(({ text, sent, link }) => ({ text, sent, link }));
  return {
    mentions: list.length, sentiment: +avg.toFixed(3),
    recent: list.filter((d) => now - d.t < 30 * 86400).length,
    says: [...pick((q) => q.sent > 0, 1), ...pick((q) => q.sent < 0, -1)],
    top: list.sort((a, b) => b.score - a.score).slice(0, 4).map(({ title, text, link, sub, score, sent }) => ({ title: strip(title || text).slice(0, 140), link, sub, score, sent: +sent.toFixed(2) })),
    _docs: list,
  };
}
// What Reddit says about one product: posts that name the strain and either this vendor or the
// product's hashmaker (the same jar is sold by several shops). Keeps the sentences that name the strain.
const STRAIN_WORDS = /^(og|kush|gelato|runtz|cake|zkittlez|haze|cookies|diesel|purple|lemon|cherry|grape|mango|candy|sherbet|sorbet|banana|blue dream|sour|mints?|sundae|pie|punch|z|rs11|apple|gas|tropical)$/;
function productReddit(i, vendorDocs, v) {
  delete i.redditMentions; delete i.redditSent; delete i.redditLinks; delete i.redditSays;
  const k = (groupKey(i) || '').split(':')[1] || strainKey(i.title);
  // keys left over from format or line names ("flavor pack", "everyday indoor", "cured badder") aren't strains
  if (/\b(flavor|pack|vape|pen|sampler|bundle|seed junky|everyday|budget|premium|private|in house|cured|badder|explore)\b/.test(k || '')) return;
  if (!k || k.replace(/ /g, '').length < 5 || STRAIN_WORDS.test(k)) return;
  // the store's own name isn't a strain ("Daily Hi - Live Rosin")
  const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  if ([v.name, ...(v.reddit || [])].some((n) => flat(n).includes(flat(k)) || flat(k).includes(flat(n)))) return;
  const re = new RegExp(`\\b${reEsc(k).replace(/ /g, '[\\s-]*')}\\b`, 'i');
  const maker = i.hashmaker && i.hashmaker.length >= 4 ? new RegExp(`\\b${reEsc(i.hashmaker).replace(/ /g, '\\s*')}\\b`, 'i') : null;
  const seen = new Set();
  const docs = [...vendorDocs, ...(maker ? CORPUS.filter((d) => maker.test(d.text)) : [])]
    .filter((d) => { if (seen.has(d.link) || !re.test(d.text)) return false; seen.add(d.link); return true; });
  if (!docs.length) return;
  const quotes = [];
  for (const d of docs) {
    const sents = d.text.split(/(?<=[.!?])\s+|\n+/);
    sents.forEach((x, n) => {
      if (!re.test(x)) return;
      let q = strip(x);
      if (q.length < 60 && sents[n + 1]) q = (q + ' ' + strip(sents[n + 1])).trim();
      if (q.length < 20) return;
      if (q.length > 280) q = q.slice(0, 277).replace(/\s+\S*$/, '') + '…';
      quotes.push({ text: q, sent: +sentScore(q).s.toFixed(2), score: d.score, link: d.link, sub: d.sub, t: d.t });
    });
  }
  // opinions first (either way), then upvotes, then newest; one quote per thread
  const pickd = new Set();
  const says = quotes.sort((a, b) => (Math.abs(b.sent) >= 0.2) - (Math.abs(a.sent) >= 0.2) || b.score - a.score || b.t - a.t)
    .filter((q) => { if (pickd.has(q.link)) return false; pickd.add(q.link); return true; }).slice(0, 4)
    .map((q) => ({ ...q, t: new Date(q.t * 1000).toISOString().slice(0, 10) }));
  const sent = quotes.length ? quotes.reduce((a, q) => a + q.sent, 0) / quotes.length : 0;
  i.redditMentions = docs.length; i.redditSent = +sent.toFixed(2); i.redditLinks = docs.slice(0, 3).map((d) => d.link);
  i.redditSays = says;
}
const GENERIC = /\b(thca|hash|rosin|live|cold|cure|fresh|press|badder|batter|jam|sauce|diamonds?|flower|indoor|exotic|premium|tier|\d+(\.\d+)?\s*g|grams?|oz|eighth|cart|vape|disposable|pre-?rolls?|the|and|by|x|in-house|small batch|solventless|full melt|bubble|hash rosin|resin|sugar|smalls|1st|2nd|press)\b/gi;
function strainKey(title) {
  const k = title.toLowerCase().replace(/[|•–—:()[\]]/g, ' ').replace(GENERIC, ' ').replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 5 ? k : null;
}
// Key for "same strain at other vendors": the strain name with maker, tier, size and format words removed.
const GROUP_STOP = /\b(t\d|tier ?\d|no|reserve|batch|baller|jars?|packs?|\d*ct|pen|aio|a i o|joints?|infused|blunts?|mini|singles?|thca|thc|live|cold|cure|rosin|resin|hash|bubble|ice water|carts?|cartridges?|disposables?|vapes?|o2|flower|smalls|mediums|tadpoles|micro|buds?|indoor|greenhouse|outdoor|sungrown|living soil|exotic|aaa\+?|connected|alien|smoken promises|hrc|hcs|sesh|parlay|new|limited|drop|exclusive|sale|deal|special|staff pick|grams?|ounce|oz|eighth|quarter|half|full|melt|star|budget|spectrum|wax|sugar|badder|batter|sauce|diamonds?|crumble|shatter|jam|fresh|press(ed)?|pre ?rolls?|prerolls?|\d+(\.\d+)?\s*(g|oz|mg|ml)?|\d\/\d\s*oz)\b/g;
function groupKey(i) {
  let t = i.title.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (const b of [i.hashmaker, i.thirdParty, i.brand, ...HM]) if (b && b.length >= 3) t = t.split(b.toLowerCase()).join(' ');
  t = t.replace(/\bstrain\b.*$/, ' ');
  // the strain is usually the first segment: "Name | Format | Size", "Name · Format", "Name: Format"
  const segs = t.split(/\s[|·•–—-]\s|[|·•:]/).map((s) => s.replace(/[\-/,+&#]/g, ' ').replace(GROUP_STOP, ' ').replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()).filter((s) => s.replace(/ /g, '').length >= 3);
  const k = segs[0];
  if (!k || k.split(' ').length > 3 || /^(shake|grown|temple balls?|trim|popcorn|mystery|variety|sampler|assorted|mix(ed)?|hybrid|indica|sativa|house|premium)$/.test(k)) return null;
  return `${i.category}:${k}`;
}

// ---------- scoring ----------
const TIER_PTS = { S: 40, 'A+': 36, A: 32, B: 20, C: 14, D: 8 };
function bucket(i) {
  const g = i.effGrams || i.bestPpgGrams || 0;
  if (i.category === 'flower') return g <= 3.5 ? 'small' : g <= 14 ? 'mid' : g <= 56 ? 'bulk' : 'wholesale';
  if (i.category === 'preroll') return 'all';
  // unpressed hash (bubble, ice water, dry sift, temple balls) is priced well below rosin
  if (i.category === 'rosin' && /bubble|ice ?water|dry sift|temple ball|piatella|\bhash\b(?!.*rosin)/i.test(i.title) && !/rosin/i.test(i.title)) return 'hash';
  return g <= 1 ? 'small' : g <= 3.5 ? 'mid' : 'bulk';
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------- price history (history.json, committed so it survives cache loss) ----------
// Per item, one row each time its shipped $/g, lowest price or stock changes: [date, ppg, minPrice, inStock].
const DAY = 864e5;
const dayStr = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const daysSince = (d) => (Date.now() - new Date(d + 'T12:00:00Z')) / DAY;
function updateHistory(items) {
  const f = path.join(DIR, 'history.json');
  const H = readJson(f, { started: dayStr(), items: {} });
  const today = dayStr();
  const seen = new Set();
  for (const i of items) {
    if (i.stale) continue; // cached rows aren't new observations
    seen.add(i.id);
    const rec = (H.items[i.id] ||= { first: today, h: [] });
    const row = [today, i.effPpg ?? null, i.minPrice ?? null, i.available ? 1 : 0];
    const last = rec.h.at(-1);
    if (last && last[0] === today) rec.h[rec.h.length - 1] = row;
    else if (!last || last[1] !== row[1] || last[2] !== row[2] || last[3] !== row[3]) rec.h.push(row);
    rec.last = today;
  }
  for (const i of items) {
    const rec = H.items[i.id]; if (!rec) continue;
    const h = rec.h, cur = h.at(-1);
    // when did the current price start, and what was it before?
    let k = h.length - 1; while (k > 0 && h[k - 1][1] === cur[1]) k--;
    const prevRow = k > 0 ? h[k - 1] : null;
    if (prevRow && prevRow[1] && cur[1] && cur[1] < prevRow[1] * 0.95 && daysSince(h[k][0]) <= 3)
      i.drop = { pct: Math.round((1 - cur[1] / prevRow[1]) * 100), from: prevRow[1], at: h[k][0] };
    // lowest shipped $/g in the last 30 days (including the price that was live 30 days ago)
    const win = h.filter((r, n) => daysSince(r[0]) <= 30 || (h[n + 1] && daysSince(h[n + 1][0]) <= 30)).map((r) => r[1]).filter(Boolean);
    if (cur[1] && win.length > 1 && cur[1] <= Math.min(...win) && Math.max(...win) > cur[1] * 1.03) i.low30 = true;
    let s = h.length - 1; while (s > 0 && h[s - 1][3] === cur[3]) s--;
    if (cur[3] && s > 0 && !h[s - 1][3] && daysSince(h[s][0]) <= 2) i.restocked = h[s][0];
    if (rec.first > H.started && daysSince(rec.first) <= 2) i.isNew = rec.first;
    i.firstSeen = rec.first;
    if (h.length > 1) i.hist = h.slice(-12).map((r) => [r[0], r[1]]);
  }
  // forget items gone 60+ days; trim rows older than 120 days (keeping the one live at the cutoff)
  for (const [id, rec] of Object.entries(H.items)) {
    if (!seen.has(id) && daysSince(rec.last || rec.first) > 60) { delete H.items[id]; continue; }
    const cut = rec.h.findIndex((r) => daysSince(r[0]) <= 120);
    if (cut > 1) rec.h = rec.h.slice(cut - 1);
  }
  fs.writeFileSync(f, JSON.stringify(H));
}

// ---------- vendor reliability and drop days, from history.json ----------
// Reliability (0-100): share of the store's products in stock over the last 30 days, how jumpy prices are,
// and how long sold-out products stay gone. Needs a week of history. Drop day: the weekday most new
// listings and restocks land on over the last 8 weeks, when one day clearly dominates.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function vendorStats() {
  const H = readJson(path.join(DIR, 'history.json'), null);
  if (!H) return {};
  const now = Date.now(), t = (d) => new Date(d + 'T12:00:00Z').getTime();
  const span = Math.min(30, (now - t(H.started)) / DAY);
  const acc = {}, vFirst = {};
  for (const [id, rec] of Object.entries(H.items)) { const v = id.split(':')[0]; if (!vFirst[v] || rec.first < vFirst[v]) vFirst[v] = rec.first; }
  for (const [id, rec] of Object.entries(H.items)) {
    const vid = id.split(':')[0], a = (acc[vid] ||= { inT: 0, allT: 0, changes: 0, items: 0, outs: [], events: [] });
    const h = rec.h, from = now - 30 * DAY;
    if (!h.some((r) => r[3])) continue; // long-gone listings a store keeps online don't count against it
    a.items++;
    for (let n = 0; n < h.length; n++) {
      const s = Math.max(t(h[n][0]), from), e = n + 1 < h.length ? t(h[n + 1][0]) : now;
      if (e > s) { a.allT += e - s; if (h[n][3]) a.inT += e - s; }
      if (n && t(h[n][0]) >= from && h[n][1] !== h[n - 1][1] && h[n][1] && h[n - 1][1]) a.changes++;
      if (n && h[n][3] && !h[n - 1][3]) {
        a.outs.push((t(h[n][0]) - t(h[n - 1][0])) / DAY);
        if (now - t(h[n][0]) < 56 * DAY) a.events.push(h[n][0]);
      }
    }
    if (rec.first > H.started && now - t(rec.first) < 56 * DAY) a.events.push(rec.first);
  }
  const out = {};
  for (const [vid, a] of Object.entries(acc)) {
    const r = {};
    if (span >= 7 && a.allT) {
      const inStock = a.inT / a.allT, perItem = a.changes / a.items;
      const avgOut = a.outs.length ? a.outs.reduce((s, x) => s + x, 0) / a.outs.length : null;
      r.reliability = { score: Math.round(100 * (0.55 * inStock + 0.25 * (1 - Math.min(1, perItem / 3)) + 0.2 * (avgOut == null ? 0.7 : 1 - Math.min(1, avgOut / 30)))), inStock: Math.round(inStock * 100), priceChanges: +perItem.toFixed(2), avgDaysOut: avgOut == null ? null : +avgOut.toFixed(1), days: Math.round(span) };
    }
    // count each drop date once, and ignore the day the store was first tracked (everything looks "new" then)
    const dates = [...new Set(a.events)].filter((d) => d !== vFirst[vid]);
    if (dates.length >= 4) {
      const byDay = [0, 0, 0, 0, 0, 0, 0];
      for (const d of dates) byDay[new Date(d + 'T12:00:00Z').getUTCDay()]++;
      const top = byDay.indexOf(Math.max(...byDay)), share = byDay[top] / dates.length;
      if (share >= 0.4) r.dropDay = { day: WEEKDAYS[top], share: Math.round(share * 100), dates: dates.length };
    }
    out[vid] = r;
  }
  return out;
}

// ---------- local dispensary menus (captures/local-<id>.json from the capture bookmark on Dutchie) ----------
// Deal = price per gram after your discount vs the median of the same type and size on that store's own menu,
// so a good Ayr deal ranks next to a good online deal. vsOnline compares with the online S/A median.
const LOCAL_CAT = (p) => {
  const t = `${p.name} ${p.subcategory || ''}`;
  if (p.category === 'Flower') return 'flower';
  if (p.category === 'Pre-Rolls') return 'preroll';
  if (p.category === 'Vaporizers') return 'vape';
  if (p.category === 'Concentrate') return /rosin|hash|solventless|ice ?water/i.test(t) ? 'rosin' : 'concentrate';
  return 'edible';
};
function localStore(L, onlineMedians) {
  const snap = readJson(path.join(DIR, 'captures', `local-${L.id}.json`), null);
  const stat = { id: L.id, name: L.name, url: L.url, tier: 'L', platform: 'local', local: true, place: L.place, discount: L.discount || null, status: 'ok', count: 0, scrapedAt: snap?.fetchedAt || null, shipping: {}, promos: [], noShip: [] };
  if (!snap?.products?.length) { stat.status = 'error'; stat.error = 'No menu captured yet: open the Dutchie menu and tap the capture bookmark'; return { items: [], stat }; }
  if (Date.now() - new Date(snap.fetchedAt) > 3 * 864e5) stat.status = 'stale';
  const off = (L.discount?.pct || 0) / 100;
  const by = new Map();
  for (const p of snap.products) { const k = p.handle || p.url; if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  const items = [];
  for (const [handle, rows] of by) {
    const p = rows[0], category = LOCAL_CAT(p);
    const variants = rows.map((r) => {
      const g = category === 'edible' ? null : parseGrams(r.size);
      const pay = +(r.price * (1 - off)).toFixed(2);
      return { label: r.size || 'Each', grams: g, price: pay, menuPrice: r.price, compareAt: r.originalPrice ? +(r.originalPrice * (1 - off)).toFixed(2) : null, available: true, ppg: g ? +(pay / g).toFixed(2) : null };
    });
    const best = variants.filter((x) => x.ppg).sort((a, b) => a.ppg - b.ppg)[0] || null;
    const thcPct = p.thcUnit === '%' ? p.thc : null;
    items.push({
      id: `${L.id}:${handle}`, vendorId: L.id, local: true, title: p.name, brand: p.brand || null, category, url: p.url, image: p.image || null, variants,
      available: true, minPrice: Math.min(...variants.map((x) => x.price)), bestPpg: best?.ppg ?? null, bestPpgLabel: best?.label ?? null, bestPpgGrams: best?.grams ?? null, bestPpgPrice: best?.price ?? null,
      effPpg: best?.ppg ?? null, effGrams: best?.grams ?? null, onSale: variants.some((x) => x.compareAt),
      thca: thcPct, thcMg: p.thcUnit === 'mg' ? p.thc : null, strainType: p.type || null, effects: p.effects || [], terpenes: p.terpenes ?? null,
      hashmaker: findHashmaker(`${p.name} ${p.brand || ''}`), thirdParty: p.brand || null, stale: stat.status === 'stale' || undefined, tier: 'L', pinned: false,
    });
  }
  // deal vs this store's own menu (same type + size band), and vs the online S/A median
  const med = {};
  for (const i of items) if (i.effPpg) (med[`${i.category}:${bucket(i)}`] ||= []).push(i.effPpg);
  const catAll = {}; for (const [k, a] of Object.entries(med)) (catAll[k.split(':')[0]] ||= []).push(...a);
  for (const i of items) {
    const k = `${i.category}:${bucket(i)}`;
    const m = median((med[k]?.length >= 5 ? med[k] : catAll[i.category]) || []);
    i.dealRatio = i.effPpg && m ? +(m / i.effPpg).toFixed(2) : null;
    i.vsOnline = i.effPpg && onlineMedians[k] ? +(onlineMedians[k] / i.effPpg).toFixed(2) : null;
    // quality: a mid baseline, plus potency for its type
    let q = 30 + 8;
    if (i.thca != null) q += i.category === 'flower' || i.category === 'preroll' ? Math.max(-6, Math.min(12, (i.thca - 22) * 1.2)) : Math.max(-6, Math.min(12, (i.thca - 70) * 0.6));
    if (i.hashmaker) q += 6;
    i.quality = Math.round(Math.max(0, Math.min(100, q * (100 / 80))));
    i.value = i.dealRatio ? Math.round(i.quality * Math.sqrt(Math.max(0.5, Math.min(2, i.dealRatio)))) : null;
    i.group = groupKey(i);
  }
  stat.count = items.length;
  stat.localMedians = Object.fromEntries(Object.entries(med).map(([k, a]) => [k, +median(a).toFixed(2)]));
  return { items, stat };
}

// ---------- main ----------
async function main() {
  const prev = readJson(path.join(DIR, 'data.json'), { items: [], vendors: [] });
  const vendors = cfg.vendors.filter((v) => !ONLY || ONLY.includes(v.id));
  let items = [];
  const vstat = [];
  const redditCache = readJson(path.join(CACHE, 'reddit.json'), {});
  for (const v of vendors) {
    log(`== ${v.name} (${v.tier}, ${v.platform})`);
    const st = { id: v.id, name: v.name, url: v.url, tier: v.tier, platform: v.platform, status: 'ok', count: 0, scrapedAt: new Date().toISOString() };
    let vi = [];
    if (REDDIT_ONLY) {
      vi = prev.items.filter((i) => i.vendorId === v.id);
      Object.assign(st, prev.vendors.find((x) => x.id === v.id) || {});
    } else try {
      let raw;
      if (v.platform === 'browser') {
        // catalog captured from the in-app browser after the user passes the site's bot check
        const snap = readJson(path.join(DIR, 'captures', `browser-${v.id}.json`), null);
        if (!snap?.products?.length) throw new Error('no browser capture yet; open the site in the app browser and pass the bot check');
        raw = snap.products;
        st.scrapedAt = snap.fetchedAt;
        if (Date.now() - new Date(snap.fetchedAt) > 3 * 864e5) st.status = 'stale';
      } else raw = FROM_CACHE && fs.existsSync(path.join(CACHE, `raw-${v.id}.json`)) ? readJson(path.join(CACHE, `raw-${v.id}.json`), []) : v.platform === 'shopify' ? await shopify(v) : v.platform === 'woo' ? await woo(v) : v.platform === 'square' ? await square(v) : await jsonld(v);
      fs.writeFileSync(path.join(CACHE, `raw-${v.id}.json`), JSON.stringify(raw));
      vi = raw.map((p) => makeItem(v, p)).filter(Boolean);
      if (!NO_REVIEWS && v.platform === 'shopify') await addPageReviews(v, vi);
      if (v.platform !== 'browser') await addPageImages(v, vi);
      st.count = vi.length;
      log(`  ${raw.length} products -> ${vi.length} THCa items`);
      try {
        const info = await storeInfo(v, prev.vendors.find((x) => x.id === v.id));
        st.shipping = info.shipping || {}; st.promos = info.promos || []; st.noShip = info.noShip || []; st.labPage = info.labPage || null; st.shipPolicy = info.policy ? { pages: info.policy.pages || 0, nationwide: !!info.policy.nationwide, listed: (info.noShip || []).length > 0 } : null;
        // a "COA" link shared by many products is the store's general lab page, not a per-product report
        const counts = {}; for (const i of vi) if (i.coa) counts[i.coa.url] = (counts[i.coa.url] || 0) + 1;
        for (const [u, n] of Object.entries(counts)) if (n >= 3) { st.labPage ||= u; for (const i of vi) if (i.coa?.url === u) i.coa = null; }
        // a lab page that is a blog post or another site is not a list of reports
        const bare = (u) => new URL(u).host.replace(/^www\./, '');
        if (st.labPage && (/\/blogs?\//i.test(st.labPage) || (bare(st.labPage) !== bare(v.url) && !LAB_FILE.test(st.labPage)))) st.labPage = null;
        try { const n = await addLabMatches(v, vi, st.labPage); if (n) log(`  lab page: matched ${n} products to reports`); } catch (e) { log("  lab page failed", e.message); }
        if (st.promos.length || st.shipping.freeOver) log(`  store: ${st.shipping.freeOver ? `free shipping $${st.shipping.freeOver}+` : ''} ${st.promos.map((p) => p.code || p.text).join(', ')}`);
      } catch (e) { log('  store info failed', e.message); }
    } catch (e) {
      st.status = 'error'; st.error = e.message;
      const old = prev.items.filter((i) => i.vendorId === v.id);
      if (old.length) { vi = old.map((i) => ({ ...i, stale: true })); st.status = 'stale'; st.count = vi.length; st.scrapedAt = prev.vendors.find((x) => x.id === v.id)?.scrapedAt; }
      log(`  FAILED: ${e.message}${old.length ? ` (kept ${old.length} cached items)` : ''}`);
    }
    if (!NO_REDDIT) {
      try {
        const rb = await reddit(v);
        for (const i of vi) productReddit(i, rb._docs, v);
        delete rb._docs;
        redditCache[v.id] = { ...rb, t: Date.now() };
        log(`  reddit: ${rb.mentions} mentions, sentiment ${rb.sentiment}`);
      } catch (e) { log('  reddit failed', e.message); }
    }
    const rc = redditCache[v.id];
    st.reddit = rc ? { mentions: rc.mentions, sentiment: rc.sentiment, recent: rc.recent, says: rc.says, top: rc.top } : null;
    if (!st.shipping) { const pv = prev.vendors.find((x) => x.id === v.id); st.shipping = pv?.shipping || v.shipping || {}; st.promos = pv?.promos || []; st.noShip = v.noShip || pv?.noShip || []; st.labPage = pv?.labPage || null; }
    vstat.push(st);
    items.push(...vi);
  }
  fs.writeFileSync(path.join(CACHE, 'reddit.json'), JSON.stringify(redditCache));

  // keep vendors not scraped this run (when using --only)
  // keep online vendors not scraped this run (local dispensaries are rebuilt below from their capture every run)
  const localIds = new Set((cfg.local || []).map((l) => l.id));
  if (ONLY) { for (const pv of prev.vendors) if (!ONLY.includes(pv.id) && !localIds.has(pv.id)) vstat.push(pv); items.push(...prev.items.filter((i) => !ONLY.includes(i.vendorId) && !localIds.has(i.vendorId))); }

  // price with shipping: the cheapest per-gram size once shipping for that order is added.
  // Unknown terms → assume $10 shipping, free at $100 (typical), and flag it as an estimate.
  const shipOf = Object.fromEntries(vstat.map((s) => {
    const sh = s.shipping || {};
    const known = sh.freeOver != null || sh.cost != null;
    return [s.id, known ? { cost: sh.cost ?? SHIP_GUESS, freeOver: sh.freeOver ?? null, estimated: sh.cost == null } : { cost: SHIP_GUESS, freeOver: 100, estimated: true }];
  }));
  for (const i of items) {
    const ship = shipOf[i.vendorId];
    let best = null;
    for (const x of i.variants) {
      if (!x.ppg || (i.available && !x.available)) continue;
      const L = landed(x.price, ship); const lp = L / x.grams;
      if (!best || lp < best.lp) best = { lp, L, x };
    }
    i.shipPpg = best ? +best.lp.toFixed(2) : null;
    i.shipPrice = best ? +best.L.toFixed(2) : null;
    i.shipLabel = best ? best.x.label : null;
    i.shipFree = best ? best.L === best.x.price : null;
    i.shipEstimated = ship.estimated || undefined;
    i.effPpg = i.shipPpg ?? i.bestPpg;
    i.effGrams = best?.x.grams ?? i.bestPpgGrams;
    i.group = groupKey(i);
    // with the store's best public promo code (not first-order-only), shipping figured on the discounted total
    const promo = bestPromo(vstat.find((s) => s.id === i.vendorId)?.promos);
    if (promo && i.shipPpg) {
      let cb = null;
      for (const x of i.variants) {
        if (!x.ppg || (i.available && !x.available)) continue;
        const lp = landed(x.price * (1 - promo.pct / 100), ship) / x.grams;
        if (!cb || lp < cb) cb = lp;
      }
      if (cb && cb < i.shipPpg) { i.codePpg = +cb.toFixed(2); i.code = promo.code || null; i.codePct = promo.pct; }
    }
    // mg of THCa per dollar, from the listed potency and the shipped price per gram
    if (i.thca && i.effPpg) i.mgPerDollar = Math.round((i.thca * 10) / i.effPpg);
  }

  // medians of shipped $/g from S/A in-stock items, per category+size bucket
  const tierOf = Object.fromEntries(cfg.vendors.map((v) => [v.id, v.tier]));
  const pinnedOf = Object.fromEntries(cfg.vendors.map((v) => [v.id, v.pinned]));
  const medians = {};
  for (const i of items) {
    if (!i.effPpg || !i.available || !['S', 'A+', 'A'].includes(tierOf[i.vendorId])) continue;
    (medians[`${i.category}:${bucket(i)}`] ||= []).push(i.effPpg);
  }
  // a size band needs 8+ S/A items for its own median; otherwise use the whole category's
  const catAll = {};
  for (const [k, arr] of Object.entries(medians)) (catAll[k.split(':')[0]] ||= []).push(...arr);
  for (const k of Object.keys(medians)) medians[k] = +median(medians[k].length >= 8 ? medians[k] : catAll[k.split(':')[0]]).toFixed(2);
  // hash has few S/A listings, and rosin prices would distort it: use every in-stock hash item instead
  const hashAll = items.filter((i) => i.effPpg && i.available && bucket(i) === 'hash').map((i) => i.effPpg);
  if (hashAll.length >= 5) medians['rosin:hash'] = +median(hashAll).toFixed(2);
  const vr = Object.fromEntries(vstat.map((v) => [v.id, v.reddit]));
  const VS = vendorStats();
  for (const s of vstat) { s.reliability = VS[s.id]?.reliability || null; s.dropDay = VS[s.id]?.dropDay || null; }
  for (const i of items) {
    i.tier = tierOf[i.vendorId];
    i.pinned = !!pinnedOf[i.vendorId];
    const med = medians[`${i.category}:${bucket(i)}`];
    i.dealRatio = i.effPpg && med ? +(med / i.effPpg).toFixed(2) : null;
    let q = TIER_PTS[i.tier] ?? 10;
    if (i.hashmaker) q += 12; else if (i.thirdParty) q += 6;
    if (i.rating && i.reviewCount) { const bay = (i.rating * i.reviewCount + 4.3 * 5) / (i.reviewCount + 5); q += Math.max(0, Math.min(20, ((bay - 3.5) / 1.5) * 20)); } else q += 8;
    const r = vr[i.vendorId];
    // sentence-level sentiment runs about -0.15..+0.15; scale to roughly ±10 points, trusting it more with more mentions
    if (r?.mentions) q += Math.max(-10, Math.min(10, r.sentiment * 80)) * Math.min(1, r.mentions / 20);
    if (i.redditMentions) q += Math.min(8, i.redditMentions * 2) * (i.redditSent >= 0 ? 1 : -1);
    const rel = VS[i.vendorId]?.reliability?.score;
    if (rel != null) q += Math.max(-4, Math.min(4, (rel - 70) / 6)); // dependable stores get a small edge
    i.quality = Math.round(Math.max(0, Math.min(100, q * (100 / 80))));
    i.value = i.dealRatio ? Math.round(i.quality * Math.sqrt(Math.max(0.5, Math.min(2, i.dealRatio)))) : null;
    i.bDeal = i.tier === 'B' ? !!(i.dealRatio && i.dealRatio >= 1.33) : null;
    if (i.codePpg && med) {
      i.dealRatioCode = +(med / i.codePpg).toFixed(2);
      i.valueCode = Math.round(i.quality * Math.sqrt(Math.max(0.5, Math.min(2, i.dealRatioCode))));
      if (i.tier === 'B') i.bDealCode = i.dealRatioCode >= 1.33;
    }
  }
  // local dispensaries (Ayr Carytown): captured menus, your standing discount taken off every price
  for (const L of cfg.local || []) {
    const { items: li, stat } = localStore(L, medians);
    vstat.push(stat); items.push(...li);
    log(`== ${L.name} (local): ${li.length} products${stat.status === 'stale' ? ' (menu older than 3 days)' : ''}`);
  }
  // online products the store doesn't describe: borrow strain type and effects from the dispensary menu's same strain
  const known = {};
  for (const i of items) if (i.local && (i.effects?.length || i.strainType)) { const k = (groupKey(i) || '').split(':')[1]; if (k) known[k] ||= i; }
  let borrowed = 0;
  for (const i of items) {
    if (i.local) continue;
    const k = (i.group || groupKey(i) || '').split(':')[1]; const src = k && known[k];
    if (!src) continue;
    if (!i.strainType && src.strainType) i.strainType = src.strainType;
    if (!i.effects?.length && src.effects?.length) { i.effects = src.effects.slice(0, 5); i.effectsFrom = 'menu'; borrowed++; }
  }
  log(`strain info: ${items.filter((i) => !i.local && i.strainType).length} online products with a strain type, ${items.filter((i) => !i.local && i.effects?.length).length} with effects (${borrowed} from the dispensary menu)`);
  updateHistory(items);
  const out = { generatedAt: new Date().toISOString(), medians, vendors: vstat, items };
  fs.writeFileSync(path.join(DIR, 'data.json'), JSON.stringify(out));
  log(`done: ${items.length} items from ${vstat.filter((v) => v.count).length}/${vstat.length} vendors`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Weed Scout capture bookmarklet. capture.html turns this file into the "javascript:" bookmark.
// Tap it on White Ash Reserve or Crysp (after passing their bot check). It reads the store's
// in-stock catalog in that tab, makes small photo copies for Crysp, and hands everything to
// capture.html, which commits it to GitHub. Pushing a capture starts a site refresh.
(async () => {
  const SITE = 'https://rwardensky.github.io';
  const host = location.hostname.replace(/^www\./, '');
  const id = host === 'dutchie.com' && /ayr-va-carytown/.test(location.pathname) ? 'ayr' : { 'whiteashreserve.com': 'war', 'shopcrysp.com': 'crysp', 'shophellomary.com': 'hellomary' }[host];
  if (!id) { alert('Weed Scout: open White Ash Reserve, Crysp, Hello Mary, or the Ayr Carytown menu on dutchie.com first, then tap this bookmark.'); return; }
  // Open the upload page now, while the tap still counts as a click (later would be popup-blocked).
  const win = window.open(SITE + '/weed-scout/capture.html', 'weedscout-capture');
  if (!win) { alert('Weed Scout: allow pop-ups for this site, then tap the bookmark again.'); return; }
  const ready = new Promise((res) => addEventListener('message', (e) => { if (e.origin === SITE && e.data === 'ws-ready') res(); }));
  const say = (text) => win.postMessage({ ws: 'status', text }, SITE);
  if (id === 'ayr') { await ayr(); return; }
  try {
    const base = '/wp-json/wc/store/v1/products';
    const all = async (q) => {
      const out = [];
      for (let p = 1; p <= 30; p++) {
        const r = await fetch(`${base}?per_page=99&page=${p}${q}`);
        if (!r.ok) { if (p === 1) throw new Error(`store returned ${r.status} (pass the security check first)`); break; }
        const j = await r.json(); if (!j.length) break; out.push(...j); if (j.length < 99) break;
      }
      return out;
    };
    await ready.catch(() => {});
    say('Reading products…');
    const parents = (await all('')).filter((p) => p.type !== 'variation');
    const kids = {}; for (const x of await all('&type=variation')) (kids[x.parent] ||= []).push(x);
    const money = (pr, k) => +(pr?.[k] || 0) / 10 ** (pr?.currency_minor_unit ?? 2);
    const dec = (s) => { const t = document.createElement('textarea'); t.innerHTML = s || ''; return t.value; };
    const BRANDS = { HRC: 'Hash Rosin Co', HCS: 'HCS' };
    const SKIP = /accessor|merch|apparel|gumm|edible|bags|hats|shirts/i;
    const products = [];
    for (const p of parents) {
      const vs = ((kids[p.id] || []).length
        ? kids[p.id].map((k) => ({ label: dec(k.variation).replace(/^[^:]*:\s*/, ''), price: money(k.prices, 'price'), reg: money(k.prices, 'regular_price'), ok: k.is_in_stock !== false }))
        : [{ label: '', price: money(p.prices, 'price'), reg: money(p.prices, 'regular_price'), ok: p.is_in_stock }])
        .filter((v) => v.ok && v.price > 0)
        .map((v) => ({ label: /\d|eighth|quarter|half|ounce|oz|gram/i.test(v.label) ? v.label.slice(0, 30) : '', price: v.price, compareAt: v.reg > v.price ? v.reg : null, available: true }));
      if (!vs.length) continue;
      const cats = (p.categories || []).map((c) => dec(c.name));
      if (cats.length && cats.every((c) => SKIP.test(c))) continue;
      const title = dec(p.name);
      const link = String(p.permalink || '').split('?')[0];
      products.push({
        handle: p.slug, title, type: '', tags: [], cats,
        brand: BRANDS[title.split(/[\s–-]+/)[0]] || null,
        url: link.startsWith(location.origin + '/') ? link : `${location.origin}/product/${p.slug}/`,
        rating: +p.average_rating || null, reviewCount: +p.average_rating ? p.review_count : null,
        image: (p.images?.[0]?.thumbnail || p.images?.[0]?.src || '').split('?')[0] || null,
        variants: dedupe(vs),
      });
    }
    // Crysp blocks its images on other sites, so send small copies for the repo to host.
    const photos = {};
    if (id === 'crysp') {
      const urls = [...new Set(products.map((p) => p.image).filter(Boolean))];
      let n = 0;
      for (const u of urls) {
        say(`Making photo copies ${++n}/${urls.length}…`);
        try {
          const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
          const s = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          let data = c.toDataURL('image/webp', 0.7), ext = 'webp';
          if (!data.startsWith('data:image/webp')) { data = c.toDataURL('image/jpeg', 0.75); ext = 'jpg'; } // Safari can't write WebP
          const name = u.split('/').pop().replace(/\.\w+$/, '').replace(/[^\w.-]/g, '') + '.' + ext;
          photos[name] = data.split(',')[1];
          for (const p of products) if (p.image === u) p.image = 'images/crysp/' + name;
        } catch { /* keep the original link */ }
      }
    }
    win.postMessage({ ws: 'capture', id, products, photos }, SITE);
  } catch (e) {
    win.postMessage({ ws: 'error', text: e.message || String(e) }, SITE);
  }
  // Ayr Carytown (Richmond, VA) medical menu on Dutchie, the same query Bud Finder uses
  async function ayr() {
    try {
      await ready.catch(() => {});
      say('Reading the Ayr Carytown menu…');
      const page = async (n) => {
        const variables = { includeEnterpriseSpecials: false, productsFilter: { dispensaryId: '68c87422b5ad629d60f984bb', pricingType: 'med', strainTypes: [], subcategories: [], Status: 'Active', types: [], useCache: true, isDefaultSort: true, sortBy: 'alpha', sortDirection: 1, bypassOnlineThresholds: false, ignoreQuantityThresholds: false, isKioskMenu: false, removeProductsBelowOptionThresholds: true, platformType: 'ONLINE_MENU', preOrderType: null }, page: n, perPage: 100 };
        const ext = { persistedQuery: { version: 1, sha256Hash: '91c683bfbce943059b6c958264577c1cff4a2623889a1c9db0be4a10ca7afd35' } };
        const r = await fetch('/api-2/graphql?operationName=FilteredProducts&variables=' + encodeURIComponent(JSON.stringify(variables)) + '&extensions=' + encodeURIComponent(JSON.stringify(ext)), { headers: { 'content-type': 'application/json' } });
        const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 160));
        return j.data.filteredProducts;
      };
      const first = await page(0); let all = first.products;
      for (let n = 1; n < first.queryInfo.totalPages; n++) all = all.concat((await page(n)).products);
      const eff = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ').toLowerCase();
      const products = all.filter((p) => !['Accessories', 'Apparel'].includes(p.type)).flatMap((p) => {
        const thc = p.THCContent?.range?.length ? Math.max(...p.THCContent.range) : null;
        const effects = Object.entries(p.effects || {}).filter(([, v]) => v >= 6).sort((a, b) => b[1] - a[1]).map(([k]) => eff(k));
        const reg = p.medicalPrices || p.Prices || [], sale = p.medicalSpecialPrices || [];
        return (p.Options || ['N/A']).map((opt, i) => {
          const price = sale[i] ?? reg[i];
          return { name: p.Name, handle: p.cName, brand: p.brandName || '', category: p.type, subcategory: p.subcategory || '', type: p.strainType === 'N/A' ? '' : p.strainType,
            thc, thcUnit: p.THCContent?.unit === 'MILLIGRAMS' ? 'mg' : '%', price, originalPrice: reg[i] > price ? reg[i] : null, size: opt === 'N/A' ? '' : opt,
            effects, terpenes: p.totalTerpenes?.range?.[0] ?? null, image: p.Image || null, url: 'https://dutchie.com/embedded-menu/ayr-va-carytown/product/' + p.cName };
        }).filter((x) => x.price != null);
      });
      win.postMessage({ ws: 'capture', id: 'ayr', products, photos: {} }, SITE);
    } catch (e) { win.postMessage({ ws: 'error', text: e.message || String(e) }, SITE); }
  }
  function dedupe(vs) { const seen = new Set(); return vs.filter((v) => { const k = v.label + '|' + v.price; if (seen.has(k)) return false; seen.add(k); return true; }); }
})();

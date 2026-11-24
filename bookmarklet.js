// Weed Scout capture bookmarklet. capture.html turns this file into the "javascript:" bookmark.
// Tap it on White Ash Reserve or Crysp (after passing their bot check). It reads the store's
// in-stock catalog in that tab, makes small photo copies for Crysp, and hands everything to
// capture.html, which commits it to GitHub. Pushing a capture starts a site refresh.
(async () => {
  const SITE = 'https://rwardensky.github.io';
  const host = location.hostname.replace(/^www\./, '');
  const id = { 'whiteashreserve.com': 'war', 'shopcrysp.com': 'crysp' }[host];
  if (!id) { alert('Weed Scout: open White Ash Reserve or Crysp first, then tap this bookmark.'); return; }
  // Open the upload page now, while the tap still counts as a click (later would be popup-blocked).
  const win = window.open(SITE + '/weed-scout/capture.html', 'weedscout-capture');
  if (!win) { alert('Weed Scout: allow pop-ups for this site, then tap the bookmark again.'); return; }
  const ready = new Promise((res) => addEventListener('message', (e) => { if (e.origin === SITE && e.data === 'ws-ready') res(); }));
  const say = (text) => win.postMessage({ ws: 'status', text }, SITE);
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
  function dedupe(vs) { const seen = new Set(); return vs.filter((v) => { const k = v.label + '|' + v.price; if (seen.has(k)) return false; seen.add(k); return true; }); }
})();

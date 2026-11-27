// Weed Scout — Orders & reviews tab.
// Add an order by uploading a screenshot (read on this device with Tesseract OCR, then you confirm) or by typing it.
// Orders and reviews are kept in a "vault": on this device, and — once private sync is on — in vault.json in the
// repo, encrypted with a key only your devices and the tracking job know (the repo is public). The tracking job
// (track.mjs, GitHub Actions) asks Ship24 where each package is and writes the arrival date back into the vault.
// Uses globals from index.html: $, esc, money, cents, shortDate, D, V, W, ls, token, REPO, CAT_ICON, thumb, changed, renderStash.
(() => {
  const VKEY = 'ws-vault', KKEY = 'ws-vault-key';
  const now = () => Date.now();
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }; // your local date, not UTC
  const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 6);
  let V0 = ls.get(VKEY, null) || { orders: [], reviews: [], updatedAt: 0 };
  let remoteSha = null, syncState = 'local', syncMsg = '', pushTimer = null, editor = null, ocrBusy = '';
  const UI = { reviewSort: 'new', reviewStore: '', openReview: null, showDelivered: false, showKey: false };

  // bring over orders saved by the earlier device-only tracker
  const legacy = ls.get('ws-orders', null);
  if (legacy?.length) {
    for (const o of legacy) if (!V0.orders.some((x) => x.id === o.id)) V0.orders.push({ id: o.id, vid: o.vid, num: o.num || '', date: o.date, total: o.total ?? null, items: (o.items || '').split(/\s*,\s*/).filter(Boolean).map((n) => ({ id: uid(), name: n, qty: 1 })), track: o.track || '', status: o.status || 'ordered', updatedAt: now() });
    ls.set('ws-orders', []); V0.updatedAt = now(); ls.set(VKEY, V0);
  }
  const live = (arr) => arr.filter((x) => !x.deleted);

  // ---------- encryption (AES-256-GCM, WebCrypto) ----------
  const key = () => { try { return localStorage.getItem(KKEY) || ''; } catch { return ''; } };
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const cryptoKey = (k) => crypto.subtle.importKey('raw', fromB64(k), 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(key()), new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, alg: 'AES-256-GCM', note: 'Weed Scout orders and reviews, encrypted. Not readable without the owner\'s key.', iv: toB64(iv), data: toB64(new Uint8Array(ct)) };
  }
  async function unseal(file) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, await cryptoKey(key()), fromB64(file.data));
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ---------- sync with vault.json ----------
  function merge(a, b) {
    const pick = (x, y) => { const m = new Map(); for (const r of [...(x || []), ...(y || [])]) { const c = m.get(r.id); if (!c || (r.updatedAt || 0) > (c.updatedAt || 0)) m.set(r.id, r); } return [...m.values()]; };
    return { orders: pick(a.orders, b.orders), reviews: pick(a.reviews, b.reviews), tracking: (b.tracking?.lastRun || 0) > (a.tracking?.lastRun || 0) ? b.tracking : a.tracking || b.tracking, updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0) };
  }
  const same = (a, b) => JSON.stringify({ o: a.orders, r: a.reviews }) === JSON.stringify({ o: b.orders, r: b.reviews });
  const api = (path, opts = {}) => fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, { ...opts, headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  async function pull() {
    if (!token() || !key()) { syncState = token() ? 'nokey' : 'local'; return null; }
    const r = await api(`vault.json?ref=main&t=${now()}`).catch(() => null);
    if (!r) { syncState = 'offline'; return null; }
    if (r.status === 404) { remoteSha = null; syncState = 'on'; return { orders: [], reviews: [] }; }
    if (!r.ok) { syncState = 'error'; syncMsg = `GitHub said ${r.status}`; return null; }
    const j = await r.json(); remoteSha = j.sha;
    try { const file = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))))); const v = await unseal(file); syncState = 'on'; return v; }
    catch { syncState = 'badkey'; return null; }
  }
  async function load() {
    const remote = await pull();
    if (remote) { const m = merge(V0, remote); const changedHere = !same(m, remote); V0 = m; ls.set(VKEY, V0); if (changedHere) queuePush(); }
    relink();
    await loadBuzz();
    render();
  }
  // what Reddit says about things you bought (written by the tracking job, encrypted like the vault)
  let BUZZ = ls.get('ws-buzz', {});
  async function loadBuzz() {
    if (!token() || !key() || syncState === 'badkey') return;
    const r = await api(`vault-buzz.json?ref=main&t=${now()}`).catch(() => null);
    if (!r?.ok) return;
    try { const j = await r.json(); const v = await unseal(JSON.parse(atob(j.content.replace(/\n/g, '')))); BUZZ = v.buzz || {}; ls.set('ws-buzz', BUZZ); } catch {}
  }
  // ratings under each thing you ordered: yours, the store's, our score, and Reddit (with quotes to expand)
  function itemRatings(it, vid) {
    const p = it.productId && D?.items.find((i) => i.id === it.productId);
    const r = it.reviewId ? V0.reviews.find((x) => x.id === it.reviewId && !x.deleted) : live(V0.reviews).find((x) => x.name === it.name && x.vid === vid);
    const chips = [];
    if (r) chips.push(`<span class="rchip mine" title="Your review">You ${'★'.repeat(r.stars)}<i>${'★'.repeat(5 - r.stars)}</i></span>`);
    if (p?.rating) chips.push(`<span class="rchip" title="Star rating on the store's site">★ ${p.rating.toFixed(1)}${p.reviewCount ? ` <span class="note">(${p.reviewCount})</span>` : ''} at store</span>`);
    if (p) { chips.push(`<span class="rchip" title="Weed Scout quality score: store tier, hashmaker, reviews, Reddit, your ratings">Quality ${myQ(p)}</span>`); const d = dealWord(dr(p)); if (d && p.available) chips.push(`<span class="deal ${d.cls} mini" title="Today's price vs typical">${d.word} now</span>`); }
    const b = BUZZ[it.name] || (p?.redditSays?.length ? { n: p.redditMentions, sent: p.redditSent, says: p.redditSays } : null);
    let quotes = '';
    if (b?.n) {
      // mood from how many opinions lean each way (flat "just grabbed it" posts don't drag it to neutral)
      const pos = b.pos ?? (b.sent > 0.1 ? 1 : 0), neg = b.neg ?? (b.sent < -0.1 ? 1 : 0);
      const mood = pos && pos >= neg * 2 ? ['pos', 'mostly positive'] : neg && neg >= pos * 2 ? ['neg', 'mostly negative'] : pos || neg ? ['', 'mixed'] : ['', 'no strong opinions'];
      const scope = b.nStore ? `${b.nStore} name ${esc(V[vid]?.name || 'the store')}` : b.phrase ? 'about the strain, any store' : '';
      chips.push(`<span class="rchip reddit ${mood[0]}" title="Posts and comments in r/THCaFlower, r/THCAextracts, r/hashrosin and r/hempflowers from the last year">💬 Reddit ${b.n} post${b.n > 1 ? 's' : ''} · ${mood[1]}${scope ? ` · ${scope}` : ''}</span>`);
      if (b.says?.length) quotes = `<details class="iquotes"><summary>What Reddit says${b.phrase ? ` about “${esc(b.phrase)}”` : ''}</summary>${b.says.map((q) => `<blockquote class="rq ${q.sent > 0.1 ? 'pos' : q.sent < -0.1 ? 'neg' : ''}">“${esc(q.text)}”<cite><a href="${esc(q.link)}" target="_blank" rel="noopener">r/${esc(q.sub || 'reddit')}</a>${q.t ? ` · ${esc(q.t.slice(0, 7))}` : ''}</cite></blockquote>`).join('')}</details>`;
    }
    const term = (b?.phrase || it.name.replace(/\s*[-–]\s*\d.*$/, '')).trim();
    chips.push(`<a class="rchip link" href="https://www.reddit.com/search/?q=${encodeURIComponent(`"${term}"`)}" target="_blank" rel="noopener">Search Reddit ↗</a>`);
    if (!p && !b?.n && !r) chips.unshift('<span class="rchip muted" title="Not in the store\'s current list, usually because it sold out">No ratings yet</span>');
    return `<div class="irate">${chips.join('')}</div>${quotes}`;
  }
  // a product that was sold out when you ordered may be listed again later: link items and reviews to it then
  function relink() {
    if (!D) return;
    let n = 0;
    for (const o of live(V0.orders)) for (const it of o.items || []) if (!it.productId) { const p = matchProduct(o.vid, it.name); if (p) { it.productId = p.id; o.updatedAt = now(); n++; } }
    for (const r of live(V0.reviews)) if (!r.productId) {
      const p = matchProduct(r.vid, r.name);
      if (p) { r.productId = p.id; r.updatedAt = now(); n++; const t = r.stars >= 4 ? 1 : r.stars <= 2 ? -1 : 0; if (t && !W.ratings[p.id]) { W.ratings[p.id] = { r: t, note: '', t: today() }; changed(); } }
    }
    if (n) { ls.set(VKEY, V0); queuePush(); }
  }
  function save() { V0.updatedAt = now(); ls.set(VKEY, V0); render(); queuePush(); }
  function queuePush() { clearTimeout(pushTimer); if (token() && key() && syncState !== 'badkey') pushTimer = setTimeout(push, 1200); }
  async function push(retry = true) {
    const body = { message: 'Update orders and reviews (encrypted)', content: btoa(JSON.stringify(await seal(V0), null, 1)), branch: 'main', ...(remoteSha ? { sha: remoteSha } : {}) };
    const r = await api('vault.json', { method: 'PUT', body: JSON.stringify(body) }).catch(() => null);
    if (r?.ok) { remoteSha = (await r.json()).content.sha; syncState = 'on'; syncMsg = ''; render(); return; }
    if (retry && r && (r.status === 409 || r.status === 422)) { const remote = await pull(); if (remote) { V0 = merge(V0, remote); ls.set(VKEY, V0); } return push(false); }
    syncState = 'error'; syncMsg = r ? `GitHub said ${r.status}` : "couldn't reach GitHub"; render();
  }

  // ---------- carriers, stores, products ----------
  function carrierOf(raw) {
    const t = (raw || '').replace(/[\s-]/g, '').toUpperCase();
    if (!t) return null;
    if (/^1Z[0-9A-Z]{16}$/.test(t)) return { name: 'UPS', url: `https://www.ups.com/track?tracknum=${t}` };
    if (/^9[1-5]\d{18,24}$/.test(t) || /^420\d{5}9\d{19,25}$/.test(t) || /^[A-Z]{2}\d{9}US$/.test(t)) return { name: 'USPS', url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}` };
    if (/^\d{12}$|^\d{15}$/.test(t)) return { name: 'FedEx', url: `https://www.fedex.com/fedextrack/?trknbr=${t}` };
    if (/^\d{10}$/.test(t)) return { name: 'DHL', url: `https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=${t}` };
    return { name: 'USPS', url: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}` };
  }
  function storeOrderPage(vid) {
    const v = V[vid] || {}; if (!v.url) return null;
    const woo = v.platform === 'woo' || ['war', 'crysp', 'hellomary'].includes(vid);
    return v.platform === 'shopify' ? `${v.url}/account` : woo ? `${v.url}/my-account/orders/` : v.url;
  }
  const words = (s) => (s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(' ').filter((w) => w.length > 1 && !/^(thca|the|and|of|with|for|by|g|oz)$/.test(w));
  // best catalog match at that store for a line like "Small Batch Cheerios - 3.5g"
  function matchProduct(vid, name) {
    if (!D || !name) return null;
    const w = new Set(words(name).filter((x) => !/^\d/.test(x)));
    if (!w.size) return null;
    let best = null;
    for (const i of D.items) {
      if (vid && i.vendorId !== vid) continue;
      const iw = new Set(words(i.title).filter((x) => !/^\d/.test(x)));
      let hit = 0; for (const x of w) if (iw.has(x)) hit++;
      // most of your words must be in the title, and the title shouldn't be mostly other words
      const score = (hit / w.size) * 0.8 + (hit / Math.max(iw.size, 1)) * 0.2;
      if (!best || score > best.score) best = { i, score, hit };
    }
    // "Small Batch Cheerios" must not land on "Small Batch Tangelo": nearly every word has to match
    return best && best.score >= 0.75 && best.hit >= Math.min(2, w.size) ? best.i : null;
  }
  const gramsIn = (s) => { const m = (s || '').match(/(\d+(?:\.\d+)?)\s*(g|gram|grams|oz|ounce)\b/i); return m ? +m[1] * (/oz|ounce/i.test(m[2]) ? 28 : 1) : null; };

  // ---------- reading an order screenshot ----------
  let tessLoad = null;
  const loadTess = () => tessLoad ||= new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload = ok; s.onerror = () => no(new Error('Could not load the text reader')); document.head.append(s); });
  async function readScreenshot(file) {
    ocrBusy = 'Loading the text reader…'; render();
    try {
      await loadTess();
      const worker = await Tesseract.createWorker('eng', 1, { logger: (m) => { if (m.status === 'recognizing text') { ocrBusy = `Reading your screenshot… ${Math.round(m.progress * 100)}%`; const el = $('#ocrMsg'); if (el) el.textContent = ocrBusy; } } });
      const { data } = await worker.recognize(await prepImage(file), {}, { text: true, blocks: true });
      await worker.terminate();
      ocrBusy = '';
      const words = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push({ t: w.text, c: w.confidence, ...w.bbox });
      const parsed = parseOrderText(data.text, words);
      // a "your order shipped" email: tracking number but no items → add it to the order you already saved
      if (parsed.track && !parsed.items.length) {
        const o = live(V0.orders).filter((x) => x.status !== 'delivered' && (!parsed.vid || x.vid === parsed.vid) && (!x.track || x.track.replace(/\s/g, '') !== parsed.track))
          .sort((a, b) => !!a.track - !!b.track || b.date.localeCompare(a.date))[0];
        if (o) { o.track = parsed.track; o.status = 'shipped'; delete o.trk; o.updatedAt = now(); flash = `📦 Added tracking ${parsed.track} to your ${V[o.vid]?.name || ''} order${o.num ? ` #${o.num}` : ''}.`; save(); return; }
        flash = 'That looks like a shipping email, but there\'s no matching order yet. Add the order below (or its confirmation screenshot first).';
      }
      openEditor(parsed, true);
    } catch (e) { ocrBusy = ''; openEditor({ items: [] }, true); editor.warn = `Couldn't read that image (${e.message || e}). Type the details below instead.`; render(); }
  }
  // Order tables in emails and on store pages: photo | name (wrapped over several lines) | ×1 | $35.00.
  // Read by position: keep only words in the name column, split products at the big vertical gaps, take the
  // quantity from the ×N on the same rows. Photos to the left of the names read as junk, so they're dropped.
  function parseTable(words) {
    const qty = words.filter((w) => /^[^\w$]*[x×X]\s?\d{1,2}$/.test(w.t));
    if (!qty.length) return null;
    const qx = median(qty.map((w) => w.x0));
    const head = words.find((w) => /^product/i.test(w.t)), foot = words.find((w) => /^(sub)?total/i.test(w.t) && w.y0 > qty[0].y0);
    const top = head ? head.y1 : Math.min(...qty.map((w) => w.y0)) - 400, bottom = foot ? foot.y0 : Infinity;
    let cand = words.filter((w) => w.x1 < qx - 4 && w.y0 > top && w.y1 < bottom && /[A-Za-z0-9]/.test(w.t));
    // the name column: the left edge most confident words share
    const edges = {}; for (const w of cand) if (w.c >= 60) { const k = Math.round(w.x0 / 20); edges[k] = (edges[k] || 0) + 1; }
    const nx = +(Object.entries(edges).sort((a, b) => b[1] - a[1])[0]?.[0] ?? NaN) * 20;
    if (isNaN(nx)) return null;
    // keep words that reach into the name column (a stray mark from the photo can glue onto "“Peaches"); photo junk ends before it
    cand = cand.filter((w) => w.x1 >= nx + 15 && w.x0 >= nx - 150).map((w) => (w.x0 < nx - 10 ? { ...w, t: w.t.replace(/^[^A-Za-z0-9]+/, '') } : w)).filter((w) => w.t).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    if (!cand.length) return null;
    // rows → products, split where the gap is much bigger than the usual line spacing
    const rows = [];
    for (const w of cand) { const r = rows.at(-1); if (r && Math.abs((w.y0 + w.y1) / 2 - r.y) < (w.y1 - w.y0) * 0.6) r.w.push(w); else rows.push({ y: (w.y0 + w.y1) / 2, w: [w] }); }
    const steps = rows.slice(1).map((r, k) => r.y - rows[k].y);
    const step = median(steps.length ? steps : [60]);
    const groups = [[rows[0]]];
    for (let k = 1; k < rows.length; k++) {
      const onlySize = rows[k].w.every((w) => !/[A-Za-z]{3}/.test(w.t)); // "- 2g" on its own line belongs to the name above
      if (rows[k].y - rows[k - 1].y > step * 1.7 && !onlySize) groups.push([]);
      groups.at(-1).push(rows[k]);
    }
    return groups.map((g) => {
      const y0 = g[0].y - step, y1 = g.at(-1).y + step;
      const q = qty.find((w) => (w.y0 + w.y1) / 2 > y0 && (w.y0 + w.y1) / 2 < y1);
      const name = g.map((r) => r.w.sort((a, b) => a.x0 - b.x0).map((w) => w.t).join(' ')).join(' ');
      return { name, qty: q ? +q.t.match(/(\d{1,2})$/)[1] : 1 };
    });
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
  // fix one-letter misreads ("omall" → "Small") against words that appear in product names
  let VOCAB = null;
  function spellFix(name) {
    if (!D) return name;
    VOCAB ||= (() => { const m = new Map(); for (const i of D.items) for (const w of i.title.split(/[^A-Za-z]+/)) if (w.length >= 4) m.set(w.toLowerCase(), (m.get(w.toLowerCase()) || 0) + 1); return m; })();
    return name.replace(/[A-Za-z]{4,}/g, (w) => {
      const lw = w.toLowerCase(); if (VOCAB.has(lw)) return w;
      let best = null;
      for (const [v, n] of VOCAB) if (Math.abs(v.length - lw.length) <= 1 && oneEdit(v, lw) && (!best || n > best.n)) best = { v, n };
      return best ? best.v.replace(/^./, (c) => (/[A-Z]/.test(w[0]) || w === lw ? c.toUpperCase() : c)) : w;
    });
  }
  // exactly one letter swapped, missing or extra ("omall"/"small", "emon"/"lemon")
  function oneEdit(a, b) {
    if (a === b) return false;
    if (a.length === b.length) { let d = 0; for (let k = 0; k < a.length; k++) if (a[k] !== b[k] && ++d > 1) return false; return d === 1; }
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    for (let k = 0; k < l.length; k++) if (l.slice(0, k) + l.slice(k + 1) === s) return true;
    return false;
  }
  let flash = '';
  // The text reader is trained on dark text on white. Dark-mode store pages (White Ash Reserve) and small phone
  // text read badly as-is, so: enlarge small images, go grayscale, flip light-on-dark to dark-on-light, add contrast.
  async function prepImage(file) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = bmp.width < 900 ? 2 : bmp.width < 1300 ? 1.5 : 1;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
      const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 64) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      const dark = sum / n < 128;
      for (let i = 0; i < d.length; i += 4) {
        let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (dark) y = 255 - y;
        y = (y - 140) * 1.8 + 140; // stretch contrast; faint grey labels become readable
        d[i] = d[i + 1] = d[i + 2] = y < 0 ? 0 : y > 255 ? 255 : y;
      }
      g.putImageData(im, 0, 0);
      return c;
    } catch { return file; }
  }
  const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  function parseOrderText(text, words = null) {
    const lines = text.split('\n').map((l) => l.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const all = lines.join('\n');
    const out = { items: [], raw: text };
    // store: a vendor name or domain anywhere in the text
    const low = all.replace(/\s+/g, ' ').toLowerCase();
    for (const v of D?.vendors || []) {
      const host = (v.url || '').replace(/^https?:\/\/(www\.)?/, '').split('.')[0];
      if (low.includes(v.name.toLowerCase()) || (host.length > 3 && low.includes(host)) || (v.name.split(' ').length > 1 && low.includes(v.name.split(' ').slice(0, 2).join(' ').toLowerCase()))) { out.vid = v.id; break; }
    }
    out.num = (all.match(/#\s?(\d{4,10})\b/) || all.match(/order\s*(?:number|no\.?|#|id)?\s*[:#]?\s*#?\s*([A-Z]{0,3}\d{4,10})\b/i) || all.match(/#\s?([A-Z0-9-]{4,12})\b/i) || [])[1] || '';
    const dm = all.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.? \\d{1,2},? \\d{4}`, 'i'));
    const dn = all.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
    if (dm) { const d = new Date(dm[0]); if (!isNaN(d)) out.date = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
    else if (dn) out.date = `${dn[3].length === 2 ? '20' + dn[3] : dn[3]}-${dn[1].padStart(2, '0')}-${dn[2].padStart(2, '0')}`;
    const totalLine = lines.filter((l) => /\btotal\b/i.test(l) && !/sub ?total/i.test(l)).pop();
    const amt = (l) => [...(l || '').matchAll(/\$\s?(\d{1,4}(?:,\d{3})*\.\d{2})/g)].map((m) => +m[1].replace(/,/g, ''));
    out.total = amt(totalLine).pop() ?? (amt(all).length ? Math.max(...amt(all)) : null);
    out.track = (all.replace(/\s(?=\d{4}\b)/g, '').match(/\b(1Z[0-9A-Z]{16}|9[1-5]\d{18,24}|[A-Z]{2}\d{9}US)\b/) || [])[1] || '';
    // items: every "1 × Name - 3.5g" anywhere in a line (order tables put the first item mid-row, after the date),
    // else "Name × 2", else lines that name a size; prices and status words are trimmed off
    const clean = (n) => n.replace(/(\d)\s?[¢€£]g?(?![a-z])/gi, '$1g').replace(/(\d)\s?q\b/g, '$1g').replace(/\$\s?\d[\d,.]*.*$/, '').replace(/\b(processing|completed|shipped|on hold|pending)\b.*$/i, '')
      .replace(/[“”"«»\[\]{}|_~]+/g, '').replace(/(^|\s)[.,;:]+(?=[A-Za-z])/g, '$1') // OCR junk from photos and borders
      .replace(/\s*[-–—]\s*(\d+(?:\.\d+)?\s?(?:g|oz|mg|ml)\b)/i, ' - $1').replace(/\s{2,}/g, ' ').replace(/[-–—\s]+$/, '').trim();
    // on a phone the item column is narrow, so "1 × Small Batch Cheerios - 3.5g" wraps over two or three lines:
    // glue the following lines on until the size shows up (or something that clearly isn't the name)
    const SIZE = /\b\d+(?:\.\d+)?\s*(?:g|gr|grams?|oz|ml|mg|ct|pk)\b/i;
    const QTY = /(?:^|\s)\d{1,2}\s*[x×X*]\s+\S/;
    const STOP = /\$|\b(total|subtotal|shipping|tax|status|processing|completed|order|date|qty|price|payment|actions?|view|account|details|billing)\b/i;
    const joined = [];
    for (let k = 0; k < lines.length; k++) {
      let l = lines[k];
      const tail = () => l.split(/\d{1,2}\s*[x×X*]\s+/).pop();
      for (let j = 0; j < 2 && QTY.test(l) && !SIZE.test(tail()) && k + 1 < lines.length; j++) {
        const nx = lines[k + 1];
        if (QTY.test(nx) || (STOP.test(nx) && !SIZE.test(nx))) break;
        l += ' ' + nx; k++;
      }
      joined.push(l);
    }
    // an order table read by position beats reading the text line by line
    const table = words && parseTable(words);
    if (table?.length) for (const t of table) { const name = spellFix(clean(t.name.replace(/^[^A-Za-z0-9]+/, ''))); if (name.length >= 3 && /[a-z]{3}/i.test(name)) out.items.push({ name, qty: t.qty }); }
    if (!out.items.length) for (const l of joined) for (const m of l.matchAll(/(?:^|\s)(\d{1,2})\s*[x×X*]\s+(.+?)(?=\s+\d{1,2}\s*[x×X*]\s|\s*\$|\s*$)/g)) {
      const name = clean(m[2]); if (name.length >= 3 && /[a-z]{3}/i.test(name)) out.items.push({ name, qty: +m[1] });
    }
    if (!out.items.length) {
      const skip = /\b(total|subtotal|shipping|tax|discount|coupon|payment|order|date|status|processing|completed|items?|qty|quantity|price|billing|address|email|phone|signed in|account|dashboard|view|log ?out)\b/i;
      for (const l of lines) {
        let m, name = null, qty = 1;
        if ((m = l.match(/^(.{3,}?)\s*[x×]\s*(\d{1,2})\b/))) { name = m[1]; qty = +m[2]; }
        else if (/\b\d+(?:\.\d+)?\s*(g|oz)\b/i.test(l) && !skip.test(l) && /[a-z]{3}/i.test(l)) name = l;
        if (name && (name = clean(name)).length >= 3) out.items.push({ name, qty });
      }
    }
    // store not named in the text (logos don't read well): a promo code it advertises, else whose catalog the items match
    if (!out.vid) {
      for (const v of D?.vendors || []) for (const p of v.promos || []) if (p.code && new RegExp(`\\bcode:?\\s+${p.code}\\b`, 'i').test(all)) out.vid ||= v.id;
    }
    if (!out.vid && out.items.length) {
      // one-word names ("Frozen") match too many stores to vote
      const votes = {}; for (const it of out.items) { if (it.name.split(/\s+/).filter((w) => /[a-z]{3}/i.test(w)).length < 2) continue; const p = matchProduct(null, it.name); if (p) votes[p.vendorId] = (votes[p.vendorId] || 0) + 1; }
      out.vid = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    }
    return out;
  }

  // ---------- the add / edit form ----------
  function openEditor(seed = {}, fromShot = false) {
    editor = { id: seed.id || null, vid: seed.vid || '', num: seed.num || '', date: seed.date || today(), total: seed.total ?? '', track: seed.track || '', items: (seed.items?.length ? seed.items : [{ name: '', qty: 1 }]).map((x) => ({ ...x })), fromShot, raw: seed.raw || '' };
    render();
    setTimeout(() => $('#oEdit')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }
  function editorHtml() {
    if (!editor) return '';
    const vendors = [...(D?.vendors || [])].filter((v) => !v.local).sort((a, b) => a.name.localeCompare(b.name));
    const items = editor.items.map((it, k) => {
      const p = matchProduct(editor.vid, it.name);
      return `<div class="eitem" data-k="${k}">
        <input class="eqty" type="number" min="1" max="99" value="${it.qty || 1}" aria-label="Quantity">
        <input class="ename" value="${esc(it.name)}" placeholder="Product and size, e.g. HRC T1 Frozen Peaches 2g" aria-label="Product" list="eList">
        <span class="ematch" title="${p ? `Matched to ${esc(p.title)}` : 'Not matched to a product in the catalog'}">${p ? `${p.image ? `<img src="${esc(thumb(p.image))}" alt="" referrerpolicy="no-referrer">` : CAT_ICON[p.category] || '✓'}<span class="mt">matched</span>` : ''}</span>
        <button class="linkbtn" data-eact="rm" aria-label="Remove item">✕</button></div>`;
    }).join('');
    return `<div class="card oedit" id="oEdit">
      <h3>${editor.id ? 'Edit order' : editor.fromShot ? '📸 Check what I read' : 'New order'}</h3>
      ${editor.fromShot && !editor.id ? '<p class="note">Read from your screenshot on this device; the image isn\'t saved anywhere. Fix anything it got wrong, then save.</p>' : ''}
      ${editor.warn ? `<p class="banner">${esc(editor.warn)}</p>` : ''}
      <div class="eform">
        <label><span>Store</span><select id="eStore"><option value="">Pick the store…</option>${vendors.map((v) => `<option value="${v.id}" ${v.id === editor.vid ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label><span>Order #</span><input id="eNum" value="${esc(editor.num)}" autocomplete="off"></label>
        <label><span>Ordered</span><input id="eDate" type="date" value="${esc(editor.date)}"></label>
        <label><span>Total paid</span><span class="money-in sm">$<input id="eTotal" type="number" step="0.01" min="0" value="${editor.total ?? ''}" inputmode="decimal"></span></label>
        <label class="wide"><span>Tracking # (add it now or later)</span><input id="eTrack" value="${esc(editor.track)}" autocomplete="off" placeholder="e.g. 9400 1118 9922 …"></label>
      </div>
      <div class="eitems"><span class="lbl">What you ordered</span>${items}<button class="linkbtn" data-eact="add">+ Add another item</button></div>
      <datalist id="eList">${(D?.items || []).filter((i) => !editor.vid || i.vendorId === editor.vid).slice(0, 400).map((i) => `<option value="${esc(i.title)}">`).join('')}</datalist>
      <div class="row"><button class="go" data-eact="save">Save order</button><button class="chip" data-eact="cancel">Cancel</button>${editor.raw ? '<details class="note"><summary>Text I read</summary><pre class="rawtext"></pre></details>' : ''}</div>
    </div>`;
  }
  function readEditor() {
    editor.vid = $('#eStore').value; editor.num = $('#eNum').value.trim().replace(/^#/, ''); editor.date = $('#eDate').value || today();
    editor.total = $('#eTotal').value === '' ? '' : +$('#eTotal').value; editor.track = $('#eTrack').value.trim();
    editor.items = [...document.querySelectorAll('#oEdit .eitem')].map((el, k) => ({ ...editor.items[k], qty: +el.querySelector('.eqty').value || 1, name: el.querySelector('.ename').value.trim() }));
  }
  function saveEditor() {
    readEditor();
    if (!editor.vid) { editor.warn = 'Pick the store first.'; render(); return; }
    const items = editor.items.filter((x) => x.name).map((x) => { const p = matchProduct(editor.vid, x.name); return { id: x.id || uid(), name: x.name, qty: x.qty || 1, grams: gramsIn(x.name) ?? (p ? null : null), productId: p?.id || x.productId || null, received: x.received || false, reviewId: x.reviewId || null, skip: x.skip || false }; });
    const prev = editor.id && V0.orders.find((o) => o.id === editor.id);
    const o = { ...(prev || {}), id: editor.id || uid(), vid: editor.vid, num: editor.num, date: editor.date, total: editor.total === '' ? null : editor.total, items, track: editor.track, updatedAt: now() };
    if (prev && prev.track !== o.track) delete o.trk; // new tracking number: start fresh
    o.status = prev?.status === 'delivered' ? 'delivered' : o.track ? 'shipped' : 'ordered';
    if (!prev) V0.orders.push(o); else V0.orders[V0.orders.indexOf(prev)] = o;
    editor = null; save();
  }

  // ---------- reviews ----------
  const SCORES = [['taste', 'Taste'], ['smell', 'Smell'], ['potency', 'Potency'], ['effect', 'Effect'], ['value', 'Value']];
  function toReview() {
    const out = [];
    for (const o of live(V0.orders)) if (o.status === 'delivered' || o.items.some((x) => x.received)) for (const it of o.items) if ((it.received || o.status === 'delivered') && !it.reviewId && !it.skip) out.push({ o, it });
    return out;
  }
  const stars = (n, name = '') => `<span class="stars" ${name ? `data-stars="${name}"` : ''} aria-label="${n || 0} of 5">${[1, 2, 3, 4, 5].map((k) => `<button type="button" data-v="${k}" class="${k <= (n || 0) ? 'on' : ''}" aria-label="${k} star${k > 1 ? 's' : ''}">★</button>`).join('')}</span>`;
  function reviewForm(o, it, r = {}) {
    const p = it.productId && D?.items.find((i) => i.id === it.productId);
    return `<div class="rform" data-oid="${o.id}" data-iid="${it.id}" data-rid="${r.id || ''}">
      <div class="rrow"><b>Overall</b>${stars(r.stars, 'stars')}</div>
      <div class="rscores">${SCORES.map(([k, l]) => `<div class="rrow"><span>${l}</span>${stars(r.scores?.[k], k)}</div>`).join('')}</div>
      <div class="rrow"><span>Buy again?</span><span class="seg rb"><button type="button" data-rb="yes" aria-pressed="${r.rebuy === true}">👍 Yes</button><button type="button" data-rb="maybe" aria-pressed="${r.rebuy === null && !!r.id}">🤔 Maybe</button><button type="button" data-rb="no" aria-pressed="${r.rebuy === false}">👎 No</button></span></div>
      <textarea class="mynote rnotes" rows="3" maxlength="1000" placeholder="Taste, smell, high, how it burned, jar weight…">${esc(r.notes || '')}</textarea>
      <div class="row"><button class="go" data-ract="save">Save review</button><button class="chip" data-ract="cancel">Cancel</button>${!r.id ? '<button class="linkbtn" data-ract="skip">Skip this one</button>' : ''}${p ? '<span class="note">Your stars also tune this product\'s score on the Deals tab.</span>' : ''}</div>
    </div>`;
  }
  function saveReview(form) {
    const o = V0.orders.find((x) => x.id === form.dataset.oid), it = o?.items.find((x) => x.id === form.dataset.iid);
    const val = (n) => +(form.querySelector(`[data-stars="${n}"]`)?.dataset.val || 0) || null;
    const st = val('stars');
    if (!st) { form.querySelector('.rrow b').insertAdjacentHTML('afterend', '<span class="rerr"> Pick 1–5 stars</span>'); return; }
    const rbBtn = form.querySelector('.rb [aria-pressed="true"]');
    const old = form.dataset.rid && V0.reviews.find((x) => x.id === form.dataset.rid);
    const r = { ...(old || {}), id: old?.id || uid(), orderId: o?.id || old?.orderId, itemId: it?.id || old?.itemId, productId: it?.productId || old?.productId || null, vid: o?.vid || old?.vid, name: it?.name || old?.name, stars: st,
      scores: Object.fromEntries(SCORES.map(([k]) => [k, val(k)]).filter(([, v]) => v)), rebuy: rbBtn ? { yes: true, no: false, maybe: null }[rbBtn.dataset.rb] : old?.rebuy ?? null,
      notes: form.querySelector('.rnotes').value.trim(), date: old?.date || today(), updatedAt: now() };
    if (old) V0.reviews[V0.reviews.indexOf(old)] = r; else V0.reviews.push(r);
    if (it) { it.reviewId = r.id; o.updatedAt = now(); }
    // thumbs on the Deals tab (no notes: the watchlist is public)
    if (r.productId) { const t = r.stars >= 4 ? 1 : r.stars <= 2 ? -1 : 0; if (t) W.ratings[r.productId] = { r: t, note: '', t: today() }; else delete W.ratings[r.productId]; changed(); }
    UI.openReview = null; save();
  }

  // ---------- rendering ----------
  const STEPS = ['ordered', 'shipped', 'out_for_delivery', 'delivered'];
  function stepOf(o) { if (o.status === 'delivered' || o.trk?.milestone === 'delivered') return 3; if (o.trk?.milestone === 'out_for_delivery') return 2; return o.track ? 1 : 0; }
  const fmtDay = (iso) => { const d = new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
  const daysAgo = (d) => Math.max(0, Math.round((now() - new Date(d + 'T12:00:00')) / 864e5));
  const ago = (t) => { const m = Math.round((now() - t) / 6e4); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  function etaLine(o) {
    const t = o.trk;
    if (o.status === 'delivered') return `Delivered${o.deliveredAt ? ` ${fmtDay(o.deliveredAt)}` : ''}`;
    if (!t) return o.track ? (V0.tracking?.hasKey ? 'Shipped · waiting for the first tracking check' : 'Shipped · arrival dates appear once automatic tracking is set up (bottom of this page)') : daysAgo(o.date) >= 5 ? '<span class="late">No tracking yet after 5 days. Check with the store.</span>' : 'Waiting for a tracking number';
    const MS = { info_received: 'Label created', in_transit: 'In transit', out_for_delivery: 'Out for delivery today', failed_attempt: 'Delivery attempted', available_for_pickup: 'Ready for pickup', exception: 'Problem with delivery', pending: 'Waiting for the carrier' };
    let s = MS[t.milestone] || 'In transit';
    if (t.eta && t.milestone !== 'out_for_delivery') {
      const due = new Date(t.eta.slice(0, 10) + 'T23:59:00');
      s += due < new Date() ? ` · <span class="late">running late (was due ${fmtDay(t.eta)})</span>` : ` · arriving <b>${fmtDay(t.eta)}</b>${t.etaTo && t.etaTo.slice(0, 10) !== t.eta.slice(0, 10) ? `–${fmtDay(t.etaTo)}` : ''}`;
    }
    return s;
  }
  function orderCard(o) {
    const v = V[o.vid] || {}, c = carrierOf(o.track), page = storeOrderPage(o.vid), step = stepOf(o);
    const its = o.items.map((it) => { const p = it.productId && D?.items.find((i) => i.id === it.productId); return `<li>${it.qty > 1 ? `${it.qty} × ` : ''}${p ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>` : esc(it.name)}${itemRatings(it, o.vid)}</li>`; }).join('');
    return `<div class="order st${step}" data-oid="${o.id}">
      <div class="ohead"><b>${esc(v.name || o.vid)}${o.num ? ` <span class="note">#${esc(o.num)}</span>` : ''}</b><span class="note">${o.total != null ? cents(+o.total) : ''}</span></div>
      <div class="steps" aria-label="Status: ${['Ordered', 'Shipped', 'Out for delivery', 'Delivered'][step]}">${['Ordered', 'Shipped', 'Out for delivery', 'Delivered'].map((l, k) => `<span class="${k <= step ? 'done' : ''}">${l}</span>`).join('')}</div>
      <div class="eta">${etaLine(o)}</div>
      ${o.trk?.last ? `<div class="note">Latest: ${esc(o.trk.last.status || '')}${o.trk.last.location ? `, ${esc(o.trk.last.location)}` : ''}${o.trk.last.at ? ` · ${fmtDay(o.trk.last.at)}` : ''}</div>` : ''}
      <div class="note">Ordered ${shortDate(o.date)} (${daysAgo(o.date) ? `${daysAgo(o.date)} days ago` : 'today'})</div>
      ${its ? `<ul class="oitems">${its}</ul>` : ''}
      <div class="row">
        ${c ? `<a class="watchbtn" href="${esc(c.url)}" target="_blank" rel="noopener">📍 ${esc(c.name)} tracking</a>` : `<input class="otrack" placeholder="Paste tracking #" aria-label="Tracking number" autocomplete="off"><button class="watchbtn" data-oact="track">Save</button>`}
        ${o.status !== 'delivered' ? '<button class="watchbtn" data-oact="received">✅ Got it</button>' : o.stashed ? '' : '<button class="watchbtn" data-oact="stash" title="Adds it to My stash (and to run-out reminders)">Add to my stash</button>'}
        ${page ? `<a class="linkbtn" href="${esc(page)}" target="_blank" rel="noopener">Store order page</a>` : ''}
        <button class="linkbtn" data-oact="edit">Edit</button><button class="linkbtn" data-oact="del">Remove</button>
      </div></div>`;
  }
  function reviewCard(r) {
    const p = r.productId && D?.items.find((i) => i.id === r.productId), v = V[r.vid] || {};
    if (UI.openReview === r.id) return `<div class="review card">${reviewForm({ id: r.orderId, vid: r.vid }, { id: r.itemId, productId: r.productId, name: r.name }, r)}</div>`;
    return `<div class="review card">
      <div class="rhead">${p?.image ? `<img class="thumb" src="${esc(thumb(p.image))}" alt="" referrerpolicy="no-referrer">` : `<div class="thumb ph c-${p?.category || 'flower'}">${CAT_ICON[p?.category] || '🌿'}</div>`}
        <div><b>${p ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name)}</b><div class="note">${esc(v.name || r.vid || '')} · ${shortDate(r.date)}</div></div>
        <span class="bigstars" aria-label="${r.stars} of 5">${'★'.repeat(r.stars)}<i>${'★'.repeat(5 - r.stars)}</i></span></div>
      ${Object.keys(r.scores || {}).length ? `<div class="rchips">${SCORES.filter(([k]) => r.scores[k]).map(([k, l]) => `<span class="tag">${l} ${r.scores[k]}/5</span>`).join('')}${r.rebuy === true ? '<span class="tag move">Would rebuy</span>' : r.rebuy === false ? '<span class="tag sale">Wouldn\'t rebuy</span>' : ''}</div>` : r.rebuy != null ? `<div class="rchips">${r.rebuy ? '<span class="tag move">Would rebuy</span>' : '<span class="tag sale">Wouldn\'t rebuy</span>'}</div>` : ''}
      ${r.notes ? `<p class="rnote">${esc(r.notes)}</p>` : ''}
      <div class="row"><button class="linkbtn" data-ract="edit" data-rid="${r.id}">Edit</button><button class="linkbtn" data-ract="del" data-rid="${r.id}">Delete</button></div></div>`;
  }
  function syncCard() {
    const t = V0.tracking || {};
    const trackTxt = t.hasKey ? `🚚 Arrival dates: on · checked ${t.lastRun ? ago(t.lastRun) : 'soon'}${t.error ? ` · <span class="late">${esc(t.error)}</span>` : ''}` : '🚚 Arrival dates: off until the free Ship24 key is added (steps below)';
    const lines = {
      local: '💾 Saved on this device only. Connect GitHub on the <a href="capture.html">capture page</a> to sync privately across your devices and turn on automatic arrival dates.',
      nokey: 'Private sync is ready to turn on.',
      on: `🔒 Private sync on: orders and reviews are encrypted before they leave this device.${syncMsg ? ` <span class="late">${esc(syncMsg)}</span>` : ''}`,
      offline: '💾 Offline: changes are saved here and sync when you\'re back.',
      error: `⚠️ Couldn't sync (${esc(syncMsg)}). Changes are saved on this device.`,
      badkey: '⚠️ This device has a different key than the one your saved orders use. Paste the right key below.',
    };
    const k = key();
    return `<details class="card synccard" ${syncState === 'nokey' || syncState === 'badkey' ? 'open' : ''}>
      <summary><span>${lines[syncState] || lines.local}</span>${syncState === 'on' ? `<span class="note">${trackTxt}</span>` : ''}</summary>
      ${token() ? `<div class="keybox">
        ${k && syncState !== 'badkey' ? `<p class="note">Your private key: use it on your other devices (paste it here on each one) and as the <code>VAULT_KEY</code> secret for automatic tracking.</p>
          <div class="row"><input readonly class="keyval" value="${UI.showKey ? esc(k) : '••••••••••••••••••••••••••••'}" aria-label="Private key"><button class="chip" data-kact="show">${UI.showKey ? 'Hide' : 'Show'}</button><button class="chip" data-kact="copy">Copy key</button></div>`
          : `<p class="note">${syncState === 'badkey' ? 'Paste the key from the device where you turned sync on.' : 'Turn it on here once, then paste the same key on your other devices.'}</p>
          <div class="row">${syncState !== 'badkey' ? '<button class="go" data-kact="new">Turn on private sync</button><span class="note">or</span>' : ''}<input class="keyin" placeholder="Paste key from another device" aria-label="Paste key" autocomplete="off"><button class="chip" data-kact="paste">Use this key</button></div>`}
      </div>` : ''}
      <div class="setup note">
        <b>Automatic arrival dates (one-time setup, free):</b>
        <ol><li>Turn on private sync above and copy your key.</li>
        <li>On GitHub: <a href="https://github.com/${REPO}/settings/secrets/actions/new" target="_blank" rel="noopener">add a secret</a> named <code>VAULT_KEY</code> with that key.</li>
        <li>Make a free <a href="https://dashboard.ship24.com/register" target="_blank" rel="noopener">Ship24 account</a> and copy its API key, then add a secret named <code>SHIP24_API_KEY</code>.</li></ol>
        The tracking job then checks every few hours, fills in arrival dates here, and messages you on Telegram when a package is out for delivery or delivered. Ship24's free plan covers 10 new shipments a month.
      </div>
    </details>`;
  }
  function render() {
    const el = $('#ordersTab'); if (!el) return;
    const orders = live(V0.orders), reviews = live(V0.reviews);
    const coming = orders.filter((o) => o.status !== 'delivered').sort((a, b) => stepOf(b) - stepOf(a) || (a.trk?.eta || 'z').localeCompare(b.trk?.eta || 'z') || b.date.localeCompare(a.date));
    const done = orders.filter((o) => o.status === 'delivered').sort((a, b) => (b.deliveredAt || b.date).localeCompare(a.deliveredAt || a.date));
    const queue = toReview();
    let revs = reviews.filter((r) => !UI.reviewStore || r.vid === UI.reviewStore);
    revs.sort(UI.reviewSort === 'best' ? (a, b) => b.stars - a.stars || b.date.localeCompare(a.date) : UI.reviewSort === 'worst' ? (a, b) => a.stars - b.stars || b.date.localeCompare(a.date) : (a, b) => b.date.localeCompare(a.date));
    const storesReviewed = [...new Set(reviews.map((r) => r.vid))].filter(Boolean);
    const avg = (vid) => { const rs = reviews.filter((r) => r.vid === vid); return (rs.reduce((s, r) => s + r.stars, 0) / rs.length).toFixed(1); };
    const badge = $('#ordBadge'); if (badge) { const n = coming.length + queue.length; badge.hidden = !n; badge.textContent = n; }
    const raw = editor?.raw;
    el.innerHTML = `
      <div class="ohero">
        <div><h2>📦 Orders &amp; reviews</h2><p class="note">Snap your order confirmation, track it to your door, then review what you got.</p></div>
        <div class="row"><label class="go filebtn">📸 Add from screenshot<input type="file" id="shotIn" accept="image/*" hidden></label><button class="chip" data-oact="new">＋ Type it in</button></div>
      </div>
      ${flash ? `<div class="banner flash" role="status">${esc(flash)}</div>` : ''}
      ${ocrBusy ? `<div class="card ocr"><span class="spinner" aria-hidden="true"></span><span id="ocrMsg">${esc(ocrBusy)}</span></div>` : ''}
      ${editorHtml()}
      <h3 class="osec">🚚 On the way <span class="note">${coming.length || ''}</span></h3>
      ${coming.length ? `<div class="orders">${coming.map(orderCard).join('')}</div>` : '<p class="note empty-s">Nothing on the way. Add an order when you buy something.</p>'}
      <h3 class="osec">⭐ Ready to review <span class="note">${queue.length || ''}</span></h3>
      ${queue.length ? `<div class="rqueue">${queue.map(({ o, it }) => { const p = it.productId && D?.items.find((i) => i.id === it.productId); const open = UI.openReview === it.id;
        return `<div class="card rq-item">${p?.image ? `<img class="thumb" src="${esc(thumb(p.image))}" alt="" referrerpolicy="no-referrer">` : `<div class="thumb ph c-${p?.category || 'flower'}">${CAT_ICON[p?.category] || '🌿'}</div>`}
          <div class="rq-body"><b>${esc(it.name)}</b><div class="note">${esc(V[o.vid]?.name || '')}${o.num ? ` · #${esc(o.num)}` : ''} · received ${o.deliveredAt ? shortDate(o.deliveredAt.slice(0, 10)) : ''}</div>
          ${itemRatings(it, o.vid)}
          ${open ? reviewForm(o, it) : `<button class="go small" data-ract="open" data-iid="${it.id}">Review it</button>`}</div></div>`; }).join('')}</div>` : '<p class="note empty-s">When an order arrives, each thing in it shows up here to review.</p>'}
      <h3 class="osec">📝 My reviews <span class="note">${reviews.length || ''}</span></h3>
      ${reviews.length ? `<div class="row rfilters"><select id="rSort" aria-label="Sort reviews"><option value="new" ${UI.reviewSort === 'new' ? 'selected' : ''}>Newest</option><option value="best" ${UI.reviewSort === 'best' ? 'selected' : ''}>Highest rated</option><option value="worst" ${UI.reviewSort === 'worst' ? 'selected' : ''}>Lowest rated</option></select>
        <select id="rStore" aria-label="Store"><option value="">All stores</option>${storesReviewed.map((vid) => `<option value="${vid}" ${UI.reviewStore === vid ? 'selected' : ''}>${esc(V[vid]?.name || vid)} (${avg(vid)}★)</option>`).join('')}</select></div>
        <div class="reviews">${revs.map(reviewCard).join('')}</div>` : '<p class="note empty-s">No reviews yet.</p>'}
      ${done.length ? `<details class="osec-d" ${UI.showDelivered ? 'open' : ''}><summary><h3 class="osec">✅ Delivered <span class="note">${done.length}</span></h3></summary><div class="orders">${done.map(orderCard).join('')}</div></details>` : ''}
      ${syncCard()}`;
    if (raw) { const pre = el.querySelector('.rawtext'); if (pre) pre.textContent = raw; }
    if (flash && !render.flashT) render.flashT = setTimeout(() => { flash = ''; render.flashT = null; render(); }, 10000);
  }

  // ---------- events ----------
  function wireTab() {
    const el = $('#ordersTab');
    el.addEventListener('change', (e) => {
      if (e.target.id === 'shotIn' && e.target.files[0]) readScreenshot(e.target.files[0]);
      if (e.target.id === 'eStore') { readEditor(); render(); }
      if (e.target.id === 'rSort') { UI.reviewSort = e.target.value; render(); }
      if (e.target.id === 'rStore') { UI.reviewStore = e.target.value; render(); }
    });
    el.addEventListener('toggle', (e) => { if (e.target.classList?.contains('osec-d')) UI.showDelivered = e.target.open; }, true);
    el.addEventListener('click', async (e) => {
      const sb = e.target.closest('.stars button');
      if (sb) { const box = sb.parentElement; box.dataset.val = sb.dataset.v; box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.v <= +sb.dataset.v)); box.closest('.rform')?.querySelector('.rerr')?.remove(); return; }
      const rb = e.target.closest('[data-rb]');
      if (rb) { rb.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b === rb)); return; }
      const ea = e.target.closest('[data-eact]');
      if (ea) {
        const a = ea.dataset.eact;
        if (a === 'save') return saveEditor();
        if (a === 'cancel') { editor = null; return render(); }
        readEditor();
        if (a === 'add') editor.items.push({ name: '', qty: 1 });
        if (a === 'rm') editor.items.splice(+ea.closest('.eitem').dataset.k, 1);
        return render();
      }
      const ra = e.target.closest('[data-ract]');
      if (ra) {
        const a = ra.dataset.ract;
        if (a === 'open') { UI.openReview = ra.dataset.iid; return render(); }
        if (a === 'cancel') { UI.openReview = null; return render(); }
        if (a === 'save') return saveReview(ra.closest('.rform'));
        if (a === 'skip') { const f = ra.closest('.rform'); const o = V0.orders.find((x) => x.id === f.dataset.oid); const it = o?.items.find((x) => x.id === f.dataset.iid); if (it) { it.skip = true; o.updatedAt = now(); } UI.openReview = null; return save(); }
        if (a === 'edit') { UI.openReview = ra.dataset.rid; return render(); }
        if (a === 'del' && confirm('Delete this review?')) { const r = V0.reviews.find((x) => x.id === ra.dataset.rid); if (r) { r.deleted = true; r.updatedAt = now(); const o = V0.orders.find((x) => x.id === r.orderId); const it = o?.items.find((x) => x.id === r.itemId); if (it) { it.reviewId = null; o.updatedAt = now(); } } return save(); }
        return;
      }
      const ka = e.target.closest('[data-kact]');
      if (ka) {
        const a = ka.dataset.kact;
        if (a === 'show') { UI.showKey = !UI.showKey; return render(); }
        if (a === 'copy') { try { await navigator.clipboard.writeText(key()); ka.textContent = 'Copied'; } catch { UI.showKey = true; render(); } return; }
        if (a === 'new') { const k = toB64(crypto.getRandomValues(new Uint8Array(32))); try { localStorage.setItem(KKEY, k); } catch {} UI.showKey = true; await load(); queuePush(); return; }
        if (a === 'paste') { const k = el.querySelector('.keyin').value.trim(); if (!/^[A-Za-z0-9+/]{43}=$/.test(k)) { alert('That doesn\'t look like a Weed Scout key (44 characters ending in =).'); return; } try { localStorage.setItem(KKEY, k); } catch {} return load(); }
      }
      const oa = e.target.closest('[data-oact]');
      if (!oa) return;
      const a = oa.dataset.oact;
      if (a === 'new') return openEditor({});
      const card = oa.closest('[data-oid]'), o = card && V0.orders.find((x) => x.id === card.dataset.oid);
      if (!o) return;
      if (a === 'edit') return openEditor(o);
      if (a === 'track') { const t = card.querySelector('.otrack').value.trim(); if (t) { o.track = t; o.status = 'shipped'; delete o.trk; o.updatedAt = now(); save(); } return; }
      if (a === 'received') { o.status = 'delivered'; o.deliveredAt = o.deliveredAt || new Date().toISOString(); o.items.forEach((it) => (it.received = true)); o.updatedAt = now(); return save(); }
      if (a === 'stash') {
        for (const it of o.items) {
          const p = it.productId && D?.items.find((i) => i.id === it.productId);
          W.purchases.push({ id: p?.id || `order:${o.id}:${it.id}`, title: it.name, vendorId: o.vid, category: p?.category || (/rosin|hash|jam|badder/i.test(it.name) ? 'rosin' : /pre-?roll/i.test(it.name) ? 'preroll' : /vape|cart/i.test(it.name) ? 'vape' : 'flower'), label: '', grams: gramsIn(it.name) || null, price: o.total && o.items.length === 1 ? +o.total : null, date: (o.deliveredAt || o.date).slice(0, 10) });
        }
        W.purchases.sort((x, y) => y.date.localeCompare(x.date)); o.stashed = true; o.updatedAt = now(); changed(); renderStash(); return save();
      }
      if (a === 'del' && confirm('Remove this order?')) { o.deleted = true; o.updatedAt = now(); return save(); }
    });
  }

  let wired = false;
  window.vaultData = () => V0;
  window.__wsParseOrder = (t, w) => parseOrderText(t, w); // for testing the screenshot reader
  window.__wsDebug = { parseTable, prepImage };
  window.initOrdersTab = () => { if (!wired) { wireTab(); wired = true; } render(); load(); };
  window.renderOrdersTab = () => { if (wired) render(); };
  // check for tracking updates when you come back to the page
  document.addEventListener('visibilitychange', () => { if (!document.hidden && wired && token() && key()) load(); });
})();

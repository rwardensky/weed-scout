// Package tracking for the Orders & reviews tab (runs in GitHub Actions, see .github/workflows/track.yml).
// vault.json holds your orders encrypted with VAULT_KEY (AES-256-GCM, same format the site writes). For each order
// on the way that has a tracking number, ask Ship24 for its status and estimated delivery, write that back into the
// vault, and queue Telegram messages for the big moments (arrival date set or moved, out for delivery, delivered,
// problems). Messages are sent with --send only after the updated vault has been pushed, so a retry never double-sends.
//   node track.mjs --out msgs.json      check packages, update vault.json, write pending messages
//   node track.mjs --send msgs.json     send them
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DIR = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const FILE = path.join(DIR, 'vault.json');
const SITE = 'https://rwardensky.github.io/weed-scout/#orders';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const { VAULT_KEY, SHIP24_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

// ---------- send step ----------
if (arg('--send')) {
  const msgs = fs.existsSync(arg('--send')) ? JSON.parse(fs.readFileSync(arg('--send'), 'utf8')) : [];
  if (!msgs.length) { console.log('track: nothing to send'); process.exit(0); }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(`track: ${msgs.length} updates, no Telegram configured`); process.exit(0); }
  const html = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const m of msgs) {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, parse_mode: 'HTML', disable_web_page_preview: true, text: `${m.emoji} <b>${html(m.title)}</b>\n${html(m.body)}`, reply_markup: { inline_keyboard: [[{ text: m.button || 'Open orders', url: m.url || SITE }]] } }) });
    console.log('track: sent', m.title, r.status);
  }
  process.exit(0);
}

// ---------- check step ----------
const out = arg('--out');
fs.writeFileSync(out || path.join(DIR, 'track-msgs.json'), '[]');
if (!VAULT_KEY) { console.log('track: no VAULT_KEY secret yet, nothing to do'); process.exit(0); }
if (!fs.existsSync(FILE)) { console.log('track: no vault.json yet'); process.exit(0); }
const key = Buffer.from(VAULT_KEY.trim(), 'base64');
if (key.length !== 32) { console.log('track: VAULT_KEY is not a 32-byte base64 key'); process.exit(1); }

function unseal(f) {
  const iv = Buffer.from(f.iv, 'base64'), buf = Buffer.from(f.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}
function seal(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, alg: 'AES-256-GCM', note: "Weed Scout orders and reviews, encrypted. Not readable without the owner's key.", iv: iv.toString('base64'), data: ct.toString('base64') };
}

let vault;
try { vault = unseal(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
catch (e) { console.log('track: could not decrypt vault.json; is VAULT_KEY the same key the site shows?', e.message); process.exit(1); }

const before = JSON.stringify(vault);
const msgs = [];
const hasKey = !!SHIP24_API_KEY;
const day = (iso) => { const d = new Date(iso.length <= 10 ? iso + 'T12:00:00' : iso); return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); };
const label = (o, name) => `${name || o.vid}${o.num ? ` #${o.num}` : ''}`;
const storeName = (vid) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8')).vendors.find((v) => v.id === vid)?.name || vid; } catch { return vid; } };

async function ship24(o) {
  const H = { Authorization: `Bearer ${SHIP24_API_KEY}`, 'Content-Type': 'application/json' };
  let r;
  if (o.trk?.trackerId) r = await fetch(`https://api.ship24.com/public/v1/trackers/${o.trk.trackerId}/results`, { headers: H });
  // same payload every time: the endpoint is idempotent for an identical body, so a retry reuses the tracker
  else r = await fetch('https://api.ship24.com/public/v1/trackers/track', { method: 'POST', headers: H, body: JSON.stringify({ trackingNumber: o.track.replace(/[\s-]/g, ''), destinationCountryCode: 'US' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Ship24 ${r.status} ${j?.errors?.[0]?.message || j?.message || ''}`.trim());
  return j?.data?.trackings?.[0] || null;
}

let checked = 0, error = null;
const cutoff = Date.now() - 45 * 864e5; // stop polling packages ordered over 45 days ago
for (const o of vault.orders || []) {
  if (o.deleted || !o.track || o.status === 'delivered' || new Date(o.date + 'T12:00:00') < cutoff) continue;
  if (!hasKey) continue;
  let t;
  try { t = await ship24(o); checked++; } catch (e) { error = e.message; console.log('track:', label(o), e.message); continue; }
  if (!t) continue;
  const s = t.shipment || {}, ev = (t.events || [])[0] || null, del = s.delivery || {};
  const prev = o.trk || {};
  const trk = {
    trackerId: t.tracker?.trackerId || prev.trackerId || null,
    milestone: s.statusMilestone || prev.milestone || 'pending',
    eta: del.estimatedDeliveryDate || del.courierEstimatedDeliveryDate?.from || del.aiPredictiveDeliveryDate?.from || null,
    etaTo: del.courierEstimatedDeliveryDate?.to || del.aiPredictiveDeliveryDate?.to || null,
    last: ev ? { status: ev.status, location: ev.location || '', at: ev.occurrenceDatetime || null } : prev.last || null,
    courier: ev?.courierCode || prev.courier || null,
    checkedAt: Date.now(),
  };
  o.trk = trk;
  const name = label(o, storeName(o.vid));
  if (trk.milestone === 'delivered') {
    o.status = 'delivered';
    o.deliveredAt = t.statistics?.timestamps?.deliveredDatetime || ev?.occurrenceDatetime || new Date().toISOString();
    for (const it of o.items || []) it.received = true;
    msgs.push({ emoji: '✅', title: `Delivered: ${name}`, body: `${(o.items || []).map((x) => x.name).join(', ') || 'Your order'} arrived. Tap to review it.`, button: 'Review it' });
  } else if (trk.milestone !== prev.milestone && ['out_for_delivery', 'failed_attempt', 'available_for_pickup', 'exception'].includes(trk.milestone)) {
    const T = { out_for_delivery: ['🚚', 'Out for delivery today'], failed_attempt: ['⚠️', 'Delivery attempted'], available_for_pickup: ['📮', 'Ready for pickup'], exception: ['⚠️', 'Problem with delivery'] }[trk.milestone];
    msgs.push({ emoji: T[0], title: `${T[1]}: ${name}`, body: ev ? `${ev.status}${ev.location ? `, ${ev.location}` : ''}` : '' });
  } else if (trk.eta && trk.eta.slice(0, 10) !== (prev.eta || '').slice(0, 10)) {
    msgs.push({ emoji: '📦', title: `${name} arrives ${day(trk.eta)}`, body: prev.eta ? `Moved from ${day(prev.eta)}.` : `${ev ? `${ev.status}${ev.location ? `, ${ev.location}` : ''}` : 'In transit'}.` });
  }
  if (JSON.stringify(prev) !== JSON.stringify({ ...trk, checkedAt: prev.checkedAt })) o.updatedAt = Date.now();
}

// ---------- what Reddit says about what you bought ----------
// Products you ordered may be sold out (so not in data.json), so look each one up in the Reddit archive the
// daily refresh keeps (cache/reddit-corpus.json, restored read-only). Results go in vault-buzz.json, encrypted
// with the same key, so the public repo never shows what you bought.
const BUZZ_FILE = path.join(DIR, 'vault-buzz.json');
const corpusF = path.join(DIR, 'cache', 'reddit-corpus.json');
if (fs.existsSync(corpusF)) {
  const docs = Object.values(JSON.parse(fs.readFileSync(corpusF, 'utf8')).docs || {});
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'vendors.json'), 'utf8')); } catch {}
  const vend = Object.fromEntries((cfg.vendors || []).map((v) => [v.id, v]));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const POS = /\b(fire|gas|gassy|amazing|great|best|love|loved|legit|terpy|flavorful|recommend|solid|smooth|impressed|favorite|insane|loud|potent|top ?tier|goat|banger|killer|bomb|dank|delicious|tasty)\b/gi;
  const NEG = /\b(mid|trash|avoid|worst|bad|harsh|mold|moldy|disappointed|disappointing|overpriced|garbage|weak|burnt|stale|hay|terrible|awful|meh|underwhelming)\b/gi;
  const score = (t) => { const p = (t.match(POS) || []).length, n = (t.match(NEG) || []).length; return (p - n) / (p + n + 2); };
  const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;/g, "'").replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  // "HRC T1 Frozen Peaches - 2g" → try "hrc t1 frozen peaches", "t1 frozen peaches", "frozen peaches"…: the longest phrase Reddit uses
  const phrases = (name) => {
    const w = name.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\b\d+(\.\d+)?\s*(g|gram|grams|oz|mg|ml)\b/g, ' ').replace(/[^a-z0-9#' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const out = [];
    for (let k = 0; k < w.length; k++) { const p = w.slice(k).join(' '); if (w.length - k >= 2 || p.length >= 7) out.push(p); }
    return out;
  };
  const buzz = {};
  const names = new Map();
  for (const o of vault.orders || []) if (!o.deleted) for (const it of o.items || []) if (it.name) names.set(it.name, o.vid);
  for (const r of vault.reviews || []) if (!r.deleted && r.name) names.set(r.name, r.vid);
  for (const [name, vid] of names) {
    const v = vend[vid] || {};
    const storeRe = new RegExp(`\\b(${[v.name, ...(v.reddit || [])].filter(Boolean).map(esc).join('|')})\\b`, 'i');
    for (const ph of phrases(name)) {
      const re = new RegExp(`\\b${esc(ph).replace(/ /g, '[\\s-]+')}\\b`, 'i');
      const hits = docs.filter((d) => re.test(d.text));
      if (!hits.length) continue;
      const quotes = [];
      for (const d of hits) {
        for (const s of d.text.split(/(?<=[.!?])\s+|\n+/)) {
          if (!re.test(s)) continue;
          let q = strip(s); if (q.length < 25) continue; if (q.length > 260) q = q.slice(0, 257).replace(/\s+\S*$/, '') + '…';
          quotes.push({ text: q, sent: +score(q).toFixed(2), store: storeRe.source !== '\\b()\\b' && storeRe.test(d.text), score: d.score || 0, link: d.link, sub: d.sub, t: new Date(d.t * 1000).toISOString().slice(0, 10) });
        }
      }
      const seen = new Set();
      const says = quotes.sort((a, b) => b.store - a.store || (Math.abs(b.sent) >= 0.2) - (Math.abs(a.sent) >= 0.2) || b.score - a.score || b.t.localeCompare(a.t))
        .filter((q) => !seen.has(q.link) && seen.add(q.link)).slice(0, 3);
      const sent = quotes.length ? quotes.reduce((s, q) => s + q.sent, 0) / quotes.length : 0;
      buzz[name] = { phrase: ph, pos: quotes.filter((q) => q.sent > 0.1).length, neg: quotes.filter((q) => q.sent < -0.1).length, n: hits.length, nStore: hits.filter((d) => storeRe.source !== '\\b()\\b' && storeRe.test(d.text)).length, sent: +sent.toFixed(2), says };
      break;
    }
  }
  let prev = null; try { prev = unseal(JSON.parse(fs.readFileSync(BUZZ_FILE, 'utf8'))); } catch {}
  if (JSON.stringify(prev?.buzz || null) !== JSON.stringify(buzz)) {
    fs.writeFileSync(BUZZ_FILE, JSON.stringify(seal({ t: Date.now(), buzz }), null, 1));
    console.log(`track: Reddit notes for ${Object.keys(buzz).length} of ${names.size} things you bought`);
  }
} else console.log('track: no Reddit archive in the cache yet (the daily refresh makes it)');

// the site shows "arrival dates on/off · checked X ago"; only rewrite while something is actually being tracked
const tracking = { lastRun: Date.now(), hasKey, checked, ...(error ? { error } : {}) };
const metaChanged = !vault.tracking || vault.tracking.hasKey !== hasKey || (vault.tracking.error || null) !== (error || null);
if (checked || metaChanged || JSON.stringify(vault) !== before) {
  vault.tracking = tracking;
  fs.writeFileSync(FILE, JSON.stringify(seal(vault), null, 1));
  console.log(`track: checked ${checked} package(s), ${msgs.length} update(s)`);
} else console.log('track: nothing on the way to check');
fs.writeFileSync(out || path.join(DIR, 'track-msgs.json'), JSON.stringify(msgs));

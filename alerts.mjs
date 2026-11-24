// Sends phone alerts after each refresh: Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set,
// otherwise ntfy (https://ntfy.sh) when NTFY_TOPIC is set.
// Usage: node alerts.mjs [--dry-run] [--test]   (--test sends one "alerts are on" message and exits)
// Alerts:
//   - starred products: price drop, back in stock, new 30-day low
//   - starred strains: a new listing, drop or restock at any vendor
//   - big deals: S/A products 30%+ under the median that just appeared or just dropped
// alerts-state.json remembers what was already sent so nothing repeats.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TOPIC = TG_TOKEN && TG_CHAT ? 'telegram' : process.env.NTFY_TOPIC;
const SITE = 'https://rwardensky.github.io/weed-scout/';
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return d; } };

const data = read('data.json', null);
if (!data) { console.log('alerts: no data.json'); process.exit(0); }
const watch = read('watchlist.json', { items: [], strains: [] });
const state = read('alerts-state.json', { sent: {} });
const today = new Date().toISOString().slice(0, 10);
const vname = Object.fromEntries(data.vendors.map((v) => [v.id, v.name]));
const money = (n) => '$' + (n >= 100 ? Math.round(n) : n.toFixed(2));
const ppg = (i) => (i.effPpg ? `${money(i.effPpg)}/g shipped` : money(i.minPrice));
const recent = (d, days = 1) => d && (Date.now() - new Date(d + 'T12:00:00Z')) / 864e5 <= days;

const events = [];
const add = (key, ev) => { if (!state.sent[key]) events.push({ key, ...ev }); };
const items = new Set(watch.items || []);
const strains = new Set(watch.strains || []);

for (const i of data.items) {
  if (i.stale) continue;
  const where = `${vname[i.vendorId] || i.vendorId}`;
  const starred = items.has(i.id);
  const strainHit = i.group && strains.has(i.group);
  if (starred || strainHit) {
    const why = starred ? 'Starred' : 'Watched strain';
    if (i.drop && recent(i.drop.at, 2)) add(`drop:${i.id}:${i.effPpg}`, { prio: 4, tag: 'chart_with_downwards_trend', title: `${why} dropped ${i.drop.pct}%`, body: `${i.title} at ${where}: ${ppg(i)} (was ${money(i.drop.from)}/g)`, url: i.url });
    if (i.restocked && recent(i.restocked, 2)) add(`restock:${i.id}:${i.restocked}`, { prio: 4, tag: 'package', title: `${why} back in stock`, body: `${i.title} at ${where}: ${ppg(i)}`, url: i.url });
    if (starred && i.low30 && i.available) add(`low:${i.id}:${i.effPpg}`, { prio: 3, tag: 'moneybag', title: 'Lowest price in 30 days', body: `${i.title} at ${where}: ${ppg(i)}`, url: i.url });
    if (strainHit && !starred && i.isNew && i.available) add(`new:${i.id}`, { prio: 3, tag: 'seedling', title: 'Watched strain just listed', body: `${i.title} at ${where}: ${ppg(i)}`, url: i.url });
  }
  // big deals worth knowing about even if not starred
  const topTier = ['S', 'A+', 'A'].includes(i.tier);
  if (topTier && i.available && i.dealRatio >= 1.43 && i.quality >= 60 && ((i.isNew && recent(i.isNew, 1)) || (i.drop && recent(i.drop.at, 1))))
    add(`deal:${i.id}:${i.effPpg}`, { prio: 3, tag: 'fire', title: `${Math.round((1 - 1 / i.dealRatio) * 100)}% under median`, body: `${i.title} at ${where} (${i.tier}): ${ppg(i)}, quality ${i.quality}`, url: i.url, deal: true });
}

// keep it calm: personal alerts first, at most 4 big deals, and bundle when there are lots
const personal = events.filter((e) => !e.deal);
const deals = events.filter((e) => e.deal).slice(0, 4);
let toSend = [...personal, ...deals];
if (toSend.length > 6) {
  toSend = [{ key: `digest:${today}`, prio: 3, tag: 'bell', title: `${toSend.length} Weed Scout alerts`, body: toSend.slice(0, 8).map((e) => `• ${e.title}: ${e.body}`).join('\n'), url: SITE, members: toSend }];
}

const html = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const EMOJI = { chart_with_downwards_trend: '📉', package: '📦', moneybag: '💰', seedling: '🌱', fire: '🔥', bell: '🔔', white_check_mark: '✅' };
async function send(e) {
  if (DRY || !TOPIC) { console.log(`[${DRY ? 'dry-run' : 'no alert channel set'}] ${e.title} | ${e.body}`); return true; }
  if (TOPIC === 'telegram') {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT, parse_mode: 'HTML', disable_web_page_preview: true,
        text: `${EMOJI[e.tag] || ''} <b>${html(e.title)}</b>\n${html(e.body)}`,
        reply_markup: { inline_keyboard: [[{ text: e.url && e.url !== SITE ? 'Open product' : 'Open Weed Scout', url: e.url || SITE }]] },
      }),
    });
    if (!r.ok) console.log('alerts: telegram', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  }
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(TOPIC)}`, {
    method: 'POST', body: e.body,
    headers: { Title: e.title.replace(/[^\x20-\x7E]/g, ''), Tags: e.tag, Priority: String(e.prio), Click: e.url || SITE },
  });
  if (!r.ok) console.log('alerts: ntfy', r.status, await r.text());
  return r.ok;
}

if (process.argv.includes('--test')) {
  const ok = await send({ title: 'Weed Scout alerts are on', body: `You'll get price drops, restocks and new listings for your starred products and strains, plus big S/A deals. ${data.items.filter((i) => i.available).length} products tracked right now.`, tag: 'white_check_mark', prio: 3, url: SITE });
  console.log(`alerts: test message ${ok ? 'sent' : 'failed'} via ${TOPIC || 'nothing (no channel set)'}`);
  process.exit(ok && TOPIC ? 0 : 1);
}

let sent = 0;
for (const e of toSend) {
  if (await send(e)) { for (const m of e.members || [e]) state.sent[m.key] = today; sent++; }
}
// forget sent keys after 45 days
for (const [k, d] of Object.entries(state.sent)) if (!recent(d, 45)) delete state.sent[k];
if (!DRY && TOPIC) fs.writeFileSync(path.join(DIR, 'alerts-state.json'), JSON.stringify(state));
console.log(`alerts: ${events.length} new events, ${sent} notifications ${TOPIC && !DRY ? 'sent' : 'not sent'}`);

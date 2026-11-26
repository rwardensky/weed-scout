// Weed Scout — Suggestions tab: picks built from what you liked, the best deals right now, restock reminders,
// fresh drops and something new to try. The order builder (Plan an order) lives on this tab too.
// Uses globals from index.html: $, esc, money, cents, shortDate, D, V, W, VA, myQ, myV, dr, pp, total, dealWord,
// shipsToMe, thumb, CAT_ICON, CATS — and window.vaultData() from orders.js for your reviews.
(() => {
  const S2 = { cat: '' };
  const good = (i) => i.available && !i.stale && pp(i) && W.ratings[i.id]?.r !== -1 && (i.local || shipsToMe(i.vendorId));
  const mainTier = (i) => i.local || i.pinned || /^(S|A)/.test(i.tier) || (i.tier === 'B' && (i.bDeal || i.bDealCode));
  const byV = (a, b) => (myV(b) ?? 0) - (myV(a) ?? 0);
  const catOk = (i) => !S2.cat || i.category === S2.cat;
  const days = (d) => (Date.now() - new Date(d + 'T12:00:00')) / 864e5;

  // what you've liked: thumbs up, 4–5★ reviews, starred products and strains
  function likes() {
    const reviews = (window.vaultData?.().reviews || []).filter((r) => !r.deleted);
    const L = { groups: new Map(), makers: new Map(), stores: new Map(), cats: new Map(), seen: new Set() };
    const bump = (m, k, w, why) => { if (!k) return; const c = m.get(k) || { w: 0, why }; c.w += w; c.why ||= why; m.set(k, c); };
    const from = (i, w, why) => {
      if (!i) return;
      L.seen.add(i.id);
      bump(L.groups, i.group, w, why); bump(L.makers, i.hashmaker || i.thirdParty, w, why); bump(L.stores, i.vendorId, w * 0.5, why); bump(L.cats, i.category, w * 0.3, why);
    };
    const find = (id) => D.items.find((x) => x.id === id);
    for (const [id, r] of Object.entries(W.ratings)) if (r.r > 0) from(find(id), 2, `you liked ${find(id)?.title || ''}`);
    for (const r of reviews) { const i = r.productId && find(r.productId); if (i) from(i, r.stars >= 5 ? 3 : r.stars >= 4 ? 2 : r.stars <= 2 ? -2 : 0, `you gave ${i.title} ${r.stars}★`); }
    for (const id of W.items) from(find(id), 1, `you starred ${find(id)?.title || ''}`);
    for (const g of W.strains) bump(L.groups, g, 1.5, 'a strain you watch');
    for (const m of W.makers || []) bump(L.makers, m, 1.5, `you follow ${m}`);
    return L;
  }
  function picksForYou(L) {
    const out = [];
    for (const i of D.items) {
      if (!good(i) || !catOk(i) || L.seen.has(i.id)) continue;
      const g = L.groups.get(i.group), m = L.makers.get(i.hashmaker || i.thirdParty), st = L.stores.get(i.vendorId), c = L.cats.get(i.category);
      const boost = (g?.w || 0) * 12 + (m?.w || 0) * 8 + (st?.w || 0) * 4 + (c?.w || 0) * 2;
      if (boost <= 0 || !mainTier(i)) continue;
      const why = g ? `Same strain: ${g.why}` : m ? `${i.hashmaker || i.thirdParty}: ${m.why}` : st ? `From ${V[i.vendorId]?.name}: ${st.why}` : `More ${CATS[i.category]?.toLowerCase()}: ${c.why}`;
      out.push({ i, score: (myV(i) ?? 0) + boost, why });
    }
    out.sort((a, b) => b.score - a.score);
    // keep it varied: at most two per store
    const per = {}; return out.filter((x) => (per[x.i.vendorId] = (per[x.i.vendorId] || 0) + 1) <= 2).slice(0, 8);
  }
  function bestNow() {
    const cats = S2.cat ? [S2.cat] : ['rosin', 'flower', 'preroll', 'vape', 'concentrate'];
    return cats.flatMap((c) => D.items.filter((i) => i.category === c && !i.local && good(i) && mainTier(i)).sort(byV).slice(0, S2.cat ? 6 : 2).map((i) => ({ i, why: `Top ${CATS[c].toLowerCase()} right now` })));
  }
  function restock() {
    const by = {};
    for (const p of W.purchases || []) if (p.category && p.date) (by[p.category] ||= []).push(p);
    const out = [];
    for (const [cat, ps] of Object.entries(by)) {
      if (S2.cat && cat !== S2.cat) continue;
      ps.sort((a, b) => a.date.localeCompare(b.date));
      const last = ps.at(-1);
      let every = null;
      if (ps.length >= 2) { const gaps = ps.slice(1).map((p, k) => (new Date(p.date) - new Date(ps[k].date)) / 864e5).filter((g) => g > 0); if (gaps.length) every = gaps.reduce((s, g) => s + g, 0) / gaps.length; }
      const since = days(last.date);
      if (every ? since < every * 0.85 : since < 21) continue;
      const pick = D.items.filter((i) => i.category === cat && !i.local && good(i) && mainTier(i)).sort(byV).slice(0, 2);
      for (const i of pick) out.push({ i, why: every ? `You rebuy ${CATS[cat].toLowerCase()} about every ${Math.round(every)} days; last was ${Math.round(since)} days ago` : `Your last ${CATS[cat].toLowerCase()} was ${Math.round(since)} days ago` });
    }
    return out.slice(0, 6);
  }
  function fresh() {
    return D.items.filter((i) => good(i) && catOk(i) && !i.local && mainTier(i) && ((i.isNew && days(i.isNew) <= 4) || (i.restocked && days(i.restocked) <= 3) || (i.drop && days(i.drop.at) <= 3)))
      .sort(byV).slice(0, 6).map((i) => ({ i, why: i.drop ? `Dropped ${i.drop.pct}% on ${shortDate(i.drop.at)}` : i.restocked ? `Back in stock ${shortDate(i.restocked)}` : `New ${shortDate(i.isNew)}` }));
  }
  function tryNew(L) {
    const tried = new Set([...(W.purchases || []).map((p) => p.vendorId), ...(window.vaultData?.().orders || []).filter((o) => !o.deleted).map((o) => o.vid)]);
    return D.items.filter((i) => good(i) && catOk(i) && !i.local && /^(S|A)/.test(i.tier) && !tried.has(i.vendorId) && myQ(i) >= 70 && (dr(i) || 0) >= 1.15)
      .sort(byV).filter((i, k, a) => a.findIndex((x) => x.vendorId === i.vendorId) === k).slice(0, 6)
      .map((i) => ({ i, why: `${V[i.vendorId]?.name} (${i.tier} tier): you haven't ordered from them yet` }));
  }
  function card({ i, why }) {
    const d = dealWord(dr(i)), v = V[i.vendorId] || {};
    return `<a class="scard c-${i.category}" href="${esc(i.url)}" target="_blank" rel="noopener">
      ${i.image ? `<img class="thumb" loading="lazy" src="${esc(thumb(i.image))}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb ph c-${i.category}',textContent:'${CAT_ICON[i.category] || '🌿'}'}))">` : `<div class="thumb ph c-${i.category}">${CAT_ICON[i.category] || '🌿'}</div>`}
      <div class="sbody"><b>${esc(i.title)}</b><span class="note">${esc(v.name || i.vendorId)}${i.effGrams ? ` · ${i.effGrams}g` : ''}</span>
        <span class="sprice"><b>${cents(total(i))}</b> <span class="note">${money(pp(i))}/g</span>${d && d.cls !== 'even' && d.cls !== 'bad' ? ` <span class="deal ${d.cls} mini">${d.word}</span>` : ''}</span>
        <span class="swhy">${esc(why)}</span></div></a>`;
  }
  function section(title, sub, rows, empty) {
    return `<div class="ssec"><h3 class="osec">${title}</h3>${sub ? `<p class="note">${sub}</p>` : ''}${rows.length ? `<div class="sgrid">${rows.map(card).join('')}</div>` : `<p class="note empty-s">${empty}</p>`}</div>`;
  }
  function render() {
    const el = $('#suggestTab'); if (!el || !D) return;
    const L = likes();
    const mine = picksForYou(L);
    el.innerHTML = `
      <div class="ohero"><div><h2>✨ Suggestions</h2><p class="note">Picks from what you've liked and reviewed, today's best deals, and what's due for a restock. Tap a card to open it at the store.</p></div>
        <div class="row" id="sCats"><button class="chip" data-sc="" aria-pressed="${!S2.cat}">Everything</button>${['rosin', 'flower', 'preroll', 'vape', 'concentrate'].map((c) => `<button class="chip c-${c}" data-sc="${c}" aria-pressed="${S2.cat === c}">${CATS[c]}</button>`).join('')}</div></div>
      ${section('💚 Picks for you', mine.length ? 'Based on your thumbs, reviews, stars and follows.' : '', mine, 'Rate a few products (👍 on the Deals tab, or ★ reviews on Orders & reviews) and picks made for you show up here.')}
      ${section('🔁 Time to restock', '', restock(), 'Log what you buy ("Add to my stash" on a delivered order) and this tells you when you usually run low.')}
      ${section('🔥 Best deals right now', 'Best overall value in each type from your S/A list, shipping and codes included.', bestNow(), 'Nothing in stock matches.')}
      ${section('🆕 Just dropped', 'New listings, restocks and price drops from the last few days.', fresh(), 'No new drops in the last few days.')}
      ${section('🧭 Try something new', 'Highly rated stores you haven\'t ordered from yet, at a good price.', tryNew(L), 'You\'ve tried every top store. Nice.')}`;
  }
  let wired = false;
  window.renderSuggestTab = () => {
    if (!wired && $('#suggestTab')) { wired = true; $('#suggestTab').addEventListener('click', (e) => { const b = e.target.closest('[data-sc]'); if (b) { S2.cat = b.dataset.sc; render(); } }); }
    render();
  };
})();

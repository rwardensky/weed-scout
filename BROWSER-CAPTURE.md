# Capturing bot-protected vendors (White Ash Reserve, Crysp)

These two stores sit behind a Cloudflare check that blocks the cloud scraper. To refresh them:

1. Open the store in Chrome and pass the security check.
2. Ask Claude to "recapture WAR" (or Crysp). Claude runs the snippet below in that tab and reads the lines out.
3. Claude saves the lines to `captures/<id>-capture.txt`, runs `node import-capture.mjs <id> captures/<id>-capture.txt`, and pushes. The next daily run picks it up.

Captures older than 3 days show as "Cached" on the page.

## Snippet (run in the store's tab)

Builds `window.__cap` as one line per in-stock product:
`handle ~ title ~ categories ~ image ~ label|price|compareAt|inStock;... ~ urlPath ~ rating|reviews`

```js
const base='/wp-json/wc/store/v1/products';
const all=async(q)=>{let out=[];for(let p=1;p<=30;p++){const r=await fetch(`${base}?per_page=99&page=${p}${q}`);if(!r.ok)break;const j=await r.json();if(!j.length)break;out.push(...j);if(j.length<99)break;}return out};
const parents=(await all('')).filter(p=>p.type!=='variation'); const vars=await all('&type=variation');
const money=(pr,k)=>+(pr?.[k]||0)/10**(pr?.currency_minor_unit??2); const byP={}; for(const x of vars)(byP[x.parent]||=[]).push(x);
const dec=s=>(s||'').replace(/&#8217;/g,"'").replace(/&amp;/g,'&').replace(/&#8211;/g,'-').replace(/~/g,'-');
const host=location.origin+'/';
window.__cap=parents.map(p=>{const kids=byP[p.id]||[];
 const vs=(kids.length?kids.map(k=>[dec(k.variation).replace(/^[^:]*:\s*/,''),money(k.prices,'price'),money(k.prices,'regular_price'),k.is_in_stock!==false]):[['',money(p.prices,'price'),money(p.prices,'regular_price'),p.is_in_stock]])
   .filter(v=>v[3]&&v[1]>0).map(([a,b,c])=>[/\d|eighth|quarter|half|ounce|oz|gram/i.test(a)?a.slice(0,30):'',b,c===b?'':c,1].join('|'));
 if(!vs.length)return null;
 return [p.slug,dec(p.name),(p.categories||[]).map(c=>dec(c.name)).join('/'),(p.images?.[0]?.thumbnail||p.images?.[0]?.src||'').split('?')[0],vs.join(';'),p.permalink.split('?')[0].replace(host,'').replace(p.slug+'/',''),(+p.average_rating?+p.average_rating+'|'+p.review_count:'')].join(' ~ ')}).filter(Boolean);
window.__cap.length
```

Then read it out in chunks small enough for the tool, e.g. `window.__cap.slice(0,40)`, `window.__cap.slice(40,80)`, and so on.

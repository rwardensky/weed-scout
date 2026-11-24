// Turns a catalog captured in the browser into captures/browser-<id>.json for the scraper (saved in captures/, which is committed).
// Usage: node import-capture.mjs <vendorId> <captureFile.txt>
// Each line of the capture: handle ~ title ~ categories ~ imageURL ~ label|price|compareAt|inStock;label|price|...
// (Produced by the in-page snippet in BROWSER-CAPTURE.md.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const [id, file] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'vendors.json'), 'utf8'));
const v = cfg.vendors.find((x) => x.id === id);
if (!v || !file) { console.error('usage: node import-capture.mjs <vendorId> <file>'); process.exit(1); }
const BRANDS = { HRC: 'Hash Rosin Co', HCS: 'HCS' };
const products = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => {
  // optional 6th field: URL path prefix (e.g. "cold-cure/"); optional 7th: "rating|reviewCount"
  const [handle, title, cats, img, vars, urlPath, rate] = l.split(' ~ ').map((s) => (s || '').trim());
  const first = title.split(/[\s–-]+/)[0];
  const [rating, reviewCount] = (rate || '').split('|').map(Number);
  return {
    handle, title, type: '', tags: [], cats: cats.split('/'),
    brand: BRANDS[first] || null,
    url: `${v.url}/${urlPath || 'product/'}${handle}/`,
    rating: rating || null, reviewCount: reviewCount || null,
    // "images/..." = a copy saved in this repo (for stores whose images block other sites)
    image: img ? (/^(https?:|images\/)/.test(img) ? img : `${v.url}/wp-content/uploads/${img}`) : null,
    variants: (vars || '').split(';').map((x) => {
      const [label, price, compareAt, avail] = x.split('|');
      return { label: (label || '').replace(/^strains?:\s*/i, ''), price: +price, compareAt: +compareAt || null, available: avail === '1' };
    }),
  };
});
fs.mkdirSync(path.join(DIR, 'captures'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'captures', `browser-${id}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), products }));
console.log(`saved ${products.length} products for ${v.name}`);

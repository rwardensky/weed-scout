# Weed Scout

Pulls every product from the S/A (and B) tier THCa vendors, scores deals and quality, and feeds the dashboard (`index.html` + `data.json`).

## Files
- `vendors.json`: vendor list with tier, site platform, Reddit search terms, and known hashmakers. Edit tiers or add vendors here.
- `scrape.mjs`: the scraper (Node 18+, no installs needed).
- `data.json`: output the dashboard reads.
- `cache/`: raw catalogs, cached product ratings (7 days), Reddit corpus. Not committed; GitHub keeps it between runs.
- `captures/`: White Ash Reserve and Crysp catalogs captured in a browser (see BROWSER-CAPTURE.md).

## Run it
```
node scrape.mjs                 # full refresh, about 30-60 min because sites rate-limit
node scrape.mjs --only jgrows,kache
node scrape.mjs --reddit-only   # re-score existing products with fresh Reddit data
node scrape.mjs --no-reviews    # skip product-page review fetching (faster)
node scrape.mjs --from-cache    # re-score from cached catalogs, no store requests
```
Normally you do not run anything: GitHub Actions runs `node scrape.mjs` every day at 6am Eastern (`.github/workflows/refresh.yml`), commits the new `data.json`, and GitHub Pages serves `index.html`. To refresh right away, open the repo's **Actions** tab, pick **Refresh Weed Scout**, and click **Run workflow**.

## How sites are read
- Shopify (`/products.json`) and WooCommerce (Store API): full catalog, every size and price, stock.
- `jsonld`: Wix / Square / Webflow / BigCommerce sites, read from the sitemap's product pages.
- `square`: Roots & Releaf, via Square Online's public store API.
- `browser`: White Ash Reserve and Crysp sit behind a Cloudflare bot check. Claude opens them in your Chrome, you pass the check, Claude reads the WooCommerce feed in that tab and saves it with `node import-capture.mjs <war|crysp> <file>`. Captures older than 3 days show as "Cached".
- `fetcher: "curl"`: Legendary's firewall blocks Node's fetch but allows curl, so those requests go through curl.
- Not covered: Shop Hello Mary (blocks all scripted access), WNC CBD and Arete (no product sitemap).
- Reviews: WooCommerce ratings come with the catalog. For Shopify, product pages are checked for Judge.me / Stamped / Loox / JSON-LD ratings.
- Reddit: posts (12 months) and comments (90 days) from r/THCaFlower, r/hashrosin and r/hempflowers via the Arctic Shift archive, matched to vendor names and strain names.

## Scores
- Deal ratio = median $/g of in-stock S/A items (same type and size band) ÷ item's best $/g.
- Quality 0-100 = tier + hashmaker + site rating + Reddit sentiment.
- B tier only appears when deal ratio ≥ 1.33 (25%+ under the S/A median).

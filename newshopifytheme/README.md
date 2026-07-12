# Divinity — Newsstand (Shopify theme)

A compact, modern Online Store 2.0 theme built for **divinitycomics.com** — an
independent variant-cover comics publisher. It's designed to fix two problems
with the old storefront:

1. **Navigation sprawl.** 60+ tag-based collections (`{Series} #{N} × {Books |
   Prints | Digital | Merch}`) made the store impossible to browse. The
   homepage now leads with a **Shop by Series** grid — one tile per title — so
   customers pick a series first, then narrow by format.
2. **Oversized, "gigantic" sections.** Comic covers are portrait art meant to be
   scanned by the dozen. Product cards are now small, dense portrait tiles in a
   tight grid instead of giant stacked blocks.

## Design system
- **Ground:** warm near-black ink (`#14110f`) with a faint halftone grain.
- **Accent:** one hot comic red (`#ff2e43`).
- **Tier:** gold (`#e7b23c`) reserved for LTD / exclusive collectibles.
- **Type:** heavy condensed display for mastheads; a mono face for prices, issue
  codes (e.g. `DS2-14`) and labels — leaning into your real SKU-code catalog.

All colours are editable in **Theme settings → Colours**.

## What's included
- Home, product (cover/variant picker), collection (sort + format chips),
  collections list, cart, search, blog, article, page, 404, password, gift card.
- Customer account, login, register, order, addresses, activation, password reset.
- Configurable sections: Hero, Series grid, Cover grid, Exclusives rail,
  Artists, Newsletter, Header (with announcement bar), Footer.

## Upload to Shopify
**Option A — Admin (zip):**
1. In your Shopify admin go to **Online Store → Themes**.
2. **Add theme → Upload zip file**, choose `divinity-newsstand-theme.zip`
   (in the repo root), and upload.
3. Click **Customize** to preview. It won't go live until you **Publish** it.

**Option B — Shopify CLI (recommended for previewing):**
```bash
cd newshopifytheme
shopify theme dev      # live local preview against your store
shopify theme push     # upload as an unpublished theme
```

## The browsing flow (improved)
Your old flow was **menu → title page with 4 giant "Options" tiles → collection → product**.
This theme keeps your title-first instinct but removes the clunky middle step:

- **Dark mega-menu.** The header renders your existing menu hierarchy
  (Mature Titles → *title* → *format*) as an on-brand dark dropdown, so power
  users jump straight to `Dead Sexy → Books`.
- **Title Hub** (`page.title` template + `title-hub` section) *replaces* the
  giant Options page. It shows the title's art, a compact row of format chips
  (Books / Prints / Digital / Merch) and a live strip of that title's newest
  covers — one page, one click to browse.
  - It **auto-detects** each title's format collections from the page handle
    (`dead-sexy-1` → `dead-sexy-1-books`, `-prints`, `-digital`/`-digitals`,
    `-merch`), so **one template serves every title** — only the formats that
    actually exist show up. To use it: open each title page in Admin, and under
    *Theme templates* choose **title**. No per-page setup needed.

## After uploading — quick steps
1. **Menus.** Create/point these navigation menus in **Admin → Navigation**:
   - `main-menu` (header): e.g. New Drops, Books, Prints, Digital, Exclusives.
   - `footer` (footer columns).
   The header falls back gracefully if a menu is missing.
2. **Check the homepage blocks.** The Series grid, Exclusives rail and Artists
   row are pre-wired to your existing collection handles (`dead-sexy-2-books`,
   `boobs-1-books`, `mindy-wheeler`, …). Swap any of them in the **Theme editor**
   if you reorganize collections.

Nothing in this theme changes your products, collections or data — it's
presentation only.

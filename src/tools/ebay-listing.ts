/**
 * Shared single-auction eBay helpers, extracted so relist/duplicate tools use
 * the exact same proven recipe as ebay_bulk_list_auctions: clean image URL →
 * eBay-hosted picture → createOrReplaceInventoryItem → createOffer (AUCTION,
 * baked-in defaults) → publishOffer.
 */

import { EbayClient } from "../ebay-client.js";
import type { Config } from "../config.js";

/** Strip the CDN query string — eBay's image fetcher fails on Shopify's `?v=…`. */
export function cleanImageUrl(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * `requiresShipping` for a custom (non-variant) draft/order line item. Every
 * custom item in this catalog is a physical good, so default TRUE — Shopify's
 * own default of false is silently wrong for shippable goods. The only exception
 * is genuinely digital products, recognized by "Digital" in the title or a
 * `*pdf*` SKU (the catalog's boobs1pdf / boobs2pdf digital-download pattern).
 */
export function customItemRequiresShipping(title: string | null | undefined, sku?: string | null): boolean {
  const t = (title ?? "").toLowerCase();
  const s = (sku ?? "").toLowerCase();
  return !(t.includes("digital") || s.includes("pdf"));
}

/**
 * Per-unit price for an eBay Fulfillment line item. `lineItemCost` is the cost
 * for the line's quantity, so divide it out. Returns a 2-dp amount + currency.
 */
export function ebayLineUnitPrice(li: { quantity?: number; lineItemCost?: { value?: string; currency?: string } }): { amount: string; currency: string } {
  const total = Number(li.lineItemCost?.value ?? 0) || 0;
  const qty = li.quantity ?? 1;
  const unit = qty > 0 ? total / qty : total;
  return { amount: unit.toFixed(2), currency: li.lineItemCost?.currency ?? "USD" };
}

export interface PublishListingParams {
  sku: string;
  title: string;
  price: string;
  imageUrl: string;
  seriesLabel: string;
  vendor: string;
  /** "AUCTION" (default) uses auctionStartPrice + a listing duration; "FIXED_PRICE"
   *  (Buy It Now) uses a fixed price with availableQuantity and NO duration —
   *  eBay forces Good 'Til Cancelled for fixed price regardless. */
  format?: "AUCTION" | "FIXED_PRICE";
  /** Available quantity for FIXED_PRICE listings (ignored for auctions). Default 1. */
  quantity?: number;
  weightLb?: number;
  requireHostedImage?: boolean;
}

export interface PublishListingResult {
  sku: string;
  itemId: string;
  offerId: string;
  imageHosted: boolean;
  /** Distinct eBay warning messages returned by publishOffer (e.g. the monthly
   *  listing-value note), so callers can summarize instead of failing. */
  warnings: string[];
}

/** Create + publish one eBay listing (auction or fixed-price) using the baked-in defaults. */
export async function publishListing(ebay: EbayClient, config: Config, p: PublishListingParams): Promise<PublishListingResult> {
  const d = config.ebayListing;
  const format = p.format ?? "AUCTION";
  const weightLb = p.weightLb ?? 0.5;
  const quantity = p.quantity ?? 1;
  const requireHostedImage = p.requireHostedImage ?? true;
  const cleanUrl = cleanImageUrl(p.imageUrl);

  // Copy the image to eBay-hosted storage so it shows on eBay Live.
  let listingImage = cleanUrl;
  let imageHosted = false;
  try {
    listingImage = await ebay.uploadHostedPicture(cleanUrl, p.sku);
    imageHosted = true;
  } catch (hostErr) {
    if (requireHostedImage) throw new Error(`image hosting failed (would be invisible on eBay Live): ${hostErr instanceof Error ? hostErr.message : String(hostErr)}`);
    /* keep raw URL; imageHosted stays false */
  }

  await ebay.request("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(p.sku)}`, {
    body: {
      product: {
        title: p.title,
        description: `${p.title}. Published by ${p.vendor}. Brand new, unread, ungraded — shipped bagged & boarded.`,
        imageUrls: [listingImage],
        aspects: { "Series Title": [p.seriesLabel], Publisher: [p.vendor], Type: ["Comic Book"], Language: ["English"] },
      },
      condition: "NEW",
      availability: { shipToLocationAvailability: { quantity } },
      packageWeightAndSize: {
        weight: { value: weightLb, unit: "POUND" },
        packageType: "PACKAGE_THICK_ENVELOPE",
        dimensions: { length: 10, width: 7, height: 1, unit: "INCH" },
      },
    },
  });

  const offerBody: Record<string, unknown> = {
    sku: p.sku,
    marketplaceId: config.ebayMarketplaceId,
    format,
    categoryId: d.categoryId,
    merchantLocationKey: d.locationKey,
    listingPolicies: { fulfillmentPolicyId: d.fulfillmentPolicyId, paymentPolicyId: d.paymentPolicyId, returnPolicyId: d.returnPolicyId },
  };
  if (format === "AUCTION") {
    // Auctions take a listing duration and reject availableQuantity.
    offerBody.listingDuration = d.listingDuration;
    offerBody.pricingSummary = { auctionStartPrice: { value: p.price, currency: "USD" } };
  } else {
    // Fixed price: a set price + quantity, and NO listingDuration (eBay forces GTC).
    offerBody.availableQuantity = quantity;
    offerBody.pricingSummary = { price: { value: p.price, currency: "USD" } };
  }

  const offerRes = await ebay.request("POST", "/sell/inventory/v1/offer", { body: offerBody });
  const offerId = (offerRes.data as { offerId?: string }).offerId;
  if (!offerId) throw new Error("no offerId returned");

  const pub = await ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {});
  const pubData = pub.data as { listingId?: string; warnings?: Array<{ message?: string }> } | undefined;
  const itemId = pubData?.listingId ?? "";
  const warnings = [...new Set((pubData?.warnings ?? []).map((w) => w.message).filter((m): m is string => Boolean(m)))];
  return { sku: p.sku, itemId, offerId, imageHosted, warnings };
}

/**
 * Clear any existing eBay listing data for a SKU so it can be relisted cleanly:
 * withdraw + delete every offer, then delete the inventory item. Tolerant of
 * missing pieces (already-deleted offers, no inventory item).
 */
export async function clearListing(ebay: EbayClient, sku: string): Promise<{ deletedOffers: string[]; deletedInventoryItem: boolean }> {
  const deletedOffers: string[] = [];
  const offerRes = await ebay.request("GET", "/sell/inventory/v1/offer", { query: { sku } }).catch(() => null);
  const offers = (offerRes?.data as { offers?: Array<{ offerId?: string; status?: string; listing?: { listingId?: string } }> } | undefined)?.offers ?? [];
  for (const o of offers) {
    if (!o.offerId) continue;
    // Withdraw first if it's a live listing; ignore failure (may already be ended).
    if (o.status === "PUBLISHED" || o.listing?.listingId) {
      await ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(o.offerId)}/withdraw`, {}).catch(() => null);
    }
    const del = await ebay.request("DELETE", `/sell/inventory/v1/offer/${encodeURIComponent(o.offerId)}`).catch(() => null);
    if (del) deletedOffers.push(o.offerId);
  }
  const invDel = await ebay.request("DELETE", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`).catch(() => null);
  return { deletedOffers, deletedInventoryItem: Boolean(invDel) };
}

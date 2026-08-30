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
 * Per-unit price for an eBay Fulfillment line item. `lineItemCost` is the cost
 * for the line's quantity, so divide it out. Returns a 2-dp amount + currency.
 */
export function ebayLineUnitPrice(li: { quantity?: number; lineItemCost?: { value?: string; currency?: string } }): { amount: string; currency: string } {
  const total = Number(li.lineItemCost?.value ?? 0) || 0;
  const qty = li.quantity ?? 1;
  const unit = qty > 0 ? total / qty : total;
  return { amount: unit.toFixed(2), currency: li.lineItemCost?.currency ?? "USD" };
}

export interface PublishAuctionParams {
  sku: string;
  title: string;
  price: string;
  imageUrl: string;
  seriesLabel: string;
  vendor: string;
  weightLb?: number;
  requireHostedImage?: boolean;
}

export interface PublishAuctionResult {
  sku: string;
  itemId: string;
  offerId: string;
  imageHosted: boolean;
}

/** Create + publish one eBay auction for a SKU using the baked-in listing defaults. */
export async function publishAuction(ebay: EbayClient, config: Config, p: PublishAuctionParams): Promise<PublishAuctionResult> {
  const d = config.ebayListing;
  const weightLb = p.weightLb ?? 0.5;
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
      availability: { shipToLocationAvailability: { quantity: 1 } },
      packageWeightAndSize: {
        weight: { value: weightLb, unit: "POUND" },
        packageType: "PACKAGE_THICK_ENVELOPE",
        dimensions: { length: 10, width: 7, height: 1, unit: "INCH" },
      },
    },
  });

  const offerRes = await ebay.request("POST", "/sell/inventory/v1/offer", {
    body: {
      sku: p.sku,
      marketplaceId: config.ebayMarketplaceId,
      format: "AUCTION",
      categoryId: d.categoryId,
      merchantLocationKey: d.locationKey,
      listingDuration: d.listingDuration,
      listingPolicies: { fulfillmentPolicyId: d.fulfillmentPolicyId, paymentPolicyId: d.paymentPolicyId, returnPolicyId: d.returnPolicyId },
      pricingSummary: { auctionStartPrice: { value: p.price, currency: "USD" } },
    },
  });
  const offerId = (offerRes.data as { offerId?: string }).offerId;
  if (!offerId) throw new Error("no offerId returned");

  const pub = await ebay.request("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {});
  const itemId = (pub.data as { listingId?: string }).listingId ?? "";
  return { sku: p.sku, itemId, offerId, imageHosted };
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

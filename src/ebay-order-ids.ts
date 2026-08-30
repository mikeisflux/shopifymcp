/**
 * Shared eBay order-id helpers. eBay Fulfillment order ids look like
 * `26-15065-57798` (three digit groups). Used to (a) parse the ids the merge
 * tool records in a Shopify order note, and (b) recognize a Shopify order whose
 * name *is* an eBay order id verbatim (this shop's eBay-sync naming).
 */

/** Matches a single eBay order id anywhere in a string. */
const EBAY_ID_GLOBAL = /\b\d{2}-\d{4,6}-\d{4,6}\b/g;

/** True when the whole string is exactly one eBay order id. */
export const EBAY_ORDER_ID_RE = /^\d{2}-\d{4,6}-\d{4,6}$/;

/** Pull every distinct eBay order id out of a Shopify order note. */
export function parseEbayOrderIds(note: string | null | undefined): string[] {
  if (!note) return [];
  const ids = new Set<string>();
  for (const m of note.matchAll(EBAY_ID_GLOBAL)) ids.add(m[0]);
  return [...ids];
}

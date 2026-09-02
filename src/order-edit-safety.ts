/**
 * Shared safeguard for order-editing tools that "zero out a line, then re-add
 * it" (the reprice-to-eBay flow, and any future tool that edits a placed order).
 *
 * Editing an ALREADY-FULFILLED line's quantity does not cleanly remove it —
 * Shopify leaves a residual that double-counts into the order total. This
 * produced a wrong total once (order #12863 came to $181.02 instead of the
 * correct $121.02) and is exactly the class of bug that recurs when the check
 * lives inside one tool's logic instead of being a structural primitive every
 * order-editing tool reaches for.
 *
 * A line is safe to zero-and-replace only if NONE of it is fulfilled yet — the
 * whole quantity must still be editable. Two shapes are supported: a plain Order
 * line (`unfulfilledQuantity`) for the planning pass, and an Order Editing
 * `CalculatedLineItem` (`editableQuantity`) for the execution pass.
 */

/** True when the whole Order line is still unfulfilled (safe to zero-and-replace). */
export function isOrderLineEditable(line: { quantity: number; unfulfilledQuantity: number }): boolean {
  return line.unfulfilledQuantity >= line.quantity;
}

/** True when the whole CalculatedLineItem is still editable (safe to zero-and-replace). */
export function isCalculatedLineEditable(line: { quantity: number; editableQuantity: number }): boolean {
  return line.editableQuantity >= line.quantity;
}

/**
 * Throwing variant for call sites that treat a fulfilled line as a hard stop
 * rather than a skip. Prefer the boolean predicates when the caller wants to
 * report/skip the line instead of aborting.
 */
export function assertCalculatedLineEditable(line: { quantity: number; editableQuantity: number; title?: string | null }): void {
  if (!isCalculatedLineEditable(line)) {
    throw new Error(`Line "${line.title ?? "?"}" is already (partially) fulfilled — zeroing/replacing it would leave a double-counting residual.`);
  }
}

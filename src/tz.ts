/**
 * Timezone helpers (no external deps; uses Intl). Shared by the eBay order
 * tools so a UTC `creationdate` window lines up with the seller's local
 * "Date sold" dashboard across DST.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Offset in ms (localWallClock − UTC) for the given instant in `timeZone`. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // some engines render midnight as 24
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
  return asUtc - date.getTime();
}

/** UTC instant for local wall-clock midnight (00:00:00) of `YYYY-MM-DD` in `timeZone`. */
export function zonedDayStartToUtc(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guessUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0);
  const offset = tzOffsetMs(new Date(guessUtc), timeZone);
  return new Date(guessUtc - offset);
}

/**
 * Convert an inclusive local-date range (`YYYY-MM-DD`..`YYYY-MM-DD`) in
 * `timeZone` to a UTC `[fromUtc, toUtc]` window, with the upper bound CAPPED at
 * `now`. eBay's Fulfillment API rejects a window whose end is in the future
 * ("The start and end dates can't be in the future [30850]"), which happens
 * whenever `dateTo` is today — the naive end-of-day timestamp is still in the
 * future until the day is over. Capping at now makes `dateTo: <today>` behave
 * the same way a `sinceDays` query already does.
 */
export function localDateRangeToUtc(dateFrom: string, dateTo: string, timeZone: string, nowMs = Date.now()): { fromUtc: Date; toUtc: Date } {
  const fromUtc = zonedDayStartToUtc(dateFrom, timeZone);
  const endExclusive = zonedDayStartToUtc(dateTo, timeZone).getTime() + DAY_MS; // start of the day after dateTo
  return { fromUtc, toUtc: new Date(Math.min(endExclusive, nowMs)) };
}

/** The wall-clock hour, minute, and `YYYY-MM-DD` date of `date` in `timeZone`. */
export function zonedClock(date: Date, timeZone: string): { hour: number; minute: number; dateStr: string } {
  const iso = toZonedIso(date, timeZone); // e.g. 2026-09-03T14:07:06-05:00
  return { hour: Number(iso.slice(11, 13)), minute: Number(iso.slice(14, 16)), dateStr: iso.slice(0, 10) };
}

/** Format a UTC Date as an ISO-8601 string carrying `timeZone`'s local offset. */
export function toZonedIso(date: Date, timeZone: string): string {
  const offset = tzOffsetMs(date, timeZone);
  const local = new Date(date.getTime() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const oh = Math.floor(abs / 3_600_000);
  const om = Math.floor((abs % 3_600_000) / 60_000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(oh)}:${pad(om)}`
  );
}

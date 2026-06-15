/**
 * Market hours gating for NYSE / NASDAQ.
 * All time logic uses America/New_York via Intl — no external deps required.
 */

export type MarketState = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED' | 'HOLIDAY';

// ── Dev override ─────────────────────────────────────────────────────────────
// Set to true to force REGULAR state regardless of actual time/day.
export const DEV_OVERRIDE: boolean =
  import.meta.env.DEV && (import.meta.env.VITE_MARKET_DEV_OVERRIDE ?? 'false') === 'true';

// ── Holiday / early-close data ───────────────────────────────────────────────

interface HolidayEntry {
  date: string;        // YYYY-MM-DD in ET
  name: string;
  earlyClose?: string; // 'HH:MM' ET — if present it is an early-close day, not a full holiday
}

const HOLIDAYS: HolidayEntry[] = [
  // ── 2024 ─────────────────────────────────────────────────────────────────
  { date: '2024-01-01', name: "New Year's Day" },
  { date: '2024-01-15', name: 'MLK Jr. Day' },
  { date: '2024-02-19', name: "Presidents' Day" },
  { date: '2024-03-29', name: 'Good Friday' },
  { date: '2024-05-27', name: 'Memorial Day' },
  { date: '2024-06-19', name: 'Juneteenth' },
  { date: '2024-07-04', name: 'Independence Day' },
  { date: '2024-09-02', name: 'Labor Day' },
  { date: '2024-11-28', name: 'Thanksgiving Day' },
  { date: '2024-12-25', name: 'Christmas Day' },
  // Early closes 2024
  { date: '2024-07-03', name: 'Independence Day Eve',      earlyClose: '13:00' },
  { date: '2024-11-29', name: 'Day After Thanksgiving',    earlyClose: '13:00' },
  { date: '2024-12-24', name: 'Christmas Eve',             earlyClose: '13:00' },

  // ── 2025 ─────────────────────────────────────────────────────────────────
  { date: '2025-01-01', name: "New Year's Day" },
  { date: '2025-01-09', name: 'National Day of Mourning' },
  { date: '2025-01-20', name: 'MLK Jr. Day' },
  { date: '2025-02-17', name: "Presidents' Day" },
  { date: '2025-04-18', name: 'Good Friday' },
  { date: '2025-05-26', name: 'Memorial Day' },
  { date: '2025-06-19', name: 'Juneteenth' },
  { date: '2025-07-04', name: 'Independence Day' },
  { date: '2025-09-01', name: 'Labor Day' },
  { date: '2025-11-27', name: 'Thanksgiving Day' },
  { date: '2025-12-25', name: 'Christmas Day' },
  // Early closes 2025
  { date: '2025-07-03', name: 'Independence Day Eve',      earlyClose: '13:00' },
  { date: '2025-11-28', name: 'Day After Thanksgiving',    earlyClose: '13:00' },
  { date: '2025-12-24', name: 'Christmas Eve',             earlyClose: '13:00' },

  // ── 2026 ─────────────────────────────────────────────────────────────────
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-19', name: 'MLK Jr. Day' },
  { date: '2026-02-16', name: "Presidents' Day" },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-05-25', name: 'Memorial Day' },
  { date: '2026-06-19', name: 'Juneteenth' },
  { date: '2026-07-03', name: 'Independence Day (Observed)' }, // Jul 4 falls on Saturday
  { date: '2026-09-07', name: 'Labor Day' },
  { date: '2026-11-26', name: 'Thanksgiving Day' },
  { date: '2026-12-25', name: 'Christmas Day' },
  // Early closes 2026
  { date: '2026-07-02', name: 'Independence Day Eve',      earlyClose: '13:00' },
  { date: '2026-11-27', name: 'Day After Thanksgiving',    earlyClose: '13:00' },
  { date: '2026-12-24', name: 'Christmas Eve',             earlyClose: '13:00' },

  // ── 2027 ─────────────────────────────────────────────────────────────────
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-18', name: 'MLK Jr. Day' },
  { date: '2027-02-15', name: "Presidents' Day" },
  { date: '2027-03-26', name: 'Good Friday' },
  { date: '2027-05-31', name: 'Memorial Day' },
  { date: '2027-06-18', name: 'Juneteenth (Observed)' },  // Jun 19 falls on Saturday
  { date: '2027-07-05', name: 'Independence Day (Observed)' }, // Jul 4 falls on Sunday
  { date: '2027-09-06', name: 'Labor Day' },
  { date: '2027-11-25', name: 'Thanksgiving Day' },
  { date: '2027-12-24', name: 'Christmas Day (Observed)' }, // Dec 25 falls on Saturday
  // Early closes 2027
  { date: '2027-07-02', name: 'Independence Day Eve',      earlyClose: '13:00' },
  { date: '2027-11-26', name: 'Day After Thanksgiving',    earlyClose: '13:00' },
  { date: '2027-12-23', name: 'Christmas Eve (Observed)',   earlyClose: '13:00' },

  // ── 2028 ─────────────────────────────────────────────────────────────────
  { date: '2028-01-17', name: 'MLK Jr. Day' },
  { date: '2028-02-21', name: "Presidents' Day" },
  { date: '2028-04-14', name: 'Good Friday' },
  { date: '2028-05-29', name: 'Memorial Day' },
  { date: '2028-06-19', name: 'Juneteenth' },
  { date: '2028-07-04', name: 'Independence Day' },
  { date: '2028-09-04', name: 'Labor Day' },
  { date: '2028-11-23', name: 'Thanksgiving Day' },
  { date: '2028-12-25', name: 'Christmas Day' },
  // Early closes 2028
  { date: '2028-07-03', name: 'Independence Day Eve',      earlyClose: '13:00' },
  { date: '2028-11-24', name: 'Day After Thanksgiving',    earlyClose: '13:00' },
  { date: '2028-12-22', name: 'Christmas Eve (Observed)',   earlyClose: '13:00' },
];

// ── Internal ET helpers ───────────────────────────────────────────────────────

/** Returns the ET date as "YYYY-MM-DD". */
export function etDateStr(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // en-CA locale produces ISO date order
}

/** Returns "HH:MM" (24-hour) in ET. */
function etTimeHHMM(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const h = parts.find((p) => p.type === 'hour')!.value.padStart(2, '0');
  const m = parts.find((p) => p.type === 'minute')!.value.padStart(2, '0');
  return `${h}:${m}`;
}

/** Returns the day-of-week (0 = Sunday … 6 = Saturday) in ET. */
function etDayOfWeek(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year  = parseInt(parts.find((p) => p.type === 'year')!.value);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value);
  const day   = parseInt(parts.find((p) => p.type === 'day')!.value);
  return new Date(year, month - 1, day).getDay();
}

/**
 * Computes the UTC timestamp that corresponds to a given wall-clock time (hh, mm)
 * in America/New_York on the same calendar date as `now` (in ET).
 * Handles DST correctly without any external library.
 */
function etWallClockToUTC(now: Date, hh: number, mm: number): Date {
  // Read current ET wall-clock components
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const getV = (t: string) => parseInt(parts.find((p) => p.type === t)!.value);
  const etYear = getV('year'), etMonth = getV('month'), etDay = getV('day');
  const etHour = getV('hour'), etMin = getV('minute'), etSec = getV('second');

  // UTC offset at this moment: nowUTC - nowETAsUTC (treating ET as if UTC)
  const nowUTC   = now.getTime();
  const nowETasUTC = Date.UTC(etYear, etMonth - 1, etDay, etHour, etMin, etSec);
  const offsetMs = nowUTC - nowETasUTC; // positive for west-of-UTC timezones

  // Target ET wall clock → UTC
  const targetETasUTC = Date.UTC(etYear, etMonth - 1, etDay, hh, mm, 0);
  return new Date(targetETasUTC + offsetMs);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Determine which market session is active right now (or at a given Date). */
export function getMarketState(now: Date = new Date()): MarketState {
  if (DEV_OVERRIDE) return 'REGULAR';

  const dateStr = etDateStr(now);
  const timeStr = etTimeHHMM(now);
  const dow     = etDayOfWeek(now);

  // Weekend — always closed
  if (dow === 0 || dow === 6) return 'CLOSED';

  // Lookup holiday table
  const entry = HOLIDAYS.find((h) => h.date === dateStr);

  // Full holiday (no earlyClose field)
  if (entry && !entry.earlyClose) return 'HOLIDAY';

  // Regular-session close time (earlier on early-close days)
  const regularClose = entry?.earlyClose ?? '16:00';

  if (timeStr < '04:00') return 'CLOSED';        // overnight / very early morning
  if (timeStr < '09:30') return 'PRE_MARKET';    // 04:00 – 09:29
  if (timeStr < regularClose) return 'REGULAR';  // 09:30 – close
  if (timeStr < '20:00') return 'AFTER_HOURS';   // close – 20:00
  return 'CLOSED';                               // 20:00+ overnight
}

/**
 * Returns the holiday name for the given date (CLOSED days only, not early-close).
 * Returns null if not a holiday.
 */
export function getHolidayName(now: Date = new Date()): string | null {
  const dateStr = etDateStr(now);
  const entry = HOLIDAYS.find((h) => h.date === dateStr && !h.earlyClose);
  return entry?.name ?? null;
}

/**
 * Returns the UTC Date at which the regular session opens (09:30 ET) today.
 * Useful for PRE_MARKET countdown.
 */
export function getNextOpenTime(now: Date = new Date()): Date {
  return etWallClockToUTC(now, 9, 30);
}

/**
 * Formats a millisecond duration as "HH:MM:SS".
 */
export function formatCountdown(ms: number): string {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(1, '0')}:${String(s).padStart(2, '0')}`;
}

/** Returns today's date as "YYYY-MM-DD" in ET. */
export function getTodayET(now: Date = new Date()): string {
  return etDateStr(now);
}

/**
 * Returns the most recent regular trading day (YYYY-MM-DD, ET) before `now`.
 * Used to locate historical data for after-hours, closed, or holiday states.
 *
 * - Weekends → previous Friday
 * - Monday after a full-holiday Monday → previous Friday
 * - After-hours on a trading day → that same calendar date (today still has data)
 */
export function getPreviousTradingDay(now: Date = new Date()): string {
  let probe = new Date(now);
  for (let attempts = 0; attempts < 10; attempts++) {
    // Step back one calendar day
    probe = new Date(probe.getTime() - 24 * 60 * 60 * 1000);
    const dateStr = etDateStr(probe);
    const dow = etDayOfWeek(probe);
    // Skip weekends
    if (dow === 0 || dow === 6) continue;
    // Skip full holidays (not early-close days)
    const isHoliday = HOLIDAYS.some((h) => h.date === dateStr && !h.earlyClose);
    if (isHoliday) continue;
    return dateStr;
  }
  // Fallback: should never reach
  return etDateStr(probe);
}

/**
 * Returns the trading date whose data should be displayed for the current state:
 * - AFTER_HOURS → today (regular session already completed)
 * - CLOSED / HOLIDAY → previous trading day
 */
export function getHistoricalTradingDate(state: MarketState, now: Date = new Date()): string {
  if (state === 'AFTER_HOURS') return getTodayET(now);
  return getPreviousTradingDay(now);
}

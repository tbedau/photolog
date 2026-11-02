// Calendar helpers. A photo's `day` is a plain YYYY-MM-DD string, so all
// formatting is done on the string itself and never shifts with time zones.

export const TIMEZONE = "Europe/Berlin";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Europe/Berlin as YYYY-MM-DD. */
export function todayInBerlin(now = new Date()): string {
  // Assembled from parts so it doesn't depend on a locale's date pattern.
  const p = Object.fromEntries(dayFormatter.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function parts(day: string): { y: string; m: number; d: string } {
  const [y, m, d] = day.split("-");
  return { y, m: Number(m), d };
}

/** "/2026/10/18" */
export function permalink(day: string): string {
  return "/" + day.replaceAll("-", "/");
}

/** "18 October 2026" */
export function longDate(day: string): string {
  const { y, m, d } = parts(day);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "18 Oct" */
export function shortDate(day: string): string {
  const { m, d } = parts(day);
  return `${d} ${MONTHS[m - 1].slice(0, 3)}`;
}

/** "October 2026" */
export function monthLabel(day: string): string {
  const { y, m } = parts(day);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Validates /Y/M/D path parts and returns YYYY-MM-DD, or null. */
export function dayFromPath(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

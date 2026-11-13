/** Sorting and "date added" filtering for the library grid (pure, no React). */

export type SortOrder = "newest" | "oldest" | "title" | "title-desc" | "relevance";

export const SORT_LABEL: Record<SortOrder, string> = {
  newest: "Newest added",
  oldest: "Oldest added",
  title: "Title A–Z",
  "title-desc": "Title Z–A",
  relevance: "Best match",
};

export type DatePreset = "all" | "today" | "week" | "last7" | "month" | "last30" | "year" | "custom";

export const DATE_LABEL: Record<DatePreset, string> = {
  all: "Any time",
  today: "Today",
  week: "This week",
  last7: "Last 7 days",
  month: "This month",
  last30: "Last 30 days",
  year: "This year",
  custom: "Custom range…",
};

/** `from`/`to` are "YYYY-MM-DD" (from <input type="date">), both inclusive, local time. */
export type DateFilter = { preset: DatePreset; from: string; to: string };

export const ANY_TIME: DateFilter = { preset: "all", from: "", to: "" };

type Dated = { createdAt: string; title: string | null; filename: string };

/**
 * Parses the stored RFC 3339 time. Rust writes up to 9 fractional digits, which
 * WebKit's Date parser rejects, so the fraction is trimmed to milliseconds.
 */
export function addedAt(createdAt: string): number {
  const t = Date.parse(createdAt.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? 0 : t;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function parseDay(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** The [start, end) window in ms for a filter, or null for "any time". Weeks start on Monday. */
export function dateWindow(f: DateFilter, now = new Date()): [number, number] | null {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1).getTime();
  switch (f.preset) {
    case "all":
      return null;
    case "today":
      return [today.getTime(), tomorrow];
    case "week":
      return [addDays(today, -((today.getDay() + 6) % 7)).getTime(), tomorrow];
    case "last7":
      return [addDays(today, -6).getTime(), tomorrow];
    case "month":
      return [new Date(today.getFullYear(), today.getMonth(), 1).getTime(), tomorrow];
    case "last30":
      return [addDays(today, -29).getTime(), tomorrow];
    case "year":
      return [new Date(today.getFullYear(), 0, 1).getTime(), tomorrow];
    case "custom": {
      let from = parseDay(f.from);
      let to = parseDay(f.to);
      if (!from && !to) return null;
      if (from && to && from > to) [from, to] = [to, from];
      return [from ? from.getTime() : -Infinity, to ? addDays(to, 1).getTime() : Infinity];
    }
  }
}

export function filterByDate<T extends Dated>(memes: T[], f: DateFilter, now = new Date()): T[] {
  const w = dateWindow(f, now);
  if (!w) return memes;
  return memes.filter((m) => {
    const t = addedAt(m.createdAt);
    return t >= w[0] && t < w[1];
  });
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sorts a copy. "relevance" keeps the order the search returned. */
export function sortMemes<T extends Dated>(memes: T[], order: SortOrder): T[] {
  if (order === "relevance") return memes;
  const name = (m: T) => (m.title || m.filename).trim();
  const out = [...memes];
  switch (order) {
    case "newest":
      return out.sort((a, b) => addedAt(b.createdAt) - addedAt(a.createdAt));
    case "oldest":
      return out.sort((a, b) => addedAt(a.createdAt) - addedAt(b.createdAt));
    case "title":
      return out.sort((a, b) => collator.compare(name(a), name(b)));
    case "title-desc":
      return out.sort((a, b) => collator.compare(name(b), name(a)));
  }
}

/** "Today 14:03", "Yesterday 09:12", "Mon 10 Nov", or "10 Nov 2025" for other years. */
export function shortAdded(createdAt: string, now = new Date()): string {
  const t = addedAt(createdAt);
  if (!t) return "";
  const d = new Date(t);
  const day = startOfDay(d).getTime();
  const today = startOfDay(now).getTime();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (day === today) return `Today ${time}`;
  if (day === addDays(new Date(today), -1).getTime()) return `Yesterday ${time}`;
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "Thursday, 13 November 2026 at 14:03" */
export function fullAdded(createdAt: string): string {
  const t = addedAt(createdAt);
  if (!t) return "Unknown";
  return new Date(t).toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 1536 → "1.5 KB"; one decimal under 10. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

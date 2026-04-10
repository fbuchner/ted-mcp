// NUTS code lookup with case-insensitive substring matching.
// Data loaded from auto-generated nuts_data.ts (source: data/nuts_codes.csv).

import { NUTS_DATA } from "./nuts_data.js";

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Pre-built index: { normalizedLabel -> code, ... } and code set
const NORM_INDEX: Array<{ norm: string; code: string }> = NUTS_DATA.map((e) => ({
  norm: normalize(e.label),
  code: e.code.toUpperCase(),
}));
const CODE_SET = new Set(NUTS_DATA.map((e) => e.code.toUpperCase()));

const COUNTRY_ALIASES: Record<string, string> = {
  austria: "AT", belgium: "BE", bulgaria: "BG", croatia: "HR",
  cyprus: "CY", czechia: "CZ", "czech republic": "CZ", denmark: "DK",
  estonia: "EE", finland: "FI", france: "FR", germany: "DE",
  greece: "EL", hellas: "EL", hungary: "HU", ireland: "IE",
  italy: "IT", latvia: "LV", lithuania: "LT", luxembourg: "LU",
  malta: "MT", netherlands: "NL", poland: "PL", portugal: "PT",
  romania: "RO", slovakia: "SK", slovenia: "SI", spain: "ES",
  sweden: "SE", iceland: "IS", liechtenstein: "LI", norway: "NO",
  switzerland: "CH", "united kingdom": "UK", uk: "UK",
};

const COUNTRY_CODE_SET = new Set(Object.values(COUNTRY_ALIASES));

const NUTS_CODE_RE = /^[A-Za-z]{2}[A-Za-z0-9]{0,3}$/;

export function resolveNuts(value: string): string[] {
  if (!value) return [];
  const v = value.trim();

  // Pass through valid NUTS codes that exist in our data
  if (NUTS_CODE_RE.test(v)) {
    const upper = v.toUpperCase();
    if (CODE_SET.has(upper) || COUNTRY_CODE_SET.has(upper)) {
      return [upper];
    }
  }

  const key = normalize(v);

  // Check country aliases
  if (COUNTRY_ALIASES[key]) return [COUNTRY_ALIASES[key]];

  // Exact match on normalized label
  const exact = NORM_INDEX.filter((e) => e.norm === key);
  if (exact.length > 0) return exact.map((e) => e.code);

  // Substring match
  const matches = NORM_INDEX.filter((e) => e.norm.includes(key));
  return matches.map((e) => e.code);
}

export function resolveNutsList(
  values: string[],
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const v of values) {
    const codes = resolveNuts(v);
    if (codes.length > 0) resolved.push(...codes);
    else unresolved.push(v);
  }
  return { resolved, unresolved };
}

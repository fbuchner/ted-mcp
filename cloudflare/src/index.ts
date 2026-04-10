import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveNutsList } from "./nuts_codes.js";

// ============ TED Client ============

const TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search";

const AWARD_FIELDS = [
  "publication-number",
  "notice-type",
  "publication-date",
  "buyer-name",
  "buyer-country",
  "winner-name",
  "winner-country",
  "winner-decision-date",
  "result-value-notice",
  "result-value-cur-notice",
  "classification-cpv",
  "contract-title",
];

class TEDAPIError extends Error {}
class TEDTimeoutError extends TEDAPIError {}
class TEDConnectionError extends TEDAPIError {}
class TEDBadRequestError extends TEDAPIError {}

async function tedSearch(
  query: string,
  fields?: string[],
  page = 1,
  limit = 10,
  paginationMode = "PAGE_NUMBER",
  iterationToken?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    query,
    fields: fields ?? AWARD_FIELDS,
    page,
    limit,
    paginationMode,
  };
  if (iterationToken) {
    body["iterationNextToken"] = iterationToken;
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
      response = await fetch(TED_SEARCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new TEDTimeoutError("TED API timed out. Try narrowing your query.");
    }
    throw new TEDConnectionError(`Failed to connect to TED API: ${e}`);
  }

  if (response.status === 400) {
    let msg: string;
    try {
      const data = (await response.json()) as Record<string, unknown>;
      msg = String(data["message"] ?? data["error"] ?? response.statusText);
    } catch {
      msg = await response.text();
    }
    throw new TEDBadRequestError(`TED API bad request: ${msg}`);
  }

  if (response.status !== 200) {
    const text = await response.text();
    throw new TEDAPIError(`TED API returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

// ============ Models ============

const LANGUAGE_PRIORITY = ["eng", "deu", "fra", "nld", "ita", "spa", "por", "pol"];

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€", GBP: "£", USD: "$", CHF: "CHF", PLN: "PLN",
  SEK: "SEK", DKK: "DKK", NOK: "NOK", CZK: "CZK",
  HUF: "HUF", RON: "RON", BGN: "BGN", HRK: "HRK",
};

function pickBestLanguage(field: unknown): string | null {
  if (field == null) return null;
  if (typeof field === "string") return field;
  if (typeof field !== "object" || Array.isArray(field)) return String(field);
  const f = field as Record<string, unknown>;
  for (const lang of LANGUAGE_PRIORITY) {
    if (lang in f) {
      const values = f[lang];
      if (Array.isArray(values) && values.length > 0) return String(values[0]);
      if (typeof values === "string") return values;
    }
  }
  for (const values of Object.values(f)) {
    if (Array.isArray(values) && values.length > 0) return String(values[0]);
    if (typeof values === "string") return values;
  }
  return null;
}

function pickAllLanguages(field: unknown): string[] {
  if (field == null) return [];
  if (typeof field === "string") return [field];
  if (typeof field !== "object" || Array.isArray(field)) return [String(field)];
  const f = field as Record<string, unknown>;
  const seen = new Set<string>();
  const result: string[] = [];
  const addValue = (v: unknown) => {
    const s = String(v);
    if (!seen.has(s)) { seen.add(s); result.push(s); }
  };
  for (const lang of LANGUAGE_PRIORITY) {
    if (!(lang in f)) continue;
    const values = f[lang];
    if (Array.isArray(values)) values.forEach(addValue);
    else if (typeof values === "string") addValue(values);
  }
  for (const [lang, values] of Object.entries(f)) {
    if (LANGUAGE_PRIORITY.includes(lang)) continue;
    if (Array.isArray(values)) values.forEach(addValue);
    else if (typeof values === "string") addValue(values);
  }
  return result;
}

function zipWinners(
  notice: Record<string, unknown>,
  maxCount?: number,
): Array<{ name: string; country: string }> {
  const rawNames = notice["winner-name"];
  const rawCountries = notice["winner-country"] ?? [];

  if (!rawNames) return [];

  let names: string[] = [];
  if (typeof rawNames === "object" && !Array.isArray(rawNames)) {
    const f = rawNames as Record<string, unknown>;
    for (const lang of LANGUAGE_PRIORITY) {
      if (lang in f) {
        const vals = f[lang];
        if (Array.isArray(vals) && vals.length > 0) { names = vals.map(String); break; }
        if (typeof vals === "string") { names = [vals]; break; }
      }
    }
    if (names.length === 0) {
      for (const vals of Object.values(f)) {
        if (Array.isArray(vals) && vals.length > 0) { names = vals.map(String); break; }
        if (typeof vals === "string") { names = [vals]; break; }
      }
    }
  } else if (Array.isArray(rawNames)) {
    names = rawNames.map(String);
  }

  if (names.length === 0) return [];

  const countries: string[] = Array.isArray(rawCountries) ? rawCountries.map(String) : [];
  const limit = maxCount != null ? Math.min(names.length, maxCount) : names.length;
  return Array.from({ length: limit }, (_, i) => ({
    name: names[i],
    country: countries[i] ?? "",
  }));
}

function formatValue(notice: Record<string, unknown>): string {
  const value = notice["result-value-notice"];
  const currency = String(notice["result-value-cur-notice"] ?? "EUR");
  if (value == null) return "Not disclosed";
  const fval = parseFloat(String(value));
  if (isNaN(fval) || fval <= 0.01) return "Not disclosed";
  const symbol = CURRENCY_SYMBOLS[currency] ?? currency;
  if (fval >= 1_000_000) return `${symbol}${(fval / 1_000_000).toFixed(2)}M`;
  if (fval >= 1_000) return `${symbol}${(fval / 1_000).toFixed(1)}K`;
  return `${symbol}${fval.toFixed(2)}`;
}

function extractBuyerCountry(notice: Record<string, unknown>): string | null {
  const val = notice["buyer-country"];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return String(val[0]);
  return null;
}

interface NoticeSearchResult {
  publication_number: string;
  notice_type: string | null;
  publication_date: string | null;
  buyer_name: string | null;
  buyer_country: string | null;
  winners: Array<{ name: string; country: string }>;
  total_winners: number;
  contract_value: string;
  cpv_codes: string[];
  contract_title: string | null;
  ted_url: string;
}

function noticeFromRaw(notice: Record<string, unknown>, maxWinners = 10): NoticeSearchResult {
  const pubNum = String(notice["publication-number"] ?? "");
  const allWinners = zipWinners(notice);
  const cpvRaw = notice["classification-cpv"];
  const cpvCodes = Array.isArray(cpvRaw) ? cpvRaw.map(String) : cpvRaw != null ? [String(cpvRaw)] : [];
  return {
    publication_number: pubNum,
    notice_type: notice["notice-type"] != null ? String(notice["notice-type"]) : null,
    publication_date: notice["publication-date"] != null ? String(notice["publication-date"]) : null,
    buyer_name: pickBestLanguage(notice["buyer-name"]),
    buyer_country: extractBuyerCountry(notice),
    winners: allWinners.slice(0, maxWinners),
    total_winners: allWinners.length,
    contract_value: formatValue(notice),
    cpv_codes: cpvCodes,
    contract_title: pickBestLanguage(notice["contract-title"]),
    ted_url: pubNum ? `https://ted.europa.eu/en/notice/-/detail/${pubNum}` : "",
  };
}

// ============ Markdown Formatter ============

function formatNoticesMarkdown(results: NoticeSearchResult[], total: number, query: string): string {
  const lines: string[] = [`**Found ${total} notices** for query: \`${query}\`\n`];
  if (results.length === 0) {
    lines.push("No results returned.");
    return lines.join("\n");
  }
  for (const r of results) {
    lines.push(`### [${r.publication_number}](${r.ted_url})`);
    lines.push(`- **Date:** ${r.publication_date ?? "N/A"}`);
    lines.push(`- **Type:** ${r.notice_type ?? "N/A"}`);
    if (r.contract_title) lines.push(`- **Title:** ${r.contract_title}`);
    lines.push(`- **Buyer:** ${r.buyer_name ?? "N/A"} (${r.buyer_country ?? "N/A"})`);
    if (r.winners.length > 0) {
      const winnerStrs = r.winners.map((w) => (w.country ? `${w.name} (${w.country})` : w.name));
      let shown = winnerStrs.join(", ");
      if (r.total_winners > r.winners.length) shown += ` ... (+${r.total_winners - r.winners.length} more)`;
      lines.push(`- **Winner(s):** ${shown}`);
    } else {
      lines.push("- **Winner(s):** N/A");
    }
    lines.push(`- **Value:** ${r.contract_value}`);
    if (r.cpv_codes.length > 0) lines.push(`- **CPV:** ${r.cpv_codes.slice(0, 5).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ============ MCP Agent ============

export interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}

export class TedMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "TED EU Procurement",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "get_notice",
      "Retrieve full details of a single TED procurement notice.",
      {
        publication_number: z.string().describe('TED publication number in format NNNNNN-YYYY. E.g. "6091-2024", "123456-2023"'),
      },
      async ({ publication_number }) => {
        const detailFields = [...new Set([...AWARD_FIELDS, "procedure-type"])];

        let data: Record<string, unknown>;
        try {
          data = await tedSearch(`publication-number=${publication_number}`, detailFields, 1, 1);
        } catch (e) {
          if (e instanceof TEDTimeoutError) {
            return { content: [{ type: "text" as const, text: "Error: TED API timed out." }] };
          }
          if (e instanceof TEDBadRequestError) {
            return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
          }
          return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
        }

        const notices = (data["notices"] as unknown[] | undefined) ?? [];
        if (notices.length === 0) {
          return { content: [{ type: "text" as const, text: `No notice found with publication number \`${publication_number}\`.\n\nCheck the format is NNNNNN-YYYY (e.g. 6091-2024).` }] };
        }

        const n = notices[0] as Record<string, unknown>;
        const pubNum = String(n["publication-number"] ?? publication_number);
        const tedUrl = `https://ted.europa.eu/en/notice/-/detail/${pubNum}`;

        const lines: string[] = [`## Notice ${pubNum}`, `**URL:** ${tedUrl}\n`];
        lines.push(`**Type:** ${n["notice-type"] ?? "N/A"}`);
        lines.push(`**Publication Date:** ${n["publication-date"] ?? "N/A"}`);
        if (n["procedure-type"]) lines.push(`**Procedure Type:** ${n["procedure-type"]}`);

        const title = pickBestLanguage(n["contract-title"]);
        if (title) lines.push(`**Contract Title:** ${title}`);

        lines.push("", "### Buyer");
        const buyerNames = pickAllLanguages(n["buyer-name"]);
        if (buyerNames.length > 0) lines.push(`**Name:** ${buyerNames.join(" / ")}`);
        const buyerCountry = extractBuyerCountry(n);
        if (buyerCountry) lines.push(`**Country:** ${buyerCountry}`);

        lines.push("", "### Contract Value");
        lines.push(formatValue(n));

        const cpvRaw = n["classification-cpv"];
        if (Array.isArray(cpvRaw) && cpvRaw.length > 0) {
          lines.push(`\n**CPV Codes:** ${cpvRaw.join(", ")}`);
        }

        const allWinners = zipWinners(n);
        const decisionDate = n["winner-decision-date"];
        lines.push(`\n### Winners (${allWinners.length} total)`);
        if (decisionDate) lines.push(`**Award Decision Date:** ${decisionDate}`);

        if (allWinners.length > 0) {
          allWinners.forEach((w, i) => {
            const countryStr = w.country ? ` (${w.country})` : "";
            lines.push(`${i + 1}. ${w.name}${countryStr}`);
          });
        } else {
          lines.push("No winner data available (may not be a contract award notice).");
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      },
    );

    this.server.tool(
      "search_notices_raw",
      'Search EU public procurement notices on TED via expert query. Combine clauses with AND/OR/NOT. Common fields: buyer-country=DEU, winner-name~"Deloitte", notice-type=can-standard, PD>=20240101 AND PD<=20241231, classification-cpv IN (72000000), FT~"keyword". For place-of-performance, prefer the place_of_performance argument (accepts NUTS codes or region names). Supports ITERATION pagination for >15 000 results. Tips: use 3-letter ISO country codes; winner data is most reliable for can-standard notices from 2021 onwards.',
      {
        expert_query: z.string().describe('TED expert query string. E.g. `notice-type=can-standard AND winner-name~"Deloitte" AND buyer-country=DEU AND PD>=20240101 AND PD<=20241231`'),
        place_of_performance: z.array(z.string()).optional().describe('NUTS codes or region names to filter by place of performance. Uses substring matching, then ANDed onto the expert query as `place-of-performance IN (...)`. IMPORTANT: Labels are in the native language of the region (e.g. "Bayern" not "Bavaria", "Île-de-France" not "Paris Region"). Use native-language names for best results. E.g. ["Bayern"], ["DE21","FR10"], ["München"].'),
        fields: z.array(z.string()).optional().describe("List of fields to return. Defaults to standard award fields."),
        page: z.number().int().default(1).describe("Page number for PAGE_NUMBER mode"),
        page_size: z.number().int().default(10).describe("Results per page (1-100)"),
        pagination_mode: z.enum(["PAGE_NUMBER", "ITERATION"]).default("PAGE_NUMBER").describe("Pagination mode"),
        iteration_token: z.string().optional().describe("Token from previous ITERATION response for next page"),
      },
      async ({ expert_query, place_of_performance, fields, page, page_size, pagination_mode, iteration_token }) => {
        const limitedPageSize = Math.max(1, Math.min(100, page_size));

        let effectiveQuery = expert_query;
        let nutsWarning = "";
        if (place_of_performance && place_of_performance.length > 0) {
          const { resolved, unresolved } = resolveNutsList(place_of_performance);
          if (resolved.length > 0) {
            const quoted = resolved.map((c) => `"${c}"`).join(", ");
            const clause = `place-of-performance IN (${quoted})`;
            effectiveQuery = effectiveQuery.trim() ? `(${effectiveQuery}) AND ${clause}` : clause;
          }
          if (unresolved.length > 0) {
            nutsWarning = `\n\n> **Note:** Could not resolve NUTS codes for: ${unresolved.join(", ")}. Pass an explicit NUTS code (e.g. \`DE21\`) or a recognised region name.`;
          }
        }

        let data: Record<string, unknown>;
        try {
          data = await tedSearch(effectiveQuery, fields, page, limitedPageSize, pagination_mode, iteration_token);
        } catch (e) {
          if (e instanceof TEDTimeoutError) {
            return { content: [{ type: "text" as const, text: "Error: TED API timed out. Try narrowing your query." }] };
          }
          if (e instanceof TEDBadRequestError) {
            return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
          }
          return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }] };
        }

        const noticesRaw = (data["notices"] as unknown[] | undefined) ?? [];
        const total = (data["totalNoticeCount"] as number | undefined) ?? 0;
        const timedOut = Boolean(data["timedOut"]);
        const nextToken = data["iterationNextToken"] as string | undefined;

        const results = noticesRaw.map((n) => noticeFromRaw(n as Record<string, unknown>));
        let output = formatNoticesMarkdown(results, total, effectiveQuery);

        if (nextToken) {
          output += `\n\n**Next page token (ITERATION):** \`${nextToken}\`\n(Pass as \`iteration_token\` in next call)`;
        }
        if (timedOut) {
          output += "\n\n> **Warning:** TED API query timed out — results may be incomplete.";
        }
        if (nutsWarning) {
          output += nutsWarning;
        }

        return { content: [{ type: "text" as const, text: output }] };
      },
    );
  }
}

// ============ Worker Entry Point ============

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return TedMCP.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return TedMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      "TED EU Procurement MCP Server\n\nEndpoints:\n- POST /mcp  (HTTP Streamable)\n- GET  /sse  (Server-Sent Events)",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;

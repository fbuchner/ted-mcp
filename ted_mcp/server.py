from __future__ import annotations
from contextlib import asynccontextmanager
from dataclasses import dataclass
import math
import httpx
from mcp.server.fastmcp import FastMCP, Context
from .ted_client import TEDClient, TEDTimeoutError, TEDBadRequestError, TEDAPIError, AWARD_FIELDS
from .models import NoticeSearchResult, zip_winners, pick_best_language, pick_all_languages, format_value
from .nuts_codes import resolve_nuts_list


@dataclass
class AppContext:
    ted_client: TEDClient


@asynccontextmanager
async def lifespan(server: FastMCP):
    async with httpx.AsyncClient() as client:
        yield AppContext(ted_client=TEDClient(client))


mcp = FastMCP("TED EU Procurement", lifespan=lifespan)


def _format_notices_markdown(
    results: list[NoticeSearchResult],
    total: int,
    query: str,
    page: int = 1,
    page_size: int = 10,
) -> str:
    total_pages = math.ceil(total / page_size) if page_size else 1
    lines = [f"**Found {total} notices** for query: `{query}`\n"]
    if total_pages > 1:
        showing_start = (page - 1) * page_size + 1
        showing_end = min(page * page_size, total)
        lines.append(f"**Page {page}/{total_pages}** (showing {showing_start}–{showing_end} of {total})\n")

    if not results:
        lines.append("No results returned.")
        return "\n".join(lines)

    for r in results:
        lines.append(f"### [{r.publication_number}]({r.ted_url})")
        lines.append(f"- **Date:** {r.publication_date or 'N/A'}")
        lines.append(f"- **Type:** {r.notice_type or 'N/A'}")
        if r.contract_title:
            lines.append(f"- **Title:** {r.contract_title}")
        lines.append(f"- **Buyer:** {r.buyer_name or 'N/A'} ({r.buyer_country or 'N/A'})")
        if r.winners:
            winner_strs = [f"{w['name']} ({w['country']})" if w['country'] else w['name'] for w in r.winners]
            shown = ", ".join(winner_strs)
            if r.total_winners > len(r.winners):
                shown += f" ... (+{r.total_winners - len(r.winners)} more)"
            lines.append(f"- **Winner(s):** {shown}")
        else:
            lines.append("- **Winner(s):** N/A")
        lines.append(f"- **Value:** {r.contract_value}")
        if r.cpv_codes:
            lines.append(f"- **CPV:** {', '.join(r.cpv_codes[:5])}")
        lines.append("")

    if page < total_pages:
        remaining_pages = list(range(page + 1, total_pages + 1))
        lines.append(
            f"\n> **⚠ More results available ({total - min(page * page_size, total)} notices on {len(remaining_pages)} remaining page(s)).**\n"
            "> Spawn one parallel subagent per page below, each calling `search_notices_raw` with the same query:\n>"
        )
        for p in remaining_pages:
            lines.append(f'> - `search_notices_raw(expert_query="{query}", page={p}, page_size=50)`')

    return "\n".join(lines)


@mcp.tool()
async def get_notice(ctx: Context, publication_number: str) -> str:
    """Retrieve full details of a single TED procurement notice.

    Args:
        publication_number: TED publication number in format NNNNNN-YYYY. E.g. "6091-2024", "123456-2023"
    """
    ted: TEDClient = ctx.request_context.lifespan_context.ted_client

    # Fetch extra fields for detail view
    detail_fields = list(dict.fromkeys(AWARD_FIELDS + ["procedure-type"]))

    try:
        data = await ted.search(
            query=f'publication-number={publication_number}',
            fields=detail_fields,
            page=1,
            limit=1,
        )
    except TEDTimeoutError:
        return "Error: TED API timed out."
    except TEDBadRequestError as e:
        return f"Error: {e}"
    except TEDAPIError as e:
        return f"Error: {e}"

    notices = data.get("notices", [])
    if not notices:
        return f"No notice found with publication number `{publication_number}`.\n\nCheck the format is NNNNNN-YYYY (e.g. 6091-2024)."

    n = notices[0]
    pub_num = n.get("publication-number", publication_number)
    ted_url = f"https://ted.europa.eu/en/notice/-/detail/{pub_num}"

    lines = [f"## Notice {pub_num}", f"**URL:** {ted_url}\n"]

    lines.append(f"**Type:** {n.get('notice-type', 'N/A')}")
    lines.append(f"**Publication Date:** {n.get('publication-date', 'N/A')}")
    if n.get("procedure-type"):
        lines.append(f"**Procedure Type:** {n.get('procedure-type')}")

    # Contract title
    title = pick_best_language(n.get("contract-title"))
    if title:
        lines.append(f"**Contract Title:** {title}")

    lines.append("")
    lines.append("### Buyer")
    buyer_names = pick_all_languages(n.get("buyer-name"))
    if buyer_names:
        lines.append(f"**Name:** {' / '.join(buyer_names)}")
    buyer_country = n.get("buyer-country")
    if isinstance(buyer_country, list):
        buyer_country = buyer_country[0] if buyer_country else None
    if buyer_country:
        lines.append(f"**Country:** {buyer_country}")

    lines.append("")
    lines.append("### Contract Value")
    lines.append(format_value(n))

    # CPV
    cpv_raw = n.get("classification-cpv", [])
    if isinstance(cpv_raw, list) and cpv_raw:
        lines.append(f"\n**CPV Codes:** {', '.join(str(c) for c in cpv_raw)}")

    # Winners
    all_winners = zip_winners(n)
    decision_date = n.get("winner-decision-date")
    lines.append(f"\n### Winners ({len(all_winners)} total)")
    if decision_date:
        lines.append(f"**Award Decision Date:** {decision_date}")

    if all_winners:
        for i, w in enumerate(all_winners, 1):
            country_str = f" ({w['country']})" if w['country'] else ""
            lines.append(f"{i}. {w['name']}{country_str}")
    else:
        lines.append("No winner data available (may not be a contract award notice).")

    return "\n".join(lines)


@mcp.tool()
async def search_notices_raw(
    ctx: Context,
    expert_query: str,
    fields: list[str] | None = None,
    page: int = 1,
    page_size: int = 10,
    pagination_mode: str = "PAGE_NUMBER",
    iteration_token: str | None = None,
    place_of_performance: list[str] | None = None,
) -> str:
    """Search EU public procurement notices on TED (ted.europa.eu) via expert query.

    Build a TED expert query string and pass it as `expert_query`. Combine clauses
    with AND / OR / NOT and parentheses. Supports ITERATION pagination for large
    result sets (>15 000 notices).

    When the response contains a pagination warning, spawn one parallel subagent per
    remaining page using the exact tool calls shown in the warning. Do not fetch
    remaining pages sequentially — always parallelise.

    Common fields:
    - `buyer-country=DEU` — 3-letter ISO country code of the buying authority
      (DEU, FRA, GBR, ITA, ESP, POL, NLD, …).
    - `winner-name~"Deloitte"` — fuzzy match on winner; pair with
      `notice-type=can-standard` (winner data is reliable only for contract-award
      notices, mostly from 2021 onwards).
    - `notice-type=can-standard` — contract award; `cn-standard` is the call for
      tenders.
    - `PD>=20240101 AND PD<=20241231` — publication-date range (year filter).
    - `classification-cpv IN (72000000, 73000000)` — CPV codes (IT, R&D, …).
    - `FT~"SAP S4 transformation"` — full-text search.
    - `place-of-performance IN ("DE21")` — NUTS code; usually easier to set via
      the `place_of_performance` argument which accepts region names too.

    Example queries:
    - `notice-type=can-standard AND winner-name~"Deloitte" AND buyer-country=DEU AND PD>=20240101 AND PD<=20241231`
    - `notice-type=can-standard AND classification-cpv IN (72000000) AND buyer-country=FRA`
    - `FT~"SAP S4 transformation" AND notice-type=can-standard`

    Tips when you get zero results:
    - Use 3-letter ISO country codes (DEU not DE).
    - Try partial / shorter company names.
    - Winner data is most reliable for `can-standard` notices from 2021 onwards.

    Args:
        expert_query: TED expert query string
        fields: List of fields to return. Defaults to standard award fields.
        page: Page number for PAGE_NUMBER mode
        page_size: Results per page (1-100). Use 50 for subagent calls.
        pagination_mode: "PAGE_NUMBER" (default) or "ITERATION" (for >15000 results)
        iteration_token: Token from previous ITERATION response for next page
        place_of_performance: List of NUTS codes or region names filtering by place of performance.
            Any NUTS level works (country, region, subdivision); TED matches hierarchically.
            Uses substring matching, so "München" finds both "München, Kreisfreie Stadt" and
            "München, Landkreis". IMPORTANT: Labels are in the native language of the region
            (e.g. "Bayern" not "Bavaria", "Île-de-France" not "Paris Region").
            Use native-language names for best results.
            E.g. ["DE21"] (Oberbayern), ["FR10","ES30"], ["DE"] (all Germany), ["München"].
    """
    page_size = max(1, min(100, page_size))

    nuts_warning = ""
    if place_of_performance:
        resolved, unresolved = resolve_nuts_list(place_of_performance)
        if resolved:
            quoted = ", ".join(f'"{c}"' for c in resolved)
            nuts_clause = f"place-of-performance IN ({quoted})"
            expert_query = f"({expert_query}) AND {nuts_clause}" if expert_query.strip() else nuts_clause
        if unresolved:
            nuts_warning = (
                f"\n\n> **Note:** Could not resolve NUTS codes for: {', '.join(unresolved)}. "
                "Pass an explicit NUTS code (e.g. `DE21`) or a recognised region name."
            )
    ted: TEDClient = ctx.request_context.lifespan_context.ted_client

    try:
        data = await ted.search(
            query=expert_query,
            fields=fields,
            page=page,
            limit=page_size,
            pagination_mode=pagination_mode,
            iteration_token=iteration_token,
        )
    except TEDTimeoutError:
        return "Error: TED API timed out. Try narrowing your query."
    except TEDBadRequestError as e:
        return f"Error: {e}"
    except TEDAPIError as e:
        return f"Error: {e}"

    notices_raw = data.get("notices", [])
    total = data.get("totalNoticeCount", 0)
    timed_out = data.get("timedOut", False)
    next_token = data.get("iterationNextToken")

    results = [NoticeSearchResult.from_notice(n) for n in notices_raw]
    output = _format_notices_markdown(results, total, expert_query, page=page, page_size=page_size)

    if next_token:
        output += f"\n\n**Next page token (ITERATION):** `{next_token}`\n(Pass as `iteration_token` in next call)"

    if timed_out:
        output += "\n\n> **Warning:** TED API query timed out — results may be incomplete."

    if nuts_warning:
        output += nuts_warning

    return output


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

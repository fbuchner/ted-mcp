# ted-mcp

MCP server for [TED (ted.europa.eu)](https://ted.europa.eu) — the EU public procurement database. Exposes TED notice search to LLMs via the [Model Context Protocol](https://modelcontextprotocol.io).

No API key required. Uses the public TED search API.

> [!TIP]
> Point your favorite AI companion here (e.g. Claude) and ask it to help set this MCP server up for you.

## Installation

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if you don't have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

No further setup needed — `uv run` handles the virtual environment automatically.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ted-procurement": {
      "command": "/Users/your-username/.local/bin/uv",
      "args": ["run", "--directory", "/path/to/ted-mcp", "ted-mcp"]
    }
  }
}
```

Use the full path to `uv` (find it with `which uv`) rather than just `"uv"`, since MCP clients run with a limited PATH that may not include `~/.local/bin`.

## Tools

### `search_notices_raw`

Search TED notices using a TED expert query string. The model assembles the
query from natural-language requests.

| Parameter | Type | Description |
|-----------|------|-------------|
| `expert_query` | string | TED expert query string (see syntax below) |
| `place_of_performance` | string[] | NUTS codes or region names (e.g. `["Bayern"]`, `["DE21","FR10"]`). Resolved via a bundled NUTS lookup with fuzzy matching, then ANDed onto `expert_query` as a `place-of-performance IN (...)` clause |
| `fields` | string[] | Fields to return (defaults to standard award fields) |
| `page` / `page_size` | int | Pagination; max 100 per page |
| `pagination_mode` | string | `PAGE_NUMBER` (default) or `ITERATION` (>15 000 results) |
| `iteration_token` | string | Continuation token for ITERATION mode |

**Expert query syntax:**

```
buyer-country=DEU
winner-name~"Deloitte"
PD>=20240101 AND PD<=20241231
classification-cpv IN (72000000)
FT~"SAP S4 transformation"
notice-type=can-standard
place-of-performance IN ("DE21")
```

**Example natural-language queries:**
- "Which contracts did Deloitte win in Germany in 2024?"
- "Which government bodies procured SAP S4 transformations?"
- "What are prominent IT services contracts in France in 2023?"
- "Show me public IT contracts performed in Bavaria last year."

You can query in your local language as well (e.g. in German "Welche Ausschreibungen für Softwareentwicklung laufen gerade?").

### `get_notice`

Returns full detail for a single notice by publication number.

| Parameter | Type | Description |
|-----------|------|-------------|
| `publication_number` | string | Format `NNNNNN-YYYY` (e.g. `"6091-2024"`) |

## Reference

**Common CPV codes**

| Code | Category |
|------|----------|
| 72000000 | IT services |
| 48000000 | Software |
| 71000000 | Architecture & engineering |
| 79000000 | Business services |
| 45000000 | Construction |

**Country codes (ISO 3166-1 alpha-3)**

`DEU` Germany · `FRA` France · `GBR` United Kingdom · `ITA` Italy · `ESP` Spain · `POL` Poland · `NLD` Netherlands · `BEL` Belgium · `SWE` Sweden · `AUT` Austria · `PRT` Portugal · `ROU` Romania

## Limitations

- Winner data is only reliably present on `can-standard` notices (contract award notices), and coverage varies by member state prior to 2021.
- Multi-lot contracts can have many winners; summary view truncates at 10.
- Most notices are not in English — the server falls back to the best available language.
- `PAGE_NUMBER` pagination is capped at 15,000 results; use `ITERATION` mode for bulk access.
- Framework agreements frequently report value as `0.00` (not disclosed).

# Notes
The code in this repository is mostly AI generated. Treat it as such.

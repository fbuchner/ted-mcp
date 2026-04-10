from __future__ import annotations
import httpx
from typing import Any
import csv
import io
import unicodedata

TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search"

AWARD_FIELDS = [
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
]


class TEDClient:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def search(
        self,
        query: str,
        fields: list[str] | None = None,
        page: int = 1,
        limit: int = 10,
        pagination_mode: str = "PAGE_NUMBER",
        iteration_token: str | None = None,
    ) -> dict[str, Any]:
        """Search TED notices. Returns raw API response dict."""
        body: dict[str, Any] = {
            "query": query,
            "fields": fields or AWARD_FIELDS,
            "page": page,
            "limit": limit,
            "paginationMode": pagination_mode,
        }
        if iteration_token:
            body["iterationNextToken"] = iteration_token

        try:
            response = await self._client.post(
                TED_SEARCH_URL,
                json=body,
                timeout=30.0,
            )
        except httpx.TimeoutException:
            raise TEDTimeoutError("TED API timed out. Try narrowing your query.")
        except httpx.RequestError as e:
            raise TEDConnectionError(f"Failed to connect to TED API: {e}")

        if response.status_code == 400:
            try:
                data = response.json()
                msg = data.get("message") or data.get("error") or response.text
            except Exception:
                msg = response.text
            raise TEDBadRequestError(f"TED API bad request: {msg}")

        if response.status_code != 200:
            raise TEDAPIError(f"TED API returned HTTP {response.status_code}: {response.text[:200]}")

        return response.json()


class TEDAPIError(Exception):
    pass

class TEDTimeoutError(TEDAPIError):
    pass

class TEDConnectionError(TEDAPIError):
    pass

class TEDBadRequestError(TEDAPIError):
    pass

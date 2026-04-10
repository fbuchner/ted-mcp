"""NUTS (Nomenclature of Territorial Units for Statistics) code lookup.

Loads codes from data/nuts_codes.csv and supports case-insensitive substring
matching so that e.g. "München" finds "München, Kreisfreie Stadt" (DE212).

Source: Eurostat NUTS 2021 classification.
"""

from __future__ import annotations

import csv
import unicodedata
from pathlib import Path

# Path to the shared CSV data file
_CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "nuts_codes.csv"

# code -> label, and normalized_label -> code mappings, built once at import time.
_CODES: dict[str, str] = {}          # e.g. "DE212" -> "München, Kreisfreie Stadt"
_NORM_INDEX: dict[str, str] = {}     # e.g. "munchen, kreisfreie stadt" -> "DE212"


def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def _load_csv() -> None:
    if _CODES:
        return
    with open(_CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            code = row["code"].strip()
            label = row["label"].strip()
            _CODES[code.upper()] = label
            _NORM_INDEX[_normalize(label)] = code.upper()


_load_csv()

# Country name aliases (not in the Eurostat CSV)
_COUNTRY_ALIASES: dict[str, str] = {
    "austria": "AT", "belgium": "BE", "bulgaria": "BG", "croatia": "HR",
    "cyprus": "CY", "czechia": "CZ", "czech republic": "CZ", "denmark": "DK",
    "estonia": "EE", "finland": "FI", "france": "FR", "germany": "DE",
    "greece": "EL", "hellas": "EL", "hungary": "HU", "ireland": "IE",
    "italy": "IT", "latvia": "LV", "lithuania": "LT", "luxembourg": "LU",
    "malta": "MT", "netherlands": "NL", "poland": "PL", "portugal": "PT",
    "romania": "RO", "slovakia": "SK", "slovenia": "SI", "spain": "ES",
    "sweden": "SE", "iceland": "IS", "liechtenstein": "LI", "norway": "NO",
    "switzerland": "CH", "united kingdom": "UK", "uk": "UK",
}


def resolve_nuts(value: str) -> list[str]:
    """Resolve a region name or NUTS code to matching NUTS codes.

    - Already-valid-looking codes pass through uppercased.
    - Country names resolve to the NUTS-0 code.
    - Other names use case-insensitive substring matching on CSV labels,
      so "München" matches "München, Kreisfreie Stadt" and "München, Landkreis".

    Returns a list of matching NUTS codes (may be multiple for substring matches).
    """
    if not value:
        return []
    v = value.strip()

    # Pass through anything that looks like a NUTS code (2 letters + digits/alphanum)
    # but only if it actually exists in our data or is a known country code
    upper = v.upper()
    if 2 <= len(v) <= 5 and v[:2].isalpha() and (len(v) == 2 or v[2:].isalnum()):
        if upper in _CODES or upper in _COUNTRY_ALIASES.values():
            return [upper]

    key = _normalize(v)

    # Check country aliases
    if key in _COUNTRY_ALIASES:
        return [_COUNTRY_ALIASES[key]]

    # Exact match on normalized label
    if key in _NORM_INDEX:
        return [_NORM_INDEX[key]]

    # Substring match: find all labels containing the search term
    matches = [
        code for norm_label, code in _NORM_INDEX.items()
        if key in norm_label
    ]
    return matches


def resolve_nuts_list(
    values: list[str],
) -> tuple[list[str], list[str]]:
    """Resolve a list of names/codes. Returns (resolved_codes, unresolved_inputs)."""
    resolved: list[str] = []
    unresolved: list[str] = []
    for v in values:
        codes = resolve_nuts(v)
        if codes:
            resolved.extend(codes)
        else:
            unresolved.append(v)
    return resolved, unresolved

"""Helpers shared by the adapters."""

from __future__ import annotations

import json
import re
from typing import Any

_NUM = re.compile(r"[\d,]+(?:\.\d+)?")


def to_price(raw: object) -> float | None:
    """Anything -> a positive number, or None.

    Rejects zero and negatives rather than passing them through: no listing genuinely sells
    for nothing, so a 0 here means the parse found the wrong node. Better to report `error`
    than to paint a 0 on the wall as if it were a price.
    """
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        value = float(raw)
    else:
        m = _NUM.search(str(raw).replace("₹", " "))
        if not m:
            return None
        try:
            value = float(m.group(0).replace(",", ""))
        except ValueError:
            return None
    return value if value > 0 else None


def find_json_objects(html: str, key: str) -> list[dict[str, Any]]:
    """Every well-formed JSON object in `html` that contains `"key"` at its top level.

    These sites embed application state in <script> tags in shapes that change without notice,
    so rather than depending on one path, we scan for objects carrying a marker key and let the
    caller pick. Brace-matching (rather than regex) is what makes nested objects survive.
    """
    needle = f'"{key}"'
    out: list[dict[str, Any]] = []
    pos = 0

    while (idx := html.find(needle, pos)) != -1:
        pos = idx + len(needle)
        # Walk backwards to the opening brace of the object holding this key.
        start = html.rfind("{", 0, idx)
        while start > 0:
            candidate = _match_object(html, start)
            if candidate is not None:
                end, blob = candidate
                if end > idx:
                    try:
                        parsed = json.loads(blob)
                    except ValueError:
                        pass
                    else:
                        if isinstance(parsed, dict) and key in parsed:
                            out.append(parsed)
                            pos = end
                            break
            start = html.rfind("{", 0, start)
        if len(out) >= 40:  # plenty for picking; these pages embed thousands of objects
            break

    return out


def _match_object(html: str, start: int) -> tuple[int, str] | None:
    """Return (end_index, text) for the JSON object starting at `start`, if it is balanced."""
    depth = 0
    in_string = False
    escaped = False

    for i in range(start, min(len(html), start + 200_000)):
        ch = html[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1, html[start : i + 1]
    return None


def json_ld_products(html: str) -> list[dict[str, Any]]:
    """schema.org Product objects from <script type="application/ld+json"> blocks.

    Blinkit publishes these, which is why its adapter is the only one not parsing markup.
    Handles both a bare Product and an @graph array.
    """
    out: list[dict[str, Any]] = []
    for blob in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.S | re.I,
    ):
        try:
            data = json.loads(blob.strip())
        except ValueError:
            continue
        for node in _iter_nodes(data):
            if isinstance(node, dict) and node.get("@type") == "Product":
                out.append(node)
    return out


def _iter_nodes(data: Any) -> list[Any]:
    if isinstance(data, list):
        return [n for item in data for n in _iter_nodes(item)]
    if isinstance(data, dict):
        nodes = [data]
        if "@graph" in data:
            nodes += _iter_nodes(data["@graph"])
        return nodes
    return []

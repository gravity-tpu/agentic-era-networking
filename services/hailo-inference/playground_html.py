"""
playground_html.py
==================
Standalone HTML loader for Hailo-8 edge neural inference playground.
Served when accessing GET /infer or GET /playground from a browser.

Council Invariants:
- Zero external CDN dependencies (works fully offline/air-gapped).
- Fail-closed error handling with explicit status messages (INV-3).
- Loaded once into memory at module import (Ghemawat radical simplicity & zero request-path I/O).
"""

from pathlib import Path

_PLAYGROUND_TEMPLATE_PATH = Path(__file__).parent / "playground.html"

if not _PLAYGROUND_TEMPLATE_PATH.is_file():
    raise RuntimeError(
        f"Fail-closed invariant violation: playground template missing at {_PLAYGROUND_TEMPLATE_PATH}"
    )

INTERACTIVE_PLAYGROUND_HTML: str = _PLAYGROUND_TEMPLATE_PATH.read_text(encoding="utf-8")

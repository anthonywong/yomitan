# OCR evaluation fixtures

This directory is the versioned, dependency-free foundation for local OCR evaluation. It deliberately contains only hand-authored SVG fixtures whose source and licensing are clear.

`manifest.json` is validated against `schema.json`. Each ready fixture records its SHA-256, dimensions, CC0-1.0 license, provenance, expected text polygons, writing direction, lookup targets, and character hit points. Line `order` defines reading order. Character hit-point `index` is the zero-based Unicode code-point index in the NFC-normalized line text. The integrity test verifies those claims and rejects remote references.

The initial corpus covers horizontal `画像`, vertical `画像`, isolated `込`, mixed `画像 OCR 2026`, and a no-text image. It is not an OCR performance benchmark and does not contain model assets or benchmark scores.

Natural-photo and manga/game cases are intentionally marked `pending` in the manifest. They require redistributable source material, ground-truth polygons, and a reviewed provenance record before becoming runnable fixtures. Do not add downloaded examples, browser-captured images, or model output to this directory without that review.

`frameCase` is null for this image-only foundation. Future DOM fixtures use it to declare whether a test belongs to the top frame, same-origin iframe, or cross-origin iframe, and whether coordinates are frame- or top-viewport-relative.

Coordinate-hit scoring is intentionally stricter than text containment: an OCR adapter supplies a polygon for each recognized NFC code point, either natively or through its documented deterministic line subdivision. A hit requires the expected character, its exact code-point index, and its annotated point to agree.

The future runtime benchmark owns model acquisition separately. It must use a pinned asset manifest, checksum verification, explicit extension-local paths, and an offline test; this fixture set must never acquire an OCR model or contact a service.

# Tasks — Tab View

Status legend: `DONE` (shipped in v3.0.0), `OPEN` (not yet implemented), `[P]` (parallelisable).

## US-1 — Switch to Tab View
- [DONE] Visualization-type plugin registers via `slopsmithViz_tabview`.
- [DONE] Tab View / Highway toggle in `#player-controls` (handled by core's renderer registry).

## US-2 — Cursor sync
- [DONE] alphaTab loaded from pinned CDN (`1.8.2`).
- [DONE] `_tvTimeToTick` maps `audio.currentTime` → MIDI ticks via beats.
- [DONE] RAF loop drives `cursor.tickPosition`.

## US-3 — Techniques preservation
- [DONE] Bends.
- [DONE] Slides (legato + shift).
- [DONE] Hammer-ons / pull-offs.
- [DONE] Natural / pinch / tap harmonics.
- [DONE] Palm mutes.
- [DONE] Tremolo picking.
- [DONE] Custom tunings + capo.
- [DONE] Per-measure tempo changes.
- [OPEN] [P] Vibrato variants (wide / shallow distinction).

## US-4 — Splitscreen multi-instance
- [DONE] `createFactory()` per-instance state.
- [DONE] Per-instance DOM tagging via `_nextInstanceId`.
- [DONE] `panelChromeFor()` resolution; fallback to `#player`.
- [DONE] CDN script load memoized.

## US-5 — Sloppak support
- [DONE] Lazy `import sloppak`; 501 when missing.
- [DONE] Use `get_sloppak_cache_dir()` from context with tempfile fallback.

## US-6 — PSARC support
- [DONE] `unpack_psarc → load_song`.
- [DONE] Temp dir cleanup in `finally`.

## US-7 — Path-traversal guard
- [DONE] Resolve filename, reject if not under DLC dir.

## US-8 — Arrangement param
- [DONE] `?arrangement=N` query, clamped to valid index.
- [OPEN] [P] Surface arrangement dropdown for direct selection inside Tab View (today the user picks it from the player UI before switching).

## Cross-cutting
- [DONE] Idempotent `playSong` wrap.
- [DONE] `arrangement:changed` listener updates `_tvFilename`.
- [DONE] Error banner per instance on script load / fetch failure.
- [OPEN] [P] Server-side cache for unpacked PSARC + GP5 (Q6).
- [OPEN] Self-hosted alphaTab fallback (constitution §III).
- [OPEN] Regression test corpus for `rs2gp.py` against representative CDLC.

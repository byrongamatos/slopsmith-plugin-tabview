# Plan — Tab View (as built)

## File map

| File          | Lines | Purpose                                                                   |
|---------------|-------|---------------------------------------------------------------------------|
| `plugin.json` | 9     | Manifest. `id: tabview`, `type: visualization`, version `3.0.0`, declares `screen.js`/`routes.py`. |
| `routes.py`   | 105   | One endpoint: `GET /api/plugins/tabview/gp5/{filename}` with PSARC + sloppak branches and path-traversal guard. |
| `rs2gp.py`    | 405   | Rocksmith arrangement → Guitar Pro 5 conversion using `pyguitarpro`. Preserves bends, slides, hammers, harmonics, palm mutes, tremolo, custom tunings, capo, per-measure tempo. |
| `screen.js`   | 809   | alphaTab loader, factory contract, cursor sync, splitscreen mount resolution, multi-instance state. |

## Architecture

```
   user clicks Tab View                       core renderer registry
            │                                          │
            ▼                                          ▼
   highway hides    ──►  slopsmithViz_tabview = createFactory  ──► factory()
                                                                       │
                                                                       ▼
   factory closes over per-instance state (alphaTab API, container, beats, etc.)
                                                                       │
              ┌────────────────────────────────────────────────────────┘
              ▼
   resolve mount (splitscreen panelChromeFor or #player)
              │
              ▼
   load alphaTab from CDN (memoized once per page)
              │
              ▼
   fetch /api/plugins/tabview/gp5/<filename>?arrangement=N
              │                       │
              │                       ├─►  unpack_psarc → load_song → rocksmith_to_gp5
              │                       └─►  sloppak.load_song → rocksmith_to_gp5  (lazy import)
              │
              ▼
   alphaTab.api.load(gp5Bytes); subscribe to renderFinished
              │
              ▼
   on RAF: cursor.tickPosition = _tvTimeToTick(audio.currentTime, beats)
```

## Endpoint

```python
@app.get("/api/plugins/tabview/gp5/{filename:path}")
def tabview_gp5(filename: str, arrangement: int = 0):
    # 1. resolve under DLC dir (path-traversal guard)
    # 2. is_sloppak ? sloppak.load_song : unpack_psarc + load_song
    # 3. rs2gp.rocksmith_to_gp5(song, arrangement_index)
    # 4. Response(content=gp5_bytes, media_type="application/octet-stream")
```

## Multi-instance contract (slopsmith#36)

- `createFactory()` returns a factory function the core calls per panel.
- Each factory invocation:
  - Increments `_nextInstanceId` for unique DOM ids.
  - Creates its own AlphaTabApi.
  - Subscribes to its own `scoreLoaded` / `renderFinished` / `error`.
  - Owns its own RAF loop for cursor sync.
- Module state is reserved for:
  - `_alphaTabLoadPromise` — one CDN fetch per page.
  - `_tvFilename` — one global player.
  - `_nextInstanceId` — monotonic counter.

## Cursor sync helper

```js
function _tvTimeToTick(seconds, beats) {
    // beats[]: array of {time: sec, ticks: int} from bundle.songInfo
    // binary search → linear interp between adjacent beats
}
```

## Risks / drift watchpoints

- **alphaTab CDN** — if jsDelivr is unreachable, Tab View can't render.
  Add a self-hosted fallback later if uptime becomes a concern.
- **`rs2gp.py`** — large surface (405 lines). Per-feature mappings
  (bends, harmonics, slides) are a long tail of edge cases. Treat
  regression tests on a corpus of CDLC as a future priority.
- **`pyguitarpro` upstream** — the GP5 writer's API is small but renames
  would propagate.
- **PSARC re-unpack** (Q6) — no caching today.
- **Path-traversal guard** — single security boundary; resist temptation
  to "simplify" the resolve / contains check.

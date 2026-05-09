# Analyze — Tab View

## Coverage

| Area              | Spec | Plan | Code        | Notes                                         |
|-------------------|------|------|-------------|-----------------------------------------------|
| GP5 endpoint      | ✅   | ✅   | `routes.py` | PSARC + sloppak; path-traversal guard         |
| RS → GP5          | ✅   | ✅   | `rs2gp.py`  | Techniques preserved                          |
| Frontend factory  | ✅   | ✅   | `screen.js` | Multi-instance via factory closures           |
| Splitscreen       | ✅   | ✅   | `screen.js` | `panelChromeFor()` integration                |
| Cursor sync       | ✅   | ✅   | `screen.js` | `_tvTimeToTick`                               |
| CDN pin           | ✅   | ✅   | `screen.js` | `ALPHATAB_VERSION = '1.8.2'`                  |
| Tests             | ❌   | ❌   | —           | None automated; visual regression only        |

## Drift

- README claims techniques preserved (bends, slides, hammers, harmonics,
  palm mutes, tremolo, custom tunings, capo, per-measure tempo) — matches
  `rs2gp.py` capability set.
- README "loads alphaTab from CDN on first use" matches `_tvLoadScript`.
- README does not mention the multi-instance refactor (Wave C / slopsmith#36)
  but the change is internal — user-facing UX is unchanged.
- README does not surface the path-traversal guard or 501 sloppak fallback;
  internal contract details, safe to omit.

## Gaps

1. **No PSARC/GP5 cache** (Q6). Repeat fetches re-unpack and re-convert.
   Cost is bounded but real on slow disks.
2. **No regression suite for `rs2gp.py`**. The 405-line converter has many
   per-feature paths; CDLC corpus regressions would catch breakage.
3. **CDN single-source**. If jsDelivr is unreachable, Tab View won't render.
4. **No arrangement picker inside Tab View**. Users must change arrangement
   from the player before opening Tab View.
5. **No notation-mode toggle**. alphaTab supports staff notation; Tab View
   only renders TAB.
6. **Cursor sync is RAF-driven**, not driven by alphaTab's own scheduling
   — fine for steady playback, may glitch under heavy GC pauses.

## Recommendations

- **TTL cache** keyed on `(filename, mtime, arrangement)` storing the
  GP5 bytes. Even a 60 s TTL eliminates repeat work in normal use.
- **Self-host alphaTab** (or vendor it under `static/`) so installs without
  internet still get Tab View. Fall through to CDN as the fast path.
- **Regression corpus**: pick 10 representative CDLC, render each via
  `rs2gp.rocksmith_to_gp5`, snapshot the GP5 byte-equivalence (or alphaTab
  textual dump). Run on PRs touching `rs2gp.py`.
- **In-Tab-View arrangement picker** as a small dropdown in the alphaTab
  toolbar.
- **Optional notation toggle** for users who prefer staff notation.
- **Cursor sync hardening**: if RAF skips (`now - last > 100 ms`), do a
  bigger seek to catch up rather than pretend nothing happened.

# Spec — Tab View (`tabview`)

> Retrospective spec for shipped v3.0.0. Implementation in `routes.py` (105
> lines), `rs2gp.py` (405 lines), and `screen.js` (809 lines) is the source
> of truth.

## Summary

A Slopsmith **visualization** plugin (`type: "visualization"`) that converts
Rocksmith CDLC arrangements to Guitar Pro 5 on the fly and renders them as
scrolling tablature via [alphaTab](https://www.alphatab.net/). Replaces (or
runs alongside, in splitscreen) the standard note highway. The cursor stays
in sync with `audio.currentTime` using the same beat data the highway
exposes.

## User stories

### US-1 — Switch from highway to tab view
- **Given** a song is loaded in the player,
  **When** I click the **Tab View** button injected into `#player-controls`,
  **Then** the highway canvas is replaced with the alphaTab tablature
  rendering. Clicking **Highway** switches back.

### US-2 — Tab follows the audio cursor
- **Given** I'm in tab view and the song is playing,
  **When** `audio.currentTime` advances,
  **Then** alphaTab's cursor (`tickPosition`) tracks within one beat using
  the `_tvTimeToTick(seconds, beats)` helper that maps seconds → MIDI ticks
  via the song's beat timing data.

### US-3 — All techniques preserved
The GP5 emitted by `rs2gp.py` preserves: bends, slides, hammer-ons,
pull-offs, harmonics, palm mutes, tremolo picking, ghost notes, custom
tunings, capo, and per-measure tempo changes. Anything alphaTab can render
on a GP5 file works.

### US-4 — Splitscreen multi-instance
- **Given** the splitscreen plugin is installed and the user has two panels
  visible,
  **When** Tab View is the renderer in panel A and the highway is the
  renderer in panel B,
  **Then** Tab View mounts into panel A's chrome (via
  `splitscreen.panelChromeFor(highwayCanvas)`) and renders independently.
  Multiple Tab View instances can also coexist; each has its own AlphaTabApi
  + DOM ids tagged with `_nextInstanceId`.

### US-5 — Sloppak support
- **Given** the song is a `.sloppak`,
  **When** the GP5 endpoint runs,
  **Then** it loads via `sloppak.load_song()` (lazy import). If the core
  ships without `lib/sloppak.py`, the endpoint returns
  `501 "Sloppak support requires a newer Slopsmith core"`.

### US-6 — PSARC support
- **Given** the song is a `.psarc`,
  **When** the GP5 endpoint runs,
  **Then** the file is unpacked (`unpack_psarc`) into a temp dir, parsed
  via `song.load_song(tmp)`, converted via `rs2gp.rocksmith_to_gp5`, and
  the temp dir is cleaned up in a `finally`.

### US-7 — Path traversal rejection
- **Given** a malicious filename like `../../etc/passwd`,
  **When** the request hits `/api/plugins/tabview/gp5/...`,
  **Then** the resolved path is checked against the DLC dir and a 400 is
  returned if escape is detected.

### US-8 — Arrangement selection
- The endpoint accepts `?arrangement=N` (default 0). N is clamped to a
  valid index. The default is the first arrangement; users implicitly pick
  others by selecting an arrangement in the player UI before opening Tab
  View.

## Functional requirements

| ID    | Requirement                                                                                       | Source        |
|-------|---------------------------------------------------------------------------------------------------|---------------|
| FR-1  | Manifest: `type: visualization`, version `3.0.0`, declares `screen.js` + `routes.py` only.        | `plugin.json` |
| FR-2  | Expose `window.slopsmithViz_tabview = createFactory` so the core renderer registry can pick it up. | `screen.js`   |
| FR-3  | `GET /api/plugins/tabview/gp5/{filename:path}?arrangement=N` returns the GP5 file as `application/octet-stream`. | `routes.py`   |
| FR-4  | Reject paths that resolve outside the DLC dir.                                                    | `routes.py`   |
| FR-5  | Lazy-import `sloppak`; surface a 501 when missing.                                                | `routes.py`   |
| FR-6  | Unpack PSARC into a temp dir; clean up via `finally`.                                             | `routes.py`   |
| FR-7  | Cap alphaTab CDN version to `1.8.2`; one `<script>` load per page.                                | `screen.js`   |
| FR-8  | Multi-instance by factory closures; module state restricted to genuine singletons.                 | `screen.js`   |
| FR-9  | Support sloppak song-cache dir via `context.get("get_sloppak_cache_dir")`; fallback to `tempfile.gettempdir()/sloppak_cache`. | `routes.py`   |
| FR-10 | Drive cursor via `_tvTimeToTick(seconds, beats)` reading beat timing data from `bundle.songInfo`.  | `screen.js`   |
| FR-11 | Wrap `window.playSong` once and capture `_tvFilename`; also listen for `arrangement:changed`.      | `screen.js`   |
| FR-12 | No `matchesArrangement` static export — Tab View is opt-in only.                                   | `screen.js`   |

## Non-functional

- **First-render latency**: dominated by the GP5 conversion + alphaTab
  layout. Typically <2 s for 3-minute songs.
- **CDN dependency**: alphaTab is fetched from jsDelivr at first use.
  Offline installs see a script-load error and a clear "alphaTab failed to
  load" banner.

## Out of scope

- Editing the tablature in-browser (read-only).
- Exporting the GP5 as a download to the user (the endpoint is consumed
  internally by alphaTab; serving as a download is a one-line change but
  not a user-facing feature).
- Standard notation (alphaTab supports it, but Tab View renders TAB
  staffs only by default).

## Open clarifications

- [NEEDS CLARIFICATION] Should the GP5 endpoint be cached server-side?
  Today every request re-unpacks the PSARC and re-runs the converter.
- [NEEDS CLARIFICATION] How does Tab View interact with custom tunings the
  alphaTab font cannot render with TAB staffs (e.g. drop tunings in
  symmetrical 7-string)?
- [NEEDS CLARIFICATION] Behaviour when the song has zero arrangements (404
  today — fine, but worth confirming UX).
- [NEEDS CLARIFICATION] Is the alphaTab `1.8.2` pin still current? Bumps
  require regression testing of cursor sync + technique rendering.

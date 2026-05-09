# Clarifications — Tab View

## Q1 — Why convert to GP5 instead of teaching alphaTab to read RS XML?
**Resolved.** GP5 is alphaTab's most mature input format. RS XML uses
distinct semantics (chord templates, BPM events, tuning offsets) that don't
line up with GP5 1:1. The conversion in `rs2gp.py` does the per-feature
mapping once, server-side, in a place we control. Maintaining a fork of
alphaTab with an RS XML parser would be far more work.

## Q2 — Why pin the alphaTab version?
**Resolved.** jsDelivr caches at version granularity. Without a pin,
arbitrary upstream patches could land between page loads and break cursor
sync silently. Constitution §III. Bump procedure: bump the constant, run a
regression on cursor + techniques, update this clarify on success.

## Q3 — Why module-level `_tvFilename` but per-instance everything else?
**Resolved.** Slopsmith plays exactly one song globally. Even when
splitscreen splits the highway into multiple panels, those panels render
different arrangements OF THE SAME SONG. So the filename is genuinely a
singleton; arrangement index travels in `bundle.songInfo.arrangement_index`.
The `playSong` wrap is the canonical capture point; it's idempotent.

## Q4 — Why is the sloppak import lazy?
**Resolved.** Older Slopsmith cores don't ship `lib/sloppak.py`. A
top-level `import sloppak` would `ImportError` at plugin load and prevent
PSARC songs from rendering too. The lazy path lets PSARC users keep their
Tab View even on old cores; sloppak users on old cores get a clear 501.

## Q5 — Why no `matchesArrangement` static method?
**Resolved.** Tab View is "opt-in by user click", not "auto-select for type
X". Without `matchesArrangement`, Slopsmith's Auto-renderer picker won't
ever choose Tab View; users explicitly switch. A future variant could add
`matchesArrangement = arr => arr.type === 'guitar'` if we want to support
"always use tabs for guitar arrangements".

## Q6 — Why no PSARC unpacking cache?
**Open.** Every GP5 request re-unpacks the PSARC. A short-lived TTL cache
keyed by `(filename, mtime, arrangement)` would avoid 1–2 s of work on
repeat fetches. Today the alphaTab client only fetches once per session
per arrangement, so the cost is bounded.

## Q7 — Why is the endpoint mounted publicly?
**Resolved.** Slopsmith currently ships without auth. The path-traversal
guard is the security boundary. If/when auth is added to the core, the
endpoint inherits it.

## Q8 — How does the cursor stay in sync at speed slider != 1×?
**Resolved.** alphaTab's cursor is driven by us, not by alphaTab's own
playback engine. We pass `audio.currentTime` (which the speed slider
already affects) to `_tvTimeToTick`, so cursor and audio share the same
clock by construction.

## Q9 — Splitscreen: how does Tab View pick its mount?
**Resolved.** Calls `slopsmithSplitscreen.panelChromeFor(highwayCanvas)` if
splitscreen is active. Otherwise mounts into `#player`. The factory closes
over `mount`, so each instance renders inside the right DOM subtree.

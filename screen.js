// Tab View visualization plugin — renders Rocksmith arrangements as
// scrolling tablature via alphaTab (https://alphatab.net/).
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption (one alphaTab API, one container, one
// cursor highlight, one set of fetch sentinels). Wave C lifts that:
// every piece of per-render state moves into createFactory closures
// so N tabview instances coexist under splitscreen panels.
//
// Module-scope retained for genuine singletons:
//   - alphaTab CDN script load (one <script> tag per tab)
//   - _tvFilename — captured from window.playSong + arrangement:changed,
//     applies to the single global player so all instances share it
//
// Tabview has no MIDI input and no focus-driven behavior — every
// panel renders independently from its own bundle.currentTime, and
// the splitscreen helper is consulted only for the mount target via
// panelChromeFor(). Absence of window.slopsmithSplitscreen OR
// isActive()===false means "main-player, mount into #player."
//
// alphaTab multi-instance: alphaTab loads its font + soundfont as
// CDN-cached static resources, so N AlphaTabApi instances on the
// same page share the underlying assets without coordination. Each
// instance owns its own AlphaTabApi + its own scoreLoaded /
// renderFinished / error subscriptions.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module-level state (singletons)
// ═══════════════════════════════════════════════════════════════════════

// Captured from playSong wrap + arrangement:changed. All tabview
// instances see the same filename because slopsmith plays one song
// per tab — splitscreen panels render different arrangements OF THE
// SAME song, not different songs. Per-instance arrangement index
// arrives via bundle.songInfo.arrangement_index.
let _tvFilename = null;

// Monotonic id for per-instance DOM tagging (containers, alphaTab
// mount divs, highlight overlays, error banners — every node a
// tabview instance creates is suffixed with this so N instances
// don't collide on getElementById.
let _nextInstanceId = 0;

// ═══════════════════════════════════════════════════════════════════════
// alphaTab CDN loader (memoized — one load per page)
// ═══════════════════════════════════════════════════════════════════════

// Pin alphaTab to a specific release so new jsDelivr cache invalidations
// or upstream breaking changes can't land silently in production. Bump
// this when the alphaTab CDN publishes a version tested against the
// cursor-sync / tab-highlight behavior below.
const ALPHATAB_VERSION = '1.8.2';
const ALPHATAB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@' + ALPHATAB_VERSION + '/dist';

let _alphaTabLoadPromise = null;
function _tvLoadScript() {
    if (window.alphaTab) return Promise.resolve();
    if (_alphaTabLoadPromise) return _alphaTabLoadPromise;
    _alphaTabLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ALPHATAB_CDN_BASE + '/alphaTab.min.js';
        s.onload = resolve;
        s.onerror = () => {
            _alphaTabLoadPromise = null;  // allow retry on next init
            reject(new Error('Failed to load alphaTab'));
        };
        document.head.appendChild(s);
    });
    return _alphaTabLoadPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// Filename tracking (module-level — one global player)
// ═══════════════════════════════════════════════════════════════════════
//
// slopsmith core doesn't expose the current song's filename via a
// getter (song_info carries metadata, not the WS URL). Capture it
// ourselves by wrapping window.playSong once at module load and
// subscribing to arrangement:changed. init() consumes the cached
// _tvFilename when bundle.songInfo.filename isn't populated.

(function () {
    // Idempotency: if screen.js is re-evaluated (loader cache miss, hot reload,
    // older core builds without the load-side guard), don't re-wrap playSong
    // and don't re-subscribe to arrangement:changed — re-wrap grows the
    // wrapper chain, and a duplicate listener would update _tvFilename twice
    // per event.
    const HOOK_KEY = '__slopsmithTabviewHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    const origPlay = typeof window.playSong === 'function' ? window.playSong : null;
    if (origPlay) {
        window.playSong = async function (filename, arrangement) {
            _tvFilename = filename;
            return origPlay.call(this, filename, arrangement);
        };
    }

    if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('arrangement:changed', (e) => {
            // detail = { index, filename }
            if (e && e.detail && e.detail.filename) _tvFilename = e.detail.filename;
        });
    }
})();

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrapper
// ═══════════════════════════════════════════════════════════════════════
//
// Tabview only needs panelChromeFor() — there's no MIDI routing or
// focus-driven behavior. Validate ONLY that surface so a partial
// helper that lacks the focus-related methods (which tabview doesn't
// consume) still routes through the splitscreen mount target.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return ss.panelChromeFor(highwayCanvas);
}

// Resolve the DOM mount target for tabview's container / error banner.
// Splitscreen-active: ONLY the panel chrome is acceptable; if
// panelChromeFor returns null mid-creation or during a screen
// transition, return null so callers treat the mount as unavailable
// (the container won't be cached, and a later draw() / resize() /
// banner attempt retries cleanly once the panel chrome resolves).
// Falling through to #player here would (a) cache _tvContainer
// against the main player surface for the rest of the instance's
// lifetime, rendering this panel's tabs over the wrong area, and
// (b) confuse _tvSizeContainer's splitscreen vs main-player branch
// since _ssActive() would still be true on subsequent calls.
function _resolveMount(highwayCanvas) {
    if (_ssActive()) {
        return _ssPanelChrome(highwayCanvas);
    }
    return document.getElementById('player');
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor sync helpers (stateless — beats come from the bundle)
// ═══════════════════════════════════════════════════════════════════════

function _tvTimeToTick(seconds, beats) {
    if (!beats || beats.length < 2) return 960;
    if (seconds < beats[0].time) return 960;

    let idx = 0;
    for (let i = 0; i < beats.length - 1; i++) {
        if (seconds >= beats[i].time) idx = i;
        else break;
    }

    let frac = 0;
    if (idx < beats.length - 1) {
        const bStart = beats[idx].time;
        const bEnd = beats[idx + 1].time;
        if (bEnd > bStart) {
            frac = Math.min(1, Math.max(0, (seconds - bStart) / (bEnd - bStart)));
        }
    }

    return 960 + Math.round((idx + frac) * 960);
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // alphaTab + DOM state (per-instance)
    let _tvApi = null;
    let _tvContainer = null;
    let _tvAtMount = null;       // inner <div> alphaTab renders into
    let _tvHighlight = null;     // cursor highlight overlay element
    let _tvErrorBanner = null;   // current error banner element (if any)
    let _tvErrorBannerTimeout = null;
    let _tvReady = false;

    // Highway canvas swap state
    let _tvHighwayCanvas = null;
    let _tvPrevVisibility = '';

    // Mount position restore — when _tvCreateContainer() promotes a static
    // mount to position:relative it saves the original inline style here so
    // _tvRemoveContainer() can put it back on teardown.
    let _tvPrevMountPosition = null;

    // Fetch / load tracking
    let _tvCurrentFile = null;   // filename the currently-loaded GP5 was fetched for
    let _tvCurrentArr = null;    // arrangement_index the current GP5 was fetched for
    let _tvLoadingFile = null;   // filename a currently-in-flight fetch is targeting
    let _tvLoadingArr = null;    // arrangement_index that fetch is targeting
    let _tvFailedFile = null;    // last (filename, arr_index) pair whose fetch failed —
    let _tvFailedArr = null;     // used by draw() to avoid a per-frame retry storm

    // Cursor sync
    let _tvLastTick = -1;

    // Latest beats snapshot — bundle.beats is the source of truth
    // under Wave C (the bare `highway` global used in Wave B was the
    // main-player's highway, not ours under splitscreen).
    let _tvLatestBeats = null;

    // Monotonic init counter. Each init() bumps it; fetch / alphaTab
    // callbacks capture the token and bail if a newer init has started
    // since. Guards against a rapid arrangement switch where a pending
    // fetch would otherwise install stale GP5 bytes over the new one.
    let _tvInitToken = 0;

    // ── Listener ref (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _tvSizeContainer();

    // ── Container setup ─────────────────────────────────────────────

    function _tvCreateContainer() {
        if (_tvContainer) return _tvContainer;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return null;

        // The overlay is positioned with left:0/right:0 to inherit width
        // from the mount; that requires the mount to be a positioned
        // ancestor. Existing splitscreen/main-player mounts are; this
        // is an idempotent guard so a future host with a static mount
        // doesn't silently collapse our overlay to 0 width. The original
        // inline position value is saved to _tvPrevMountPosition so
        // _tvRemoveContainer() can restore it on teardown.
        if (getComputedStyle(mount).position === 'static') {
            _tvPrevMountPosition = mount.style.position; // save inline value (often '')
            mount.style.position = 'relative';
        }

        const c = document.createElement('div');
        c.id = 'tabview-container-' + _instanceId;
        c.className = 'tabview-container';
        c.dataset.tabviewInstance = String(_instanceId);
        // visibility:hidden (not display:none) so alphaTab can measure
        // the container's width during init. With display:none the
        // element is out of layout and clientWidth is 0, which makes
        // alphaTab skip the render entirely (warning: "AlphaTab skipped
        // rendering because of width=0"). renderFinished swaps
        // visibility to '' once the first paint lands, preserving the
        // flash-free handoff this layer was originally designed for.
        c.style.cssText = [
            'visibility:hidden',
            'position:absolute',
            'top:0',
            'left:0',
            'right:0',
            'overflow-y:auto',
            'background:#fff',
            'z-index:5',
        ].join(';');

        const inner = document.createElement('div');
        inner.id = 'tabview-at-' + _instanceId;
        inner.className = 'tabview-at';
        c.appendChild(inner);

        // Cursor highlight overlay
        const hl = document.createElement('div');
        hl.id = 'tabview-highlight-' + _instanceId;
        hl.className = 'tabview-highlight';
        hl.style.cssText = [
            'position:absolute',
            'width:24px',
            'height:24px',
            'background:rgba(34,211,238,0.15)',
            'border:2px solid rgba(34,211,238,0.9)',
            'border-radius:4px',
            'box-shadow:0 0 0 1px rgba(34,211,238,0.3),0 0 12px rgba(34,211,238,0.6),0 0 24px rgba(34,211,238,0.25)',
            'pointer-events:none',
            'z-index:999',
            'display:none',
        ].join(';');
        c.appendChild(hl);

        mount.appendChild(c);
        _tvContainer = c;
        _tvAtMount = inner;
        _tvHighlight = hl;
        return c;
    }

    function _tvSizeContainer() {
        if (!_tvContainer) return;
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        // Splitscreen: fill the panel chrome top-to-bottom (the panel
        // bar layers on top via z-index). Main-player: leave the top
        // 60px clear for #player-controls.
        const topOffset = _ssActive() ? 0 : 60;
        _tvContainer.style.top = topOffset + 'px';
        _tvContainer.style.height = Math.max(0, mount.clientHeight - topOffset) + 'px';
        // After a resize the cursor element's getBoundingClientRect
        // changes even at the same tick, so re-position the
        // highlight overlay. Without this the per-frame highlight
        // update was masking the issue; now that _tvSyncCursor
        // skips redundant updates, resize needs to drive it.
        _tvUpdateHighlight();
    }

    function _tvRemoveContainer() {
        if (_tvContainer) {
            // Restore mount's position style if we changed it in _tvCreateContainer().
            if (_tvPrevMountPosition !== null) {
                const mount = _tvContainer.parentElement;
                if (mount) mount.style.position = _tvPrevMountPosition;
                _tvPrevMountPosition = null;
            }
            _tvContainer.remove();
            _tvContainer = null;
            _tvAtMount = null;
            _tvHighlight = null;
        }
    }

    // ── Error banner ────────────────────────────────────────────────
    //
    // When the GP5 fetch or alphaTab render fails, we hide the tabview
    // container so the 2D highway stays visible. That alone leaves the
    // failure silent to anyone who can't open devtools. A small,
    // auto-dismissing banner anchored to this instance's mount surfaces
    // the error without covering the highway — living OUTSIDE the
    // tabview container so it coexists with the fallback renderer
    // instead of occluding it.

    function _tvShowErrorBanner(message) {
        _tvRemoveErrorBanner();
        const mount = _resolveMount(_tvHighwayCanvas);
        if (!mount) return;
        const banner = document.createElement('div');
        banner.id = 'tabview-error-banner-' + _instanceId;
        banner.className = 'tabview-error-banner';
        banner.dataset.tabviewInstance = String(_instanceId);
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:absolute',
            'top:10px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(220,80,80,0.94)',
            'color:#fff',
            'padding:8px 16px',
            'border-radius:8px',
            'z-index:30',
            'font-size:12px',
            'font-family:system-ui,sans-serif',
            'max-width:80%',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'pointer-events:none',
        ].join(';');
        banner.textContent = 'Tab View: ' + (message || 'failed to load');
        mount.appendChild(banner);
        _tvErrorBanner = banner;
        _tvErrorBannerTimeout = setTimeout(_tvRemoveErrorBanner, 6000);
    }

    function _tvRemoveErrorBanner() {
        if (_tvErrorBanner) {
            _tvErrorBanner.remove();
            _tvErrorBanner = null;
        }
        if (_tvErrorBannerTimeout) {
            clearTimeout(_tvErrorBannerTimeout);
            _tvErrorBannerTimeout = null;
        }
    }

    // ── alphaTab init ───────────────────────────────────────────────

    async function _tvInitAlphaTab(arrayBuffer, myToken) {
        const c = _tvCreateContainer();
        if (!c) return;

        // Destroy previous API before re-init so scoreLoaded / error
        // handlers from the old lifetime don't fire into stale DOM.
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvReady = false;
        if (_tvAtMount) _tvAtMount.innerHTML = '';

        _tvApi = new alphaTab.AlphaTabApi(_tvAtMount, {
            core: {
                fontDirectory: ALPHATAB_CDN_BASE + '/font/',
            },
            display: {
                layoutMode: alphaTab.LayoutMode.Page,
                scale: 0.9,
            },
            player: {
                enablePlayer: true,
                enableCursor: true,
                soundFont: ALPHATAB_CDN_BASE + '/soundfont/sonivox.sf2',
            },
        });

        // Mute alphaTab's internal audio once a score is loaded — we
        // drive playback from slopsmith's <audio> element; alphaTab is
        // just a visual surface here.
        _tvApi.scoreLoaded.on(function (score) {
            if (_tvInitToken !== myToken) return;
            if (score && score.tracks) {
                try { _tvApi.changeTrackMute(score.tracks, true); } catch (_) {}
            }
        });

        _tvApi.renderFinished.on(function () {
            if (_tvInitToken !== myToken) return;
            _tvReady = true;
            // Swap visibility only once alphaTab has actually produced
            // output. _tvApi.load() kicks off rendering synchronously
            // but the first frame lands several rAFs later; if we hid
            // the highway in _tvFetchAndInit right after load() returned
            // (the previous behaviour) the player flashed blank for
            // the duration of the render, or stayed blank forever if
            // renderFinished never fired. Doing it here guarantees a
            // painted-to-painted handoff and lets the error path below
            // fall back to the still-visible 2D highway.
            if (_tvContainer) _tvContainer.style.visibility = '';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = 'hidden';
            _tvFailedFile = null;
            _tvFailedArr = null;
            // A successful render supersedes any prior error banner.
            _tvRemoveErrorBanner();
        });

        _tvApi.error.on(function (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] alphaTab error:', e);
            // Render or parse error after GP5 fetch succeeded: tabview
            // can't display anything for this target. Mark it failed so
            // draw()'s change-detection doesn't re-fetch on every rAF,
            // hide our (possibly empty) overlay, and restore highway
            // visibility so the player isn't stranded blank. Use
            // _tvCurrentFile/Arr if set (post-fetch) else fall back to
            // the in-flight _tvLoadingFile/Arr so we always remember
            // what went wrong.
            const failedFile = _tvCurrentFile || _tvLoadingFile;
            const failedArr = _tvCurrentArr != null ? _tvCurrentArr : _tvLoadingArr;
            _tvReady = false;
            _tvCurrentFile = null;
            _tvCurrentArr = null;
            if (failedFile != null) {
                _tvFailedFile = failedFile;
                _tvFailedArr = failedArr;
            }
            if (_tvContainer) _tvContainer.style.visibility = 'hidden';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
            const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'render failed');
            _tvShowErrorBanner(msg);
        });

        _tvApi.load(new Uint8Array(arrayBuffer));
    }

    async function _tvFetchAndInit(filename, arrIdx, myToken) {
        if (!filename) {
            console.warn('[TabView] no filename known yet; skipping fetch');
            return;
        }
        // Mount-availability guard. In splitscreen the panel chrome
        // can be null transiently (panel mid-creation, screen
        // transitions) — _resolveMount returns null in that case.
        // Bail BEFORE setting _tvLoading* / hitting the network so
        // draw()'s change-detect doesn't treat us as in-flight, and
        // so we don't spam the GP5 endpoint with fetches that would
        // immediately discard their results because _tvCreateContainer
        // returns null too. The next draw() retries cleanly once the
        // panel chrome resolves; load state stays "needs fetch" via
        // _tvCurrentFile/_tvCurrentArr remaining unset.
        if (!_resolveMount(_tvHighwayCanvas)) {
            return;
        }
        _tvLoadingFile = filename;
        _tvLoadingArr = arrIdx;
        try {
            await _tvLoadScript();
            if (_tvInitToken !== myToken) return;

            // Decode first — filename may already be URI-encoded from
            // the data-play attribute — then re-encode for the request
            // path. decodeURIComponent throws URIError on stray % or
            // bare `%xx` where xx isn't valid hex; fall back to the raw
            // filename so a rare encoding edge case doesn't land in the
            // (_tvFailedFile, _tvFailedArr) cache and permanently block
            // retries for that song / arrangement.
            let decoded = filename;
            try {
                decoded = decodeURIComponent(filename);
            } catch (e) {
                console.warn('[TabView] decodeURIComponent failed; using raw filename:', filename, e);
            }
            const url = '/api/plugins/tabview/gp5/' + encodeURIComponent(decoded) +
                '?arrangement=' + arrIdx;
            const resp = await fetch(url);
            if (_tvInitToken !== myToken) return;
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.arrayBuffer();
            if (_tvInitToken !== myToken) return;

            // _tvCreateContainer returns null when the mount target
            // isn't in the DOM (player screen closed, unusual timing
            // during screen transitions). Without this guard the next
            // line's _tvContainer.style.visibility = '' would throw on
            // null and the failure path below would cache this as a
            // permanent failure for the song, even though the real
            // issue is transient DOM state.
            const container = _tvCreateContainer();
            if (!container) {
                console.warn('[TabView] mount container missing; leaving highway visible');
                if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
                return;
            }
            _tvSizeContainer();
            await _tvInitAlphaTab(data, myToken);

            if (_tvInitToken !== myToken) return;
            _tvCurrentFile = filename;
            _tvCurrentArr = arrIdx;
            // DO NOT show the container or hide the highway here:
            // _tvApi.load() inside _tvInitAlphaTab kicks off rendering
            // but resolves before the first frame is painted, so doing
            // the visibility swap at this point would flash the player
            // blank during the render setup (or forever if render never
            // completes). The renderFinished handler inside
            // _tvInitAlphaTab takes over: on success it swaps in the
            // overlay, on error it keeps the highway visible.
        } catch (e) {
            if (_tvInitToken !== myToken) return;
            console.error('[TabView] GP5 fetch/init failed:', e);
            _tvFailedFile = filename;
            _tvFailedArr = arrIdx;
            // Hide any stale tab overlay (either a prior successful load
            // that's being reloaded into a failing song, or the freshly
            // created empty container from an initial failed load) so
            // the highway fallback actually becomes visible.
            if (_tvContainer) _tvContainer.style.visibility = 'hidden';
            if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
            const msg = (e && e.message) ? e.message : String(e);
            console.warn('[TabView] ' + msg);
            _tvShowErrorBanner(msg);
        } finally {
            // Only clear the loading-target if this fetch is still the
            // latest in-flight one — a newer token bump already cleared /
            // re-set these fields for a subsequent fetch.
            if (_tvInitToken === myToken) {
                _tvLoadingFile = null;
                _tvLoadingArr = null;
            }
        }
    }

    // ── Cursor sync ─────────────────────────────────────────────────

    function _tvSyncCursor(currentTime) {
        if (!_tvApi || !_tvReady) return;

        const tick = _tvTimeToTick(currentTime, _tvLatestBeats);
        // Skip the (expensive) highlight update when the tick hasn't
        // advanced — _tvUpdateHighlight runs N querySelectorAll calls
        // across multiple selectors and roots, and at 60fps × N
        // splitscreen instances that's a meaningful cost for state
        // that doesn't change between frames. Resize-driven cursor
        // movement still gets a highlight update via _onWinResize
        // → _tvSizeContainer → _tvUpdateHighlight.
        if (Math.abs(tick - _tvLastTick) <= 30) return;
        _tvLastTick = tick;
        try { _tvApi.tickPosition = tick; } catch (_) {}
        _tvUpdateHighlight();
    }

    // ── Cursor highlight bar ────────────────────────────────────────

    function _tvFindCursorRect() {
        if (!_tvAtMount) return null;
        const selectors = ['.at-cursor-beat', '.at-cursor-bar', '.at-cursor', '[class*="cursor"]'];
        const roots = [_tvAtMount];
        if (_tvAtMount.shadowRoot) roots.push(_tvAtMount.shadowRoot);
        for (let r = 0; r < roots.length; r++) {
            for (let s = 0; s < selectors.length; s++) {
                const nodes = roots[r].querySelectorAll(selectors[s]);
                for (let n = 0; n < nodes.length; n++) {
                    const rect = nodes[n].getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return rect;
                }
            }
        }
        return null;
    }

    function _tvUpdateHighlight() {
        if (!_tvHighlight || !_tvContainer) return;

        const cursorRect = _tvFindCursorRect();
        if (!cursorRect) { _tvHighlight.style.display = 'none'; return; }

        const wrapRect = _tvContainer.getBoundingClientRect();
        const size = Math.max(18, Math.min(36, Math.round(Math.max(cursorRect.width, cursorRect.height, 20))));
        const x = cursorRect.left - wrapRect.left + _tvContainer.scrollLeft + (cursorRect.width - size) / 2;
        const y = cursorRect.top - wrapRect.top + _tvContainer.scrollTop + (cursorRect.height - size) / 2;

        _tvHighlight.style.left = Math.round(x) + 'px';
        _tvHighlight.style.top = Math.round(y) + 'px';
        _tvHighlight.style.width = size + 'px';
        _tvHighlight.style.height = size + 'px';
        _tvHighlight.style.display = '';

        // Auto-scroll to keep cursor visible
        const paddingX = Math.min(180, wrapRect.width * 0.3);
        const paddingY = Math.min(100, wrapRect.height * 0.25);

        const relX = cursorRect.left - wrapRect.left;
        const relY = cursorRect.top - wrapRect.top;

        let needScroll = false;
        let targetX = _tvContainer.scrollLeft;
        let targetY = _tvContainer.scrollTop;

        if (relX < paddingX || relX > wrapRect.width - paddingX) {
            targetX = x - wrapRect.width / 2;
            needScroll = true;
        }
        if (relY < paddingY || relY > wrapRect.height - paddingY) {
            targetY = y - wrapRect.height / 2;
            needScroll = true;
        }

        if (needScroll) {
            _tvContainer.scrollTo({ left: targetX, top: targetY, behavior: 'auto' });
        }
    }

    // ── Teardown ────────────────────────────────────────────────────

    function _teardown(restoreCanvas) {
        _tvReady = false;
        _tvLastTick = -1;
        _tvCurrentFile = null;
        _tvCurrentArr = null;
        _tvLoadingFile = null;
        _tvLoadingArr = null;
        _tvFailedFile = null;
        _tvFailedArr = null;
        _tvLatestBeats = null;
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvRemoveContainer();
        _tvRemoveErrorBanner();
        if (restoreCanvas && _tvHighwayCanvas) {
            _tvHighwayCanvas.style.visibility = _tvPrevVisibility;
            _tvHighwayCanvas = null;
            _tvPrevVisibility = '';
        }
    }

    // ── Factory return: setRenderer contract ────────────────────────

    return {
        init(canvas, bundle) {
            // Always run teardown at init start, even when there's
            // no visible container/API to tear down. A previous
            // activation that failed BEFORE alphaTab initialised
            // (e.g. CDN load error, fetch error pre-container) would
            // otherwise leak _tvFailedFile / _tvFailedArr into this
            // lifetime — the new fetch would hit the previouslyFailed
            // guard in draw() and silently skip, so re-picking Tab
            // View would appear to do nothing.
            //
            // restoreCanvas=true (not false) is critical here: a
            // prior successful render hid the highway canvas via
            // renderFinished, and skipping the restore would leave
            // the canvas at visibility:hidden when the new init
            // captures _tvPrevVisibility below — so a subsequent
            // failed fetch / destroy would "restore" the canvas to
            // hidden and strand the player blank. The
            // _tvHighwayCanvas reference is also nulled by the
            // restore branch, freeing the new init() to install
            // the freshly-passed canvas without aliasing.
            _teardown(/* restoreCanvas */ true);
            window.removeEventListener('resize', _onWinResize);

            const myToken = ++_tvInitToken;
            _tvHighwayCanvas = canvas;
            _tvPrevVisibility = canvas ? canvas.style.visibility : '';

            // DON'T hide the 2D highway yet — if GP5 fetch, CDN load,
            // or alphaTab init fails (missing filename, server down,
            // network error), we want the default visible as a
            // fallback so the player isn't stranded blank. The hide
            // happens inside renderFinished on success, and a failed
            // fetch restores _tvPrevVisibility explicitly.

            _tvLastTick = -1;
            window.addEventListener('resize', _onWinResize);

            const songInfo = (bundle && bundle.songInfo) || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _tvFilename;
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            _tvFetchAndInit(filename, arrIdx, myToken);

            _isReady = true;
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Cache beats per frame so cursor sync uses the
            // filter-aware beats from THIS instance's bundle, not
            // the main-player's `highway` global (which under
            // splitscreen belongs to the hidden default highway and
            // wouldn't reflect this panel's arrangement).
            _tvLatestBeats = bundle.beats || null;

            // Detect arrangement / song change: re-fetch GP5 when the
            // active (filename, arrangement_index) differs from the
            // one the currently-displayed score was loaded for. Guard
            // against per-frame retry loops — while a fetch is in
            // flight for the same target, skip. draw() runs every rAF
            // and a typical fetch takes well over one frame; without
            // this check we'd spam the endpoint and keep bumping the
            // init token, invalidating each request before it lands.
            //
            // Prefer bundle.songInfo.filename when present and fall
            // back to the _tvFilename cache from our playSong wrap.
            // slopsmith core doesn't expose filename in song_info
            // today, but routing through bundle first means we pick
            // it up automatically when/if core adds it, and it
            // eliminates the small race where _tvFilename lags
            // bundle.songInfo during a rapid song switch.
            const songInfo = bundle.songInfo || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _tvFilename;
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            const chartChanged = filename &&
                (filename !== _tvCurrentFile || arrIdx !== _tvCurrentArr);
            const loadInFlight = _tvLoadingFile !== null &&
                _tvLoadingFile === filename && _tvLoadingArr === arrIdx;
            const previouslyFailed = _tvFailedFile === filename &&
                _tvFailedArr === arrIdx;
            if (chartChanged && !loadInFlight && !previouslyFailed) {
                // Defense-in-depth mount check. _tvFetchAndInit also
                // guards (and is the single source of truth), but
                // doing the check here too saves a per-frame
                // _tvInitToken bump while the panel chrome is
                // transient-null; tokens are cheap but the bump+bail
                // pattern is dead work.
                if (_resolveMount(_tvHighwayCanvas)) {
                    const myToken = ++_tvInitToken;
                    _tvLastTick = -1;
                    _tvFetchAndInit(filename, arrIdx, myToken);
                    // fall through — cursor sync below will be a no-op
                    // until _tvReady flips true again after the re-init.
                }
            }

            _tvSyncCursor(bundle.currentTime);
        },
        resize(/* w, h */) {
            if (!_isReady) return;
            _tvSizeContainer();
        },
        destroy() {
            _isReady = false;
            _tvInitToken++;  // invalidate in-flight fetches
            window.removeEventListener('resize', _onWinResize);
            _teardown(/* restoreCanvas */ true);
        },
    };
}

// Arrangement-agnostic — Auto mode should not auto-select tabview.
// (The static matchesArrangement is intentionally absent.)

window.slopsmithViz_tabview = createFactory;

})();

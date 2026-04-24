// Tab View visualization plugin — renders Rocksmith arrangements as
// scrolling tablature via alphaTab (https://alphatab.net/).
//
// Wave B migration (slopsmith#36): the plugin used to be a toggle
// button sitting next to the highway. It's now a full-replacement
// viz selected via the picker; activation, deactivation, and
// teardown all flow through slopsmith core's setRenderer lifecycle.
// tabview is arrangement-agnostic (we can render any arrangement's
// tabs), so there's no matchesArrangement — Auto mode won't pick it
// automatically; users select it manually from the viz picker.
//
// Single-instance assumption: the alphaTab container, the cursor
// highlight, and the cursor-sync state are module-scope. The main
// player's picker uses at most one instance at a time. Splitscreen's
// per-panel setRenderer adoption (Wave C) will re-factor these into
// createFactory closures so multiple panels can host independent
// tabview instances.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Module-level state
// ═══════════════════════════════════════════════════════════════════════

let _tvApi = null;
let _tvContainer = null;
let _tvReady = false;
let _tvFilename = null;     // captured from playSong wrap + arrangement:changed
let _tvCurrentFile = null;  // filename the currently-loaded GP5 was fetched for
let _tvCurrentArr = null;   // arrangement_index the current GP5 was fetched for
let _tvLoadingFile = null;  // filename a currently-in-flight fetch is targeting
let _tvLoadingArr = null;   // arrangement_index that fetch is targeting
let _tvFailedFile = null;   // last (filename, arr_index) pair whose fetch failed —
let _tvFailedArr = null;    // used by draw() to avoid a per-frame retry storm
let _tvHighwayCanvas = null;
let _tvPrevVisibility = '';
let _tvLastTick = -1;
// Monotonic init counter. Each init() bumps it; fetch / alphaTab
// callbacks capture the token and bail if a newer init has started
// since. Guards against a rapid arrangement switch where a pending
// fetch would otherwise install stale GP5 bytes over the new one.
let _tvInitToken = 0;

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
// Container setup
// ═══════════════════════════════════════════════════════════════════════

function _tvCreateContainer() {
    if (_tvContainer) return _tvContainer;

    const c = document.createElement('div');
    c.id = 'tabview-container';
    c.style.cssText = [
        'display:none',
        'position:absolute',
        'top:0',
        'left:0',
        'right:0',
        'overflow-y:auto',
        'background:#fff',
        'z-index:5',
    ].join(';');

    const inner = document.createElement('div');
    inner.id = 'tabview-at';
    c.appendChild(inner);

    // Cursor highlight overlay
    const hl = document.createElement('div');
    hl.id = 'tabview-highlight';
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

    // Loading overlay
    const ov = document.createElement('div');
    ov.id = 'tabview-loading';
    ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;z-index:10;';
    ov.innerHTML = '<span style="color:#888;font-size:14px;">Loading tablature…</span>';
    c.appendChild(ov);

    const player = document.getElementById('player');
    if (!player) return null;
    player.appendChild(c);
    _tvContainer = c;
    return c;
}

function _tvSizeContainer() {
    if (!_tvContainer) return;
    const canvas = _tvHighwayCanvas || document.getElementById('highway');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    _tvContainer.style.top = '60px';
    _tvContainer.style.height = Math.max(0, rect.height - 60) + 'px';
}

function _tvRemoveContainer() {
    if (_tvContainer) {
        _tvContainer.remove();
        _tvContainer = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// alphaTab init
// ═══════════════════════════════════════════════════════════════════════

async function _tvInitAlphaTab(arrayBuffer, myToken) {
    const c = _tvCreateContainer();
    if (!c) return;
    const el = document.getElementById('tabview-at');

    // Destroy previous API before re-init so scoreLoaded / error
    // handlers from the old lifetime don't fire into stale DOM.
    if (_tvApi) {
        try { _tvApi.destroy(); } catch (_) {}
        _tvApi = null;
    }
    _tvReady = false;
    if (el) el.innerHTML = '';

    const ov = document.getElementById('tabview-loading');
    if (ov) ov.style.display = 'flex';

    _tvApi = new alphaTab.AlphaTabApi(el, {
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
        const ov2 = document.getElementById('tabview-loading');
        if (ov2) ov2.style.display = 'none';
        // Swap visibility only once alphaTab has actually produced
        // output. _tvApi.load() kicks off rendering synchronously
        // but the first frame lands several rAFs later; if we hid
        // the highway in _tvFetchAndInit right after load() returned
        // (the previous behaviour) the player flashed blank for
        // the duration of the render, or stayed blank forever if
        // renderFinished never fired. Doing it here guarantees a
        // painted-to-painted handoff and lets the error path below
        // fall back to the still-visible 2D highway.
        if (_tvContainer) _tvContainer.style.display = '';
        if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = 'hidden';
        _tvFailedFile = null;
        _tvFailedArr = null;
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
        if (_tvContainer) _tvContainer.style.display = 'none';
        if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
    });

    _tvApi.load(new Uint8Array(arrayBuffer));
}

async function _tvFetchAndInit(filename, arrIdx, myToken) {
    if (!filename) {
        console.warn('[TabView] no filename known yet; skipping fetch');
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

        // _tvCreateContainer returns null when #player isn't in the
        // DOM (player screen closed, unusual timing during screen
        // transitions). Without this guard the next line's
        // _tvContainer.style.display = '' would throw on null and
        // the failure path below would cache this as a permanent
        // failure for the song, even though the real issue is
        // transient DOM state.
        const container = _tvCreateContainer();
        if (!container) {
            console.warn('[TabView] #player container missing; leaving highway visible');
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
        // _tvFailedFile/_tvFailedArr likewise stay as-is until
        // renderFinished clears them.
    } catch (e) {
        if (_tvInitToken !== myToken) return;
        console.error('[TabView] GP5 fetch/init failed:', e);
        // Remember the failed target so draw()'s change-detection
        // doesn't kick off a new fetch on the next rAF frame.
        _tvFailedFile = filename;
        _tvFailedArr = arrIdx;
        // Hide any stale tab overlay (either a prior successful load
        // that's being reloaded into a failing song, or the freshly
        // created empty container from an initial failed load) so
        // the highway fallback actually becomes visible.
        if (_tvContainer) _tvContainer.style.display = 'none';
        // On failure leave the 2D highway visible so the user isn't
        // stranded on a blank player. They can switch viz to recover;
        // if they re-pick Tab View and the problem persists the same
        // error surfaces again.
        if (_tvHighwayCanvas) _tvHighwayCanvas.style.visibility = _tvPrevVisibility || '';
        console.warn('[TabView] ' + (e && e.message ? e.message : e));
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

// ═══════════════════════════════════════════════════════════════════════
// Cursor sync
// ═══════════════════════════════════════════════════════════════════════

function _tvTimeToTick(seconds) {
    const beats = typeof highway !== 'undefined' && typeof highway.getBeats === 'function'
        ? highway.getBeats() : null;
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

function _tvSyncCursor(currentTime) {
    if (!_tvApi || !_tvReady) return;

    const tick = _tvTimeToTick(currentTime);
    if (Math.abs(tick - _tvLastTick) > 30) {
        _tvLastTick = tick;
        try { _tvApi.tickPosition = tick; } catch (_) {}
    }

    _tvUpdateHighlight();
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor highlight bar
// ═══════════════════════════════════════════════════════════════════════

function _tvFindCursorRect() {
    const host = document.getElementById('tabview-at');
    if (!host) return null;
    const selectors = ['.at-cursor-beat', '.at-cursor-bar', '.at-cursor', '[class*="cursor"]'];
    const roots = [host];
    if (host.shadowRoot) roots.push(host.shadowRoot);
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
    const hl = document.getElementById('tabview-highlight');
    if (!hl || !_tvContainer) return;

    const cursorRect = _tvFindCursorRect();
    if (!cursorRect) { hl.style.display = 'none'; return; }

    const wrapRect = _tvContainer.getBoundingClientRect();
    const size = Math.max(18, Math.min(36, Math.round(Math.max(cursorRect.width, cursorRect.height, 20))));
    const x = cursorRect.left - wrapRect.left + _tvContainer.scrollLeft + (cursorRect.width - size) / 2;
    const y = cursorRect.top - wrapRect.top + _tvContainer.scrollTop + (cursorRect.height - size) / 2;

    hl.style.left = Math.round(x) + 'px';
    hl.style.top = Math.round(y) + 'px';
    hl.style.width = size + 'px';
    hl.style.height = size + 'px';
    hl.style.display = '';

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

// ═══════════════════════════════════════════════════════════════════════
// Filename tracking
// ═══════════════════════════════════════════════════════════════════════
//
// slopsmith core doesn't expose the current song's filename via a
// getter (song_info carries metadata, not the WS URL). Capture it
// ourselves by wrapping window.playSong once at module load and
// subscribing to arrangement:changed. init() consumes the cached
// _tvFilename on selection.

(function () {
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

    // Re-measure the container when the window resizes — cheap and
    // safe whether or not tabview is currently selected.
    window.addEventListener('resize', _tvSizeContainer);
})();

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    let _isReady = false;

    // Declared before the returned object so readers see the full
    // lifecycle surface without paging past `return`. Function
    // hoisting meant the prior layout worked, but tooling warnings
    // and reader ergonomics both prefer structural-before-return.
    function _teardown(restoreCanvas) {
        _tvReady = false;
        _tvLastTick = -1;
        _tvCurrentFile = null;
        _tvCurrentArr = null;
        _tvLoadingFile = null;
        _tvLoadingArr = null;
        _tvFailedFile = null;
        _tvFailedArr = null;
        if (_tvApi) {
            try { _tvApi.destroy(); } catch (_) {}
            _tvApi = null;
        }
        _tvRemoveContainer();
        if (restoreCanvas && _tvHighwayCanvas) {
            _tvHighwayCanvas.style.visibility = _tvPrevVisibility;
            _tvHighwayCanvas = null;
            _tvPrevVisibility = '';
        }
    }

    return {
        init(canvas, bundle) {
            // Defensive teardown for a misbehaving caller.
            if (_tvContainer || _tvApi) {
                _teardown(/* restoreCanvas */ false);
            }

            const myToken = ++_tvInitToken;
            _tvHighwayCanvas = canvas;
            _tvPrevVisibility = canvas ? canvas.style.visibility : '';

            // DON'T hide the 2D highway yet — if GP5 fetch, CDN load,
            // or alphaTab init fails (missing filename, server down,
            // network error), we want the default visible as a
            // fallback so the player isn't stranded blank. The hide
            // happens inside _tvFetchAndInit on success, and a failed
            // fetch restores _tvPrevVisibility explicitly.

            _tvLastTick = -1;

            const songInfo = (bundle && bundle.songInfo) || {};
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            _tvFetchAndInit(_tvFilename, arrIdx, myToken);

            _isReady = true;
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Detect arrangement / song change: re-fetch GP5 when the
            // active (filename, arrangement_index) differs from the
            // one the currently-displayed score was loaded for. Guard
            // against per-frame retry loops — while a fetch is in
            // flight for the same target, skip. draw() runs every rAF
            // and a typical fetch takes well over one frame; without
            // this check we'd spam the endpoint and keep bumping the
            // init token, invalidating each request before it lands.
            const songInfo = bundle.songInfo || {};
            const arrIdx = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;
            const chartChanged = _tvFilename &&
                (_tvFilename !== _tvCurrentFile || arrIdx !== _tvCurrentArr);
            const loadInFlight = _tvLoadingFile !== null &&
                _tvLoadingFile === _tvFilename && _tvLoadingArr === arrIdx;
            const previouslyFailed = _tvFailedFile === _tvFilename &&
                _tvFailedArr === arrIdx;
            if (chartChanged && !loadInFlight && !previouslyFailed) {
                const myToken = ++_tvInitToken;
                _tvLastTick = -1;
                _tvFetchAndInit(_tvFilename, arrIdx, myToken);
                // fall through — cursor sync below will be a no-op
                // until _tvReady flips true again after the re-init.
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
            _teardown(/* restoreCanvas */ true);
        },
    };
}

// Arrangement-agnostic — Auto mode should not auto-select tabview.
// (The static matchesArrangement is intentionally absent.)

window.slopsmithViz_tabview = createFactory;

})();

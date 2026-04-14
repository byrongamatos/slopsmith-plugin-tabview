// Tab View plugin — renders Rocksmith arrangements as scrolling tablature via alphaTab.
//
// Architecture: the alphaTab + cursor-sync engine is wrapped in a factory
// (createTabView) so plugins like splitscreen can mount independent tab views
// inside their own panels, each with its own beat source and time clock. The
// original singleton toolbar button is preserved at the bottom of the file
// and consumes the same factory under the hood.

// ── alphaTab CDN loader (shared) ───────────────────────────────────────

let _tvScriptPromise = null;
function _tvLoadScript() {
    if (window.alphaTab) return Promise.resolve();
    if (_tvScriptPromise) return _tvScriptPromise;
    _tvScriptPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/alphaTab.min.js';
        s.onload = resolve;
        s.onerror = () => { _tvScriptPromise = null; reject(new Error('Failed to load alphaTab')); };
        document.head.appendChild(s);
    });
    return _tvScriptPromise;
}

// ── Factory ─────────────────────────────────────────────────────────────
//
// Usage:
//   const tv = createTabView({
//       container: someDiv,                  // required — host element for alphaTab
//       getBeats: () => highway.getBeats(),  // required — returns [{time}] array
//       getCurrentTime: () => audio.currentTime, // required — playback clock in seconds
//   });
//   await tv.load(arrayBuffer);              // load GP5 data
//   tv.startSync();                          // begin cursor sync loop
//   ...
//   tv.destroy();                            // tear down alphaTab + sync + DOM nodes
//
// The factory creates its own inner DOM (alphaTab host + highlight overlay
// + loading overlay) inside the given container. It does not touch any
// global elements like #highway, #audio, or #btn-tabview.

function createTabView(options) {
    const container = options.container;
    const getBeats = options.getBeats;
    const getCurrentTime = options.getCurrentTime;
    if (!container || typeof getBeats !== 'function' || typeof getCurrentTime !== 'function') {
        throw new Error('createTabView: container, getBeats, getCurrentTime are required');
    }

    // Build inner DOM
    container.style.position = container.style.position || 'relative';

    const inner = document.createElement('div');
    inner.className = 'tabview-at';
    inner.style.cssText = 'background:#fff;';
    container.appendChild(inner);

    const hl = document.createElement('div');
    hl.className = 'tabview-highlight';
    hl.style.cssText = [
        'position:absolute',
        'width:24px',
        'height:24px',
        'background:rgba(255,235,59,0.35)',
        'border:2px solid rgba(250,204,21,0.95)',
        'border-radius:4px',
        'box-shadow:0 0 0 1px rgba(250,204,21,0.35),0 0 10px rgba(250,204,21,0.35)',
        'pointer-events:none',
        'z-index:999',
        'display:none',
    ].join(';');
    container.appendChild(hl);

    const ov = document.createElement('div');
    ov.className = 'tabview-loading';
    ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;z-index:10;';
    ov.innerHTML = '<span style="color:#888;font-size:14px;">Loading tablature\u2026</span>';
    container.appendChild(ov);

    let api = null;
    let ready = false;
    let syncRAF = null;
    let destroyed = false;

    async function load(arrayBuffer) {
        await _tvLoadScript();
        if (destroyed) return;

        if (api) {
            try { api.destroy(); } catch (_) {}
            api = null;
        }
        ready = false;
        inner.innerHTML = '';
        ov.style.display = 'flex';

        api = new alphaTab.AlphaTabApi(inner, {
            core: {
                fontDirectory: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/font/',
            },
            display: {
                layoutMode: alphaTab.LayoutMode.Page,
                scale: 0.9,
            },
            player: {
                enablePlayer: true,
                enableCursor: true,
                soundFont: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/soundfont/sonivox.sf2',
            },
        });

        api.scoreLoaded.on(function (score) {
            if (score && score.tracks) {
                try { api.changeTrackMute(score.tracks, true); } catch (_) {}
            }
        });

        api.renderFinished.on(function () {
            ready = true;
            ov.style.display = 'none';
        });

        api.error.on(function (e) {
            console.error('[TabView] alphaTab error:', e);
        });

        api.load(new Uint8Array(arrayBuffer));
    }

    function timeToTick(seconds) {
        const beats = getBeats();
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

    function findCursorRect() {
        const selectors = ['.at-cursor-beat', '.at-cursor-bar', '.at-cursor', '[class*="cursor"]'];
        const roots = [inner];
        if (inner.shadowRoot) roots.push(inner.shadowRoot);
        for (const r of roots) {
            for (const s of selectors) {
                const nodes = r.querySelectorAll(s);
                for (const n of nodes) {
                    const rect = n.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) return rect;
                }
            }
        }
        return null;
    }

    function updateHighlight() {
        const cursorRect = findCursorRect();
        if (!cursorRect) { hl.style.display = 'none'; return; }

        const wrapRect = container.getBoundingClientRect();
        const size = Math.max(18, Math.min(36, Math.round(Math.max(cursorRect.width, cursorRect.height, 20))));
        const x = cursorRect.left - wrapRect.left + container.scrollLeft + (cursorRect.width - size) / 2;
        const y = cursorRect.top - wrapRect.top + container.scrollTop + (cursorRect.height - size) / 2;

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
        let targetX = container.scrollLeft;
        let targetY = container.scrollTop;

        if (relX < paddingX || relX > wrapRect.width - paddingX) {
            targetX = x - wrapRect.width / 2;
            needScroll = true;
        }
        if (relY < paddingY || relY > wrapRect.height - paddingY) {
            targetY = y - wrapRect.height / 2;
            needScroll = true;
        }
        if (needScroll) {
            container.scrollTo({ left: targetX, top: targetY, behavior: 'auto' });
        }
    }

    function startSync() {
        if (syncRAF) return;
        let lastTick = -1;
        hl.style.display = '';

        function loop() {
            if (destroyed) return;
            syncRAF = requestAnimationFrame(loop);
            if (!api || !ready) return;

            const tick = timeToTick(getCurrentTime());
            if (Math.abs(tick - lastTick) > 30) {
                lastTick = tick;
                try { api.tickPosition = tick; } catch (_) {}
            }
            updateHighlight();
        }
        loop();
    }

    function stopSync() {
        if (syncRAF) {
            cancelAnimationFrame(syncRAF);
            syncRAF = null;
        }
        hl.style.display = 'none';
    }

    function destroy() {
        destroyed = true;
        stopSync();
        if (api) {
            try { api.destroy(); } catch (_) {}
            api = null;
        }
        ready = false;
        try { container.removeChild(inner); } catch (_) {}
        try { container.removeChild(hl); } catch (_) {}
        try { container.removeChild(ov); } catch (_) {}
    }

    return {
        load,
        startSync,
        stopSync,
        destroy,
        isReady() { return ready; },
    };
}

// Expose for plugins that want to mount tab views inside their own containers.
window.createTabView = createTabView;

// ── Singleton toolbar button (default UX) ──────────────────────────────
//
// Wraps the factory in a single-instance wrapper that takes over the main
// player area when the user clicks the Tab View toolbar button. Behavior
// matches the pre-refactor plugin exactly.

let _tvActive = false;
let _tvInstance = null;
let _tvContainer = null;
let _tvFilename = null;

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
    document.getElementById('player').appendChild(c);
    _tvContainer = c;
    return c;
}

function _tvSizeContainer() {
    if (!_tvContainer) return;
    const canvas = document.getElementById('highway');
    if (canvas) _tvContainer.style.height = canvas.height + 'px';
}

async function _tvToggle() {
    if (_tvActive) {
        _tvActive = false;
        if (_tvInstance) {
            _tvInstance.stopSync();
        }
        if (_tvContainer) _tvContainer.style.display = 'none';
        document.getElementById('highway').style.visibility = '';
        _tvUpdateButton();
        return;
    }

    const beats = highway.getBeats();
    if (!beats || beats.length < 2) return;

    const btn = document.getElementById('btn-tabview');
    if (btn) btn.textContent = 'Loading\u2026';

    try {
        const filename = _tvFilename;
        const arrSel = document.getElementById('arr-select');
        const arrIdx = arrSel ? arrSel.value : 0;
        const decoded = decodeURIComponent(filename);
        const url = '/api/plugins/tabview/gp5/' + encodeURIComponent(decoded) + '?arrangement=' + arrIdx;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(await resp.text());
        const data = await resp.arrayBuffer();

        _tvCreateContainer();
        _tvSizeContainer();

        if (_tvInstance) {
            _tvInstance.destroy();
            _tvInstance = null;
        }
        _tvInstance = createTabView({
            container: _tvContainer,
            getBeats: () => highway.getBeats(),
            getCurrentTime: () => document.getElementById('audio').currentTime,
        });
        await _tvInstance.load(data);

        _tvActive = true;
        document.getElementById('highway').style.visibility = 'hidden';
        _tvContainer.style.display = '';
        _tvInstance.startSync();
    } catch (e) {
        console.error('[TabView]', e);
        alert('Tab View error: ' + e.message);
    }

    _tvUpdateButton();
}

function _tvUpdateButton() {
    const btn = document.getElementById('btn-tabview');
    if (!btn) return;
    if (_tvActive) {
        btn.textContent = 'Highway';
        btn.className = 'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
    } else {
        btn.textContent = 'Tab View';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    }
}

function _tvInjectButton() {
    const controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-tabview')) return;
    const lyricsBtn = document.getElementById('btn-lyrics');
    const insertBefore = lyricsBtn ? lyricsBtn.nextSibling : null;

    const btn = document.createElement('button');
    btn.id = 'btn-tabview';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    btn.textContent = 'Tab View';
    btn.title = 'Toggle tablature notation view';
    btn.onclick = _tvToggle;
    controls.insertBefore(btn, insertBefore);
}

function _tvReset() {
    _tvActive = false;
    if (_tvInstance) {
        try { _tvInstance.destroy(); } catch (_) {}
        _tvInstance = null;
    }
    if (_tvContainer) _tvContainer.style.display = 'none';
    const hw = document.getElementById('highway');
    if (hw) hw.style.visibility = '';
}

(function () {
    const origPlay = window.playSong;
    window.playSong = async function (filename, arrangement) {
        _tvFilename = filename;
        _tvReset();
        await origPlay(filename, arrangement);
        _tvInjectButton();
    };

    const origArr = window.changeArrangement;
    if (origArr) {
        window.changeArrangement = function (index) {
            if (_tvActive) _tvReset();
            _tvUpdateButton();
            origArr(index);
        };
    }

    window.addEventListener('resize', _tvSizeContainer);
})();

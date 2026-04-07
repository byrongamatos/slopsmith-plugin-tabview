// Tab View plugin — renders Rocksmith arrangements as scrolling tablature via alphaTab.

let _tvActive = false;
let _tvApi = null;
let _tvContainer = null;
let _tvSyncRAF = null;
let _tvCurrentFile = null;
let _tvCurrentArr = null;
let _tvReady = false;
let _tvFilename = null; // captured from playSong hook

// ── alphaTab CDN loader ─────────────────────────────────────────────────

function _tvLoadScript() {
    return new Promise((resolve, reject) => {
        if (window.alphaTab) { resolve(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/alphaTab.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load alphaTab'));
        document.head.appendChild(s);
    });
}

// ── Container setup ─────────────────────────────────────────────────────

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

    // Loading overlay
    const ov = document.createElement('div');
    ov.id = 'tabview-loading';
    ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#fff;z-index:10;';
    ov.innerHTML = '<span style="color:#888;font-size:14px;">Loading tablature\u2026</span>';
    c.appendChild(ov);

    const player = document.getElementById('player');
    player.appendChild(c);
    _tvContainer = c;
    return c;
}

function _tvSizeContainer() {
    if (!_tvContainer) return;
    const canvas = document.getElementById('highway');
    if (canvas) _tvContainer.style.height = canvas.height + 'px';
}

// ── alphaTab init ───────────────────────────────────────────────────────

async function _tvInit(arrayBuffer) {
    const c = _tvCreateContainer();
    const el = document.getElementById('tabview-at');

    // Destroy previous
    if (_tvApi) {
        try { _tvApi.destroy(); } catch (_) {}
        _tvApi = null;
    }
    _tvReady = false;
    el.innerHTML = '';

    // Show loading
    const ov = document.getElementById('tabview-loading');
    if (ov) ov.style.display = 'flex';

    _tvApi = new alphaTab.AlphaTabApi(el, {
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

    // Mute alphaTab audio once score is loaded
    _tvApi.scoreLoaded.on(function (score) {
        if (score && score.tracks) {
            try { _tvApi.changeTrackMute(score.tracks, true); } catch (_) {}
        }
    });

    _tvApi.renderFinished.on(function () {
        _tvReady = true;
        const ov2 = document.getElementById('tabview-loading');
        if (ov2) ov2.style.display = 'none';
    });

    _tvApi.error.on(function (e) {
        console.error('[TabView] alphaTab error:', e);
    });

    // Load GP5 data
    _tvApi.load(new Uint8Array(arrayBuffer));
}

// ── Cursor sync ─────────────────────────────────────────────────────────

function _tvTimeToTick(seconds) {
    var beats = highway.getBeats();
    if (!beats || beats.length < 2) return 960;

    // Before first beat
    if (seconds < beats[0].time) return 960;

    // Find containing beat interval
    var idx = 0;
    for (var i = 0; i < beats.length - 1; i++) {
        if (seconds >= beats[i].time) idx = i;
        else break;
    }

    var frac = 0;
    if (idx < beats.length - 1) {
        var bStart = beats[idx].time;
        var bEnd = beats[idx + 1].time;
        if (bEnd > bStart) {
            frac = Math.min(1, Math.max(0, (seconds - bStart) / (bEnd - bStart)));
        }
    }

    return 960 + Math.round((idx + frac) * 960);
}

function _tvStartSync() {
    if (_tvSyncRAF) return;
    var lastTick = -1;
    var audio = document.getElementById('audio');

    function loop() {
        _tvSyncRAF = requestAnimationFrame(loop);
        if (!_tvApi || !_tvActive || !_tvReady) return;

        var tick = _tvTimeToTick(audio.currentTime);
        if (Math.abs(tick - lastTick) > 30) {
            lastTick = tick;
            try { _tvApi.tickPosition = tick; } catch (_) {}
        }
    }
    loop();
}

function _tvStopSync() {
    if (_tvSyncRAF) {
        cancelAnimationFrame(_tvSyncRAF);
        _tvSyncRAF = null;
    }
}

// ── Toggle tab view ─────────────────────────────────────────────────────

async function _tvToggle() {
    if (_tvActive) {
        // Back to highway
        _tvActive = false;
        _tvStopSync();
        if (_tvContainer) _tvContainer.style.display = 'none';
        document.getElementById('highway').style.visibility = '';
        _tvUpdateButton();
        return;
    }

    var beats = highway.getBeats();
    if (!beats || beats.length < 2) {
        // Song data not loaded yet
        return;
    }

    var btn = document.getElementById('btn-tabview');
    if (btn) btn.textContent = 'Loading\u2026';

    try {
        await _tvLoadScript();

        // Fetch GP5
        var filename = _tvFilename;
        var arrSel = document.getElementById('arr-select');
        var arrIdx = arrSel ? arrSel.value : 0;
        // filename may already be encoded from data-play attributes — decode first
        var decoded = decodeURIComponent(filename);
        var url = '/api/plugins/tabview/gp5/' + encodeURIComponent(decoded) + '?arrangement=' + arrIdx;
        var resp = await fetch(url);
        if (!resp.ok) throw new Error(await resp.text());
        var data = await resp.arrayBuffer();

        // Init alphaTab
        _tvCreateContainer();
        _tvSizeContainer();
        await _tvInit(data);

        // Show tab, hide highway
        _tvActive = true;
        document.getElementById('highway').style.visibility = 'hidden';
        _tvContainer.style.display = '';

        _tvCurrentFile = filename;
        _tvCurrentArr = arrIdx;
        _tvStartSync();
    } catch (e) {
        console.error('[TabView]', e);
        alert('Tab View error: ' + e.message);
    }

    _tvUpdateButton();
}

// ── Button ──────────────────────────────────────────────────────────────

function _tvUpdateButton() {
    var btn = document.getElementById('btn-tabview');
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
    var controls = document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-tabview')) return;

    var lyricsBtn = document.getElementById('btn-lyrics');
    var sep = lyricsBtn ? lyricsBtn.nextElementSibling : null;
    var insertBefore = sep || lyricsBtn ? lyricsBtn.nextSibling : null;

    var btn = document.createElement('button');
    btn.id = 'btn-tabview';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    btn.textContent = 'Tab View';
    btn.title = 'Toggle tablature notation view';
    btn.onclick = _tvToggle;
    controls.insertBefore(btn, insertBefore);
}

// ── Teardown ────────────────────────────────────────────────────────────

function _tvReset() {
    _tvActive = false;
    _tvStopSync();
    if (_tvContainer) _tvContainer.style.display = 'none';
    if (_tvApi) {
        try { _tvApi.destroy(); } catch (_) {}
        _tvApi = null;
    }
    _tvReady = false;
    document.getElementById('highway').style.visibility = '';
}

// ── Hooks ───────────────────────────────────────────────────────────────

(function () {
    // Hook playSong
    var origPlay = window.playSong;
    window.playSong = async function (filename, arrangement) {
        _tvFilename = filename;
        _tvReset();
        await origPlay(filename, arrangement);
        _tvInjectButton();
    };

    // Hook changeArrangement
    var origArr = window.changeArrangement;
    if (origArr) {
        window.changeArrangement = function (index) {
            if (_tvActive) _tvReset();
            _tvUpdateButton();
            origArr(index);
        };
    }

    // Re-size tab container when window resizes
    window.addEventListener('resize', _tvSizeContainer);
})();

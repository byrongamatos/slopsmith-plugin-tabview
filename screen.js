// Tab View plugin — renders Rocksmith arrangements as scrolling tablature via alphaTab.

let _tvActive = false;
let _tvDark = false;
let _tvApi = null;
let _tvContainer = null;
let _tvSyncRAF = null;
let _tvCurrentFile = null;
let _tvCurrentArr = null;
let _tvReady = false;
let _tvFilename = null; // captured from playSong hook
let _tvCursorStyle = "rect";
let _tvCursorColor = null;
const _tvStorageKey = 'tabview-settings';

// ── Cursor style presets ────────────────────────────────────────────────
// See CONTRIBUTING.md for how to add new cursor styles.
// NOTE: Color should always be in rgba(R, G, B, A) format

const _tvCursorStyles = {
    rect: {
        name: "Rectangle",
        defaultColor: 'rgba(34,211,238,0.9)',
        css: function (color) {
            const c = color || this.defaultColor;
            return {
                width: '24px',
                height: '24px',
                background: c.replace(/[\d.]+\)$/, '0.15)'),
                border: '2px solid ' + c,
                borderRadius: '4px',
                boxShadow: '0 0 0 1px ' + c.replace(/[\d.]+\)$/, '0.3)') + ',0 0 12px ' + c + ',0 0 24px ' + c.replace(/[\d.]+\)$/, '0.25)'),
            };
        },
        position: function (cursorRect, wrapRect, scrollLeft, scrollTop) {
            const size = Math.max(18, Math.min(36, Math.round(Math.max(cursorRect.width, cursorRect.height, 20))));
            return {
                x: cursorRect.left - wrapRect.left + scrollLeft + (cursorRect.width - size) / 2,
                y: cursorRect.top - wrapRect.top + scrollTop + (cursorRect.height - size) / 2,
                width: size + 'px',
                height: size + 'px',
            };
        },
    },
    line: {
        name: "Line",
        defaultColor: 'rgba(34,211,238,0.9)',
        css: function (color) {
            const c = color || this.defaultColor;
            return {
                width: '2px',
                height: '100%',
                background: c,
                border: 'none',
                borderRadius: '1px',
                boxShadow: '0 0 6px ' + c + ',0 0 12px ' + c,
            };
        },
        position: function (cursorRect, wrapRect, scrollLeft, scrollTop) {
            return {
                x: cursorRect.left - wrapRect.left + scrollLeft + (cursorRect.width / 2) - 1,
                y: cursorRect.top - wrapRect.top + scrollTop,
                width: '2px',
                height: Math.round(cursorRect.height) + 'px',
            };
        },
    },
};

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

    // Apply common style to highlight cursor and then apply user config
    const hl = document.createElement('div');
    hl.id = 'tabview-highlight';

    hl.style.cssText = [
        'position:absolute',
        'pointer-events:none',
        'z-index:999',
        'display:none',
        'top:0',
    ].join(';');
    _tvApplyCursorStyle(hl);
    c.appendChild(hl);
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
    if (canvas) { _tvContainer.style.top = '60px'; _tvContainer.style.height = (canvas.getBoundingClientRect().height - 60) + 'px'; }
}

// ── alphaTab init ───────────────────────────────────────────────────────

async function _tvInit(arrayBuffer) {
    const c = _tvCreateContainer();
    const el = document.getElementById('tabview-at');

    // Destroy previous
    if (_tvApi) {
        try { _tvApi.destroy(); } catch (_) { }
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
            try { _tvApi.changeTrackMute(score.tracks, true); } catch (_) { }
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
    var hl = document.getElementById('tabview-highlight');
    if (hl) hl.style.display = '';

    function loop() {
        _tvSyncRAF = requestAnimationFrame(loop);
        if (!_tvApi || !_tvActive || !_tvReady) return;

        var tick = _tvTimeToTick(audio.currentTime);
        if (Math.abs(tick - lastTick) > 30) {
            lastTick = tick;
            try { _tvApi.tickPosition = tick; } catch (_) { }
        }

        _tvUpdateHighlight();
    }
    loop();
}

function _tvStopSync() {
    if (_tvSyncRAF) {
        cancelAnimationFrame(_tvSyncRAF);
        _tvSyncRAF = null;
    }
    var hl = document.getElementById('tabview-highlight');
    if (hl) hl.style.display = 'none';
}

// ── Cursor Highlight Rendering and Auto Scroll ───────────────────────────

function _tvFindCursorRect() {
    var host = document.getElementById('tabview-at');
    if (!host) return null;
    var selectors = ['.at-cursor-beat', '.at-cursor-bar', '.at-cursor', '[class*="cursor"]'];
    var roots = [host];
    if (host.shadowRoot) roots.push(host.shadowRoot);
    for (var r = 0; r < roots.length; r++) {
        for (var s = 0; s < selectors.length; s++) {
            var nodes = roots[r].querySelectorAll(selectors[s]);
            for (var n = 0; n < nodes.length; n++) {
                var rect = nodes[n].getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return rect;
            }
        }
    }
    return null;
}

function _tvApplyCursorStyle(hl) {
    if (!hl) hl = document.getElementById('tabview-highlight');
    if (!hl) return;
    const style = _tvCursorStyles[_tvCursorStyle] || _tvCursorStyles.rect;
    Object.assign(hl.style, style.css(_tvCursorColor));
}

function _tvUpdateHighlight() {
    const hl = document.getElementById('tabview-highlight');
    if (!hl || !_tvContainer) return;

    const cursorRect = _tvFindCursorRect();
    if (!cursorRect) { hl.style.display = 'none'; return; }

    const wrapRect = _tvContainer.getBoundingClientRect();
    const style = _tvCursorStyles[_tvCursorStyle] || _tvCursorStyles.rect;
    const pos = style.position(cursorRect, wrapRect, _tvContainer.scrollLeft, _tvContainer.scrollTop);

    hl.style.left = Math.round(pos.x) + 'px';
    hl.style.top = Math.round(pos.y) + 'px';
    hl.style.width = pos.width;
    hl.style.height = pos.height;
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
        targetX = pos.x - wrapRect.width / 2;
        needScroll = true;
    }
    if (relY < paddingY || relY > wrapRect.height - paddingY) {
        targetY = pos.y - wrapRect.height / 2;
        needScroll = true;
    }

    if (needScroll) {
        _tvContainer.scrollTo({ left: targetX, top: targetY, behavior: 'auto' });
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

// ── Dark mode ───────────────────────────────────────────────────────────

function _tvApplyTheme(dark) {
    if (!_tvContainer) return;
    var at = document.getElementById('tabview-at');
    _tvContainer.style.background = dark ? '#000' : '#fff';
    if (at) at.style.filter = dark ? 'invert(1)' : '';
}

function _tvToggleDark() {
    _tvDark = !_tvDark;
    _tvApplyTheme(_tvDark);
    _tvUpdateDarkButton();
}

function _tvUpdateDarkButton() {
    var btn = document.getElementById('btn-tabview-dark');
    if (!btn) return;
    if (_tvDark) {
        btn.textContent = 'Light';
        btn.className = 'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
    } else {
        btn.textContent = 'Dark';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    }
}

// ── Button ──────────────────────────────────────────────────────────────

function _tvUpdateButton() {
    var btn = document.getElementById('btn-tabview');
    var darkBtn = document.getElementById('btn-tabview-dark');
    if (!btn) return;
    if (_tvActive) {
        btn.textContent = 'Highway';
        btn.className = 'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
        if (darkBtn) darkBtn.style.display = '';
    } else {
        btn.textContent = 'Tab View';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        if (darkBtn) darkBtn.style.display = 'none';
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

    var darkBtn = document.createElement('button');
    darkBtn.id = 'btn-tabview-dark';
    darkBtn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
    darkBtn.textContent = 'Dark';
    darkBtn.title = 'Toggle dark mode for tablature';
    darkBtn.style.display = 'none';
    darkBtn.onclick = _tvToggleDark;
    controls.insertBefore(darkBtn, btn.nextSibling);
}

// ── Teardown ────────────────────────────────────────────────────────────

function _tvReset() {
    _tvActive = false;
    _tvStopSync();
    if (_tvContainer) _tvContainer.style.display = 'none';
    if (_tvApi) {
        try { _tvApi.destroy(); } catch (_) { }
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

    // Populate settings UI once injected into DOM
    _tvLoadSettings();
    const _tvSettingsObserver = new MutationObserver(function () {
        _tvApplySettingsToUI();
        const s = document.getElementById('tabview-cursor-style');
        if (s && s.children.length > 0) _tvSettingsObserver.disconnect();
    });
    _tvSettingsObserver.observe(document.body, { childList: true, subtree: true });
})();

// ── Settings ────────────────────────────────────────────────────────────

function _tvLoadSettings() {
    try {
        const raw = localStorage.getItem(_tvStorageKey);
        if (!raw) return;
        const settings = JSON.parse(raw);
        if (settings.cursorStyle) _tvCursorStyle = settings.cursorStyle;
        if (settings.cursorColor) _tvCursorColor = settings.cursorColor;
    } catch (e) { /* localStorage unavailable */ }
}

function _tvPopulateCursorStyleSelect() {
    const select = document.getElementById('tabview-cursor-style');
    if (!select || select.children.length > 0) return;

    for (var key in _tvCursorStyles) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = _tvCursorStyles[key].name || key;
        select.appendChild(option);
    }

    select.value = _tvCursorStyle;
}

function _tvRgbaToHex(rgba) {
    const m = /^rgba\((\d{1,3}%?),\s*(\d{1,3}%?),\s*(\d{1,3}%?),\s*(\d*(?:\.\d+)?)\)$/.exec(rgba);

    if (!m) return null;

    // The alpha value is discarded
    const r = parseInt(m[1], 10), g = parseInt(m[2], 10), b = parseInt(m[3], 10);

    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function _tvApplySettingsToUI() {
    _tvPopulateCursorStyleSelect();

    const styleSelect = document.getElementById('tabview-cursor-style');
    if (styleSelect) styleSelect.value = _tvCursorStyle;

    const colorPicker = document.getElementById('tabview-cursor-color');
    if (colorPicker) colorPicker.value = _tvRgbaToHex(_tvCursorColor) || '#22d3ee';
}

function _tvSaveSettings() {
    try {
        localStorage.setItem(_tvStorageKey, JSON.stringify({
            cursorStyle: _tvCursorStyle,
            cursorColor: _tvCursorColor,
        }));
    } catch (e) { /* localStorage unavailable */ }
}

window.tvSelectCursorStyle = function (cursorStyle) {
    _tvCursorStyle = cursorStyle;
    _tvApplyCursorStyle();
    _tvSaveSettings();
};

window.tvSetCursorColor = function (color) {
    if (color && color.startsWith('#')) {
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        color = 'rgba(' + r + ',' + g + ',' + b + ',0.9)';
    }
    _tvCursorColor = color || null;
    _tvApplyCursorStyle();
    _tvSaveSettings();
};

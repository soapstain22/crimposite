//=============================================================================
// TAS.js
//=============================================================================

/*:
 * @plugindesc Tool-assisted speedrun tools: frame advance, slow-mo, savestates, input movies. Playtest only.
 *
 * @param Movie File
 * @desc Movie file name inside the project's tas/ folder.
 * @default movie.json
 *
 * @help
 * Only runs in Playtest (the "test" option). In a normal or Steam build it does nothing.
 *
 * Keys (none of these are game buttons):
 *   P            pause / unpause
 *   O            advance one frame (hold to keep advancing)
 *   - / =        slower / faster (1/8x .. 64x)
 *   N            new movie starting from right now (must be on the map, no message open)
 *   Shift+N      new movie starting from the title screen
 *   R            toggle read-only: playing <-> recording from the current frame
 *   L            load the movie file and play it from the start
 *   K            save the movie file
 *   End          stop the movie (back to normal play)
 *   Shift+1..9   set savestate 1..9 at the current frame
 *   1..9         load savestate 1..9
 *   H            hide / show the overlay
 *
 * While paused, hold game keys (arrows, Z, X...) and tap O to feed them into the
 * next frame. The movie file is one line per frame, so you can also edit inputs
 * in a text editor:
 *   columns  U D L R  A(ok) B(cancel) S(shift) M(menu) Q(pageup) W(pagedown) C(ctrl) T(tab) E(esc) G(debug)
 *   "...R A........"  = holding right and ok on that frame
 *   a mouse click adds " x,y,flags" (P pressed, T triggered, C cancelled, M moved, R released)
 *
 * How it stays in sync:
 * - Math.random is seeded, and the seed is stored in the movie.
 * - Time freezes while images or maps are loading, so slow loads can't shift frames.
 *   Those frozen frames are shown as "lag" and aren't part of the movie.
 * - A movie always starts by loading its start point the same way (title screen,
 *   or a snapshot of the game taken when you pressed N).
 * - Loading a savestate replays the movie from its start at max speed up to that
 *   frame. It's exact, but long movies take a moment to rewind. Start movies with N
 *   close to the part you're working on to keep them short.
 * Changing the game's data or save files can make an old movie desync.
 */

(function() {
    if (!Utils.isOptionValid('test')) return;

    var params = PluginManager.parameters('TAS');
    var NAME = params['Movie File'] || 'movie.json';

    // Movies live in the project's tas/ folder; in a plain browser, in localStorage.
    var Store = Utils.isNwjs() ? (function() {
        var fs = require('fs'), path = require('path');
        var dir = path.join(path.dirname(process.mainModule.filename), 'tas');
        var file = path.join(dir, NAME);
        return {
            exists: function() { return fs.existsSync(file); },
            read: function() { return fs.readFileSync(file, 'utf8'); },
            write: function(text) { if (!fs.existsSync(dir)) fs.mkdirSync(dir); fs.writeFileSync(file, text); }
        };
    })() : {
        exists: function() { return localStorage.getItem('TAS ' + NAME) !== null; },
        read: function() { return localStorage.getItem('TAS ' + NAME); },
        write: function(text) { localStorage.setItem('TAS ' + NAME, text); }
    };
    var SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];
    var ABBR = { up: 'U', down: 'D', left: 'L', right: 'R', ok: 'A', cancel: 'B', shift: 'S', menu: 'M',
                 pageup: 'Q', pagedown: 'W', control: 'C', tab: 'T', escape: 'E', debug: 'G' };

    var TAS = window.TAS = {
        mode: 'idle',       // idle | record | play
        paused: false,
        advance: 0,
        speed: 3,           // index into SPEEDS
        counting: true,     // false while a reset is waiting for its scene to start
        frame: 0,
        lag: 0,
        seekTo: null,
        resumeMode: null,
        movie: null,
        slots: {},
        keyDate: 0,
        touchDate: 0,
        overlay: true,
        message: '',
        messageTime: 0
    };

    //-------------------------------------------------------------------------
    // Seeded RNG

    var rngState = (Date.now() ^ 0x5eed) >>> 0;
    Math.random = function() {
        var t = rngState = (rngState + 0x6D2B79F5) | 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    //-------------------------------------------------------------------------
    // Main loop

    SceneManager.updateMain = function() {
        var newTime = this._getTimeInMsWithoutMobileSafari();
        var fTime = Math.min((newTime - this._currentTime) / 1000, 0.25);
        this._currentTime = newTime;
        if (TAS.seekTo !== null) {
            var budget = performance.now() + 40;
            while (TAS.seekTo !== null && performance.now() < budget) {
                if (!tick()) break; // waiting on a load; give it a real frame
            }
            this._accumulator = 0;
        } else if (TAS.paused) {
            // A frame advance always lands on a real frame. Loads finish asynchronously,
            // so if one is pending, keep the advance queued and retry next refresh.
            while (TAS.advance > 0 && tick()) TAS.advance--;
            this._accumulator = 0;
        } else {
            this._accumulator += fTime * SPEEDS[TAS.speed];
            var limit = performance.now() + 40;
            while (this._accumulator >= this._deltaTime) {
                tick();
                this._accumulator -= this._deltaTime;
                if (performance.now() > limit) { this._accumulator = 0; break; }
            }
        }
        this.renderScene();
        updateOverlay();
        this.requestUpdate();
    };

    // Graphics.frameCount drives playtime; count game frames, not renders.
    var _Graphics_render = Graphics.render;
    Graphics.render = function(stage) {
        var count = this.frameCount;
        _Graphics_render.call(this, stage);
        this.frameCount = count;
    };

    function isLoading() {
        var sm = SceneManager;
        if (sm.isSceneChanging() && !sm.isCurrentSceneBusy()) return false;
        if (sm._scene && !sm._sceneStarted) return !sm._scene.isReady();
        return !ImageManager.isReady();
    }

    // Runs one game frame. Returns false if time was frozen for loading (a lag frame).
    function tick() {
        var sm = SceneManager;
        if (!TAS.counting) {
            sm.changeScene();
            sm.updateScene();
            return false;
        }
        if (TAS.mode !== 'idle' && isLoading()) {
            TAS.lag++;
            return false;
        }
        if (TAS.mode === 'play') {
            if (TAS.frame >= TAS.movie.frames.length) {
                if (!TAS.paused) notify('Movie finished. R = keep recording from here, End = stop.');
                TAS.paused = true;
                TAS.advance = 0;
                SceneManager._accumulator = 0;
                return true;
            }
            applyInput(TAS.movie.frames[TAS.frame]);
        } else {
            sm.updateInputData();
            if (TAS.mode === 'record') {
                fixInputDates();
                TAS.movie.frames[TAS.frame] = captureInput();
                TAS.movie.frames.length = TAS.frame + 1;
            }
        }
        sm.changeScene();
        sm.updateScene();
        Graphics.frameCount++;
        TAS.frame++;
        if (TAS.seekTo !== null && TAS.frame >= TAS.seekTo) finishSeek();
        return true;
    }

    //-------------------------------------------------------------------------
    // Input capture / playback

    function buttonList() {
        var names = Object.keys(ABBR);
        [Input.keyMapper, Input.gamepadMapper].forEach(function(mapper) {
            for (var k in mapper) {
                if (names.indexOf(mapper[k]) < 0) names.push(mapper[k]);
            }
        });
        return names;
    }

    function captureInput() {
        var buttons = TAS.movie.buttons, s = '';
        for (var i = 0; i < buttons.length; i++) {
            s += Input._currentState[buttons[i]] ? (ABBR[buttons[i]] || 'x') : '.';
        }
        var t = TouchInput;
        var flags = (t.isPressed() ? 'P' : '') + (t._triggered ? 'T' : '') + (t._cancelled ? 'C' : '') +
                    (t._moved ? 'M' : '') + (t._released ? 'R' : '');
        if (flags || t._wheelX || t._wheelY) {
            s += ' ' + t._x + ',' + t._y + ',' + (flags || '-');
            if (t._wheelX || t._wheelY) s += ',' + t._wheelX + ',' + t._wheelY;
        }
        return s;
    }

    function applyInput(line) {
        line = line || '';
        var buttons = TAS.movie.buttons, state = {};
        // Every button gets an explicit true/false: Input.update only notices a release
        // for keys that are present in the state.
        for (var i = 0; i < buttons.length; i++) {
            state[buttons[i]] = !!line[i] && line[i] !== '.' && line[i] !== ' ';
        }
        Input._currentState = state;
        var poll = Input._pollGamepads;
        Input._pollGamepads = function() {};
        Input.update();
        Input._pollGamepads = poll;

        var t = TouchInput, touch = line.slice(buttons.length).trim().split(',');
        var flags = touch.length >= 3 ? touch[2] : '';
        if (touch.length >= 3) {
            t._x = +touch[0];
            t._y = +touch[1];
        }
        t._mousePressed = flags.indexOf('P') >= 0;
        t._screenPressed = false;
        t._events = {
            triggered: flags.indexOf('T') >= 0, cancelled: flags.indexOf('C') >= 0,
            moved: flags.indexOf('M') >= 0, released: flags.indexOf('R') >= 0,
            wheelX: +(touch[3] || 0), wheelY: +(touch[4] || 0)
        };
        t.update();
        fixInputDates();
    }

    // Windows compare Input.date with TouchInput.date; keep them frame-based, not wall-clock.
    var lastKeyDate = 0;
    function fixInputDates() {
        if (Input._date !== lastKeyDate) TAS.keyDate = TAS.frame * 2;
        if (TouchInput._triggered) TAS.touchDate = TAS.frame * 2 + 1;
        Input._date = lastKeyDate = TAS.keyDate;
        TouchInput._date = TAS.touchDate;
    }

    // Losing window focus clears input mid-frame, which can't be replayed. Only drop held keys.
    var _Input_onLostFocus = Input._onLostFocus;
    Input._onLostFocus = function() {
        if (TAS.mode === 'idle') _Input_onLostFocus.call(this);
        else this._currentState = {};
    };

    //-------------------------------------------------------------------------
    // Resetting to a movie's start point

    function Scene_TasReset() {
        this.initialize.apply(this, arguments);
    }
    Scene_TasReset.prototype = Object.create(Scene_Base.prototype);
    Scene_TasReset.prototype.constructor = Scene_TasReset;
    Scene_TasReset.prototype.start = function() {
        Scene_Base.prototype.start.call(this);
        beginMovieTime();
    };

    function hardReset() {
        var sm = SceneManager;
        if (sm._scene) {
            try { sm._scene.terminate(); } catch (e) { console.warn('TAS reset:', e); }
            sm._scene.detachReservation();
            sm._previousClass = sm._scene.constructor;
        }
        sm._stack = [];
        sm._nextScene = null;
        sm._scene = new Scene_TasReset();
        sm._scene.attachReservation();
        sm._scene.create();
        sm._sceneStarted = false;
        sm.onSceneCreate();
        AudioManager.stopAll();
        TAS.counting = false;
    }

    function beginMovieTime() {
        var movie = TAS.movie, start = movie.start;
        DataManager.createGameObjects();
        if (start.type === 'save') {
            DataManager.extractSaveContents(JsonEx.parse(start.data));
            $gameSystem.onAfterLoad();
            if ($gameSystem.versionId() !== $dataSystem.versionId) {
                $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y);
                $gamePlayer.requestMapReload();
            }
            SceneManager.goto(Scene_Map);
        } else {
            Graphics.frameCount = 0;
            SceneManager.goto(Scene_Title);
        }
        Window_TitleCommand.initCommandPosition();
        Window_MenuCommand.initCommandPosition();
        ConfigManager.applyData(movie.config);
        rngState = movie.seed >>> 0;
        Input.clear();
        TouchInput.clear();
        TAS.keyDate = TAS.touchDate = lastKeyDate = 0;
        TAS.frame = 0;
        TAS.lag = 0;
        TAS.counting = true;
        if (TAS.seekTo === 0) finishSeek();
    }

    function seek(target, modeAfter) {
        TAS.resumeMode = modeAfter;
        TAS.mode = 'play';
        TAS.seekTo = target;
        hardReset();
    }

    function finishSeek() {
        TAS.seekTo = null;
        TAS.mode = TAS.resumeMode;
        TAS.paused = true;
        TAS.advance = 0;
        notify('Paused at frame ' + TAS.frame + ' (P to run, O to step)');
    }

    //-------------------------------------------------------------------------
    // Movies

    function canSnapshot() {
        var scene = SceneManager._scene;
        return scene instanceof Scene_Map && SceneManager._sceneStarted && !SceneManager.isSceneChanging() &&
               !$gameMessage.isBusy() && !$gamePlayer.isTransferring();
    }

    function newMovie(fromTitle) {
        if (!DataManager.isDatabaseLoaded() || SceneManager._scene instanceof Scene_Boot) return;
        var start;
        if (fromTitle) {
            start = { type: 'title' };
        } else {
            if (!canSnapshot()) return notify('Go to the map and close any message first.');
            var saveCount = $gameSystem._saveCount;
            $gameSystem.onBeforeSave();
            $gameSystem._saveCount = saveCount; // don't count the snapshot as a save
            start ={ type: 'save', map: $gameMap.mapId(), data: JsonEx.stringify(DataManager.makeSaveContents()) };
        }
        TAS.movie = {
            version: 1,
            created: new Date().toISOString(),
            start: start,
            seed: (Math.random() * 4294967296) >>> 0,
            config: ConfigManager.makeData(),
            buttons: buttonList(),
            rerecords: 0,
            savestates: {},
            frames: []
        };
        TAS.slots = {};
        seek(0, 'record');
        notify('Recording new movie from ' + (fromTitle ? 'the title screen' : 'here'));
    }

    function saveMovie() {
        if (!TAS.movie) return notify('No movie to save.');
        var m = TAS.movie, head = [];
        m.savestates = {};
        for (var n in TAS.slots) m.savestates[n] = TAS.slots[n].frame;
        for (var k in m) {
            if (k !== 'frames') head.push(JSON.stringify(k) + ': ' + JSON.stringify(m[k]));
        }
        var text = '{\n' + head.join(',\n') + ',\n"frames": [\n' + m.frames.map(function(f) {
            return JSON.stringify(f);
        }).join(',\n') + '\n]\n}\n';
        Store.write(text);
        notify('Saved ' + m.frames.length + ' frames to tas/' + NAME);
    }

    function loadMovie() {
        if (!Store.exists()) return notify('No movie at tas/' + NAME);
        try {
            TAS.movie = JSON.parse(Store.read());
        } catch (e) {
            return notify('Movie file is broken: ' + e.message);
        }
        TAS.slots = {};
        var states = TAS.movie.savestates || {};
        for (var n in states) TAS.slots[n] = { frame: states[n] };
        seek(0, 'play');
        notify('Playing ' + TAS.movie.frames.length + ' frames');
    }

    function stopMovie() {
        if (TAS.mode === 'record') saveMovie();
        TAS.mode = 'idle';
        TAS.seekTo = null;
        notify('Movie stopped');
    }

    function toggleReadOnly() {
        if (!TAS.movie || TAS.mode === 'idle') return notify('No movie. N = new, L = load.');
        if (TAS.mode === 'play') {
            TAS.mode = 'record';
            TAS.movie.frames.length = Math.min(TAS.movie.frames.length, TAS.frame);
            TAS.movie.rerecords++;
            notify('Recording from frame ' + TAS.frame);
        } else {
            TAS.mode = 'play';
            notify('Read-only');
        }
    }

    function setSlot(n) {
        if (!TAS.movie || TAS.mode === 'idle') return notify('Savestates need a movie. N = new, L = load.');
        TAS.slots[n] = { frame: TAS.frame, frames: TAS.movie.frames.slice(0, TAS.frame) };
        notify('Savestate ' + n + ' = frame ' + TAS.frame);
    }

    function loadSlot(n) {
        var slot = TAS.slots[n];
        if (!slot) return notify('Savestate ' + n + ' is empty');
        if (TAS.mode === 'record') {
            TAS.movie.frames = (slot.frames || TAS.movie.frames.slice(0, slot.frame)).slice();
            TAS.movie.rerecords++;
        } else if (slot.frame > TAS.movie.frames.length) {
            return notify('Savestate ' + n + ' is past the end of this movie');
        }
        seek(slot.frame, TAS.mode);
        notify('Rewinding to frame ' + slot.frame + '...');
    }

    //-------------------------------------------------------------------------
    // Hotkeys

    document.addEventListener('keydown', function(event) {
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        var code = event.keyCode, handled = true;
        if (code >= 49 && code <= 57) {
            if (event.shiftKey) setSlot(code - 48); else loadSlot(code - 48);
        } else if (code === 80) {                 // P
            TAS.paused = !TAS.paused;
            TAS.advance = 0;
        } else if (code === 79) {                 // O
            TAS.paused = true;
            if (TAS.seekTo === null) TAS.advance++;
        } else if (code === 189 || code === 173) { // -
            TAS.speed = Math.max(0, TAS.speed - 1);
        } else if (code === 187 || code === 61) {  // =
            TAS.speed = Math.min(SPEEDS.length - 1, TAS.speed + 1);
        } else if (code === 78) {                 // N
            newMovie(event.shiftKey);
        } else if (code === 82) {                 // R
            toggleReadOnly();
        } else if (code === 76) {                 // L
            loadMovie();
        } else if (code === 75) {                 // K
            saveMovie();
        } else if (code === 35) {                 // End
            stopMovie();
        } else if (code === 72) {                 // H
            TAS.overlay = !TAS.overlay;
        } else {
            handled = false;
        }
        if (handled) event.preventDefault();
    });

    //-------------------------------------------------------------------------
    // Overlay

    var overlay = null;
    function notify(text) {
        TAS.message = text;
        TAS.messageTime = performance.now();
        console.log('[TAS] ' + text);
    }

    function updateOverlay() {
        if (!overlay) {
            if (!document.body) return;
            overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;left:4px;top:4px;z-index:100;pointer-events:none;' +
                'font:12px/1.35 monospace;color:#fff;background:rgba(0,0,0,0.6);padding:3px 6px;white-space:pre;';
            document.body.appendChild(overlay);
        }
        overlay.style.display = TAS.overlay ? '' : 'none';
        if (!TAS.overlay) return;
        var mode = TAS.seekTo !== null ? 'SEEK ' + TAS.frame + '/' + TAS.seekTo :
                   { idle: 'no movie', record: 'REC', play: 'PLAY' }[TAS.mode];
        var speed = SPEEDS[TAS.speed];
        var lines = [mode + '  frame ' + TAS.frame + (TAS.mode !== 'idle' ? '  lag ' + TAS.lag : '') +
                     '  ' + (speed < 1 ? '1/' + (1 / speed) : speed) + 'x' + (TAS.paused ? '  PAUSED' : '')];
        if (TAS.movie && TAS.mode !== 'idle') {
            var shown = TAS.mode === 'play' ? TAS.movie.frames[TAS.frame] : TAS.movie.frames[TAS.frame - 1];
            lines.push('length ' + TAS.movie.frames.length + '  rerecords ' + TAS.movie.rerecords +
                       '  input ' + (shown === undefined ? '-' : shown));
        }
        if (TAS.message && performance.now() - TAS.messageTime < 4000) lines.push(TAS.message);
        overlay.textContent = lines.join('\n');
    }
})();

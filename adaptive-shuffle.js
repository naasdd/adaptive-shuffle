// NAME: Adaptive Shuffle
// AUTHOR: joseg
// DESCRIPTION: Shuffle inteligente que aprende seu comportamento - musicas que vc ama tocam mais, as que vc sempre pula somem.

(function adaptiveShuffle() {
    if (!(Spicetify.Player && Spicetify.Platform && Spicetify.LocalStorage)) {
        setTimeout(adaptiveShuffle, 300);
        return;
    }

    const { Player, Platform, LocalStorage, React } = Spicetify;
    const { Type } = Spicetify.URI;
    const VERSION = "1.0.0";
    const STORE_KEY = "adaptiveShuffle:tracks";
    const SETTINGS_KEY = "adaptiveShuffle:settings";

    const DEFAULT_SETTINGS = {
        learning: true,
        aggressiveness: "normal",
        skipThreshold: 0.25,
        fullPlayThreshold: 0.80,
        heavySkipThreshold: 0.10,
        minListenMs: 3000,
        decay: 0.9,
        clamp: 10,
        pollIntervalMs: 15000,
    };

    const DELTAS = {
        leve:    { full: 1.0,  skip: -1.0,  heavySkip: -1.5,  queueAdd: 1.5,  pick: 1.0  },
        normal: { full: 2.0,  skip: -2.0,  heavySkip: -3.0,  queueAdd: 3.0,  pick: 2.0  },
        intenso: { full: 3.0,  skip: -3.0,  heavySkip: -5.0,  queueAdd: 5.0,  pick: 3.0  },
    };

    var settings = loadSettings();
    var tracks = {};
    var knownQueuedUris = {};
    var lastUri = null, lastProgressMs = 0, lastDurationMs = 0;
    var prevQueuedUris = {};

    function loadSettings() {
        try {
            var s = JSON.parse(LocalStorage.get(SETTINGS_KEY) || "null");
            if (s && typeof s === "object") return Object.assign({}, DEFAULT_SETTINGS, s);
        } catch (e) {}
        var def = Object.assign({}, DEFAULT_SETTINGS);
        LocalStorage.set(SETTINGS_KEY, JSON.stringify(def));
        return def;
    }

    function saveSettings() { LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings)); }
    function loadTracks() {
        try { var t = JSON.parse(LocalStorage.get(STORE_KEY) || "null"); if (t && typeof t === "object") return t; } catch (e) {}
        return {};
    }
    function saveTracks() {
        try {
            var keys = Object.keys(tracks);
            if (keys.length > 3000) {
                var entries = keys.map(function(k) { return [k, tracks[k]]; });
                entries.sort(function(a, b) { return (Math.abs(b[1].s) + b[1].p) - (Math.abs(a[1].s) + a[1].p); });
                for (var i = 3000; i < entries.length; i++) delete tracks[entries[i][0]];
            }
            LocalStorage.set(STORE_KEY, JSON.stringify(tracks));
        } catch (e) {}
    }

    tracks = loadTracks();

    function getTrack(uri) {
        if (!tracks[uri]) tracks[uri] = { s: 0, p: 0, sk: 0, q: 0, pk: 0, t: Date.now() };
        return tracks[uri];
    }

    function classifyListened(ratio, listenedMs) {
        if (listenedMs < settings.minListenMs) return null;
        if (ratio >= settings.fullPlayThreshold) return "full";
        if (ratio < settings.heavySkipThreshold) return "heavySkip";
        if (ratio < settings.skipThreshold) return "skip";
        return "partial";
    }

    function getDelta(kind) {
        var d = DELTAS[settings.aggressiveness] || DELTAS.normal;
        return d[kind] || 0;
    }

    function recordEvent(uri, kind) {
        if (!settings.learning) return;
        var t = getTrack(uri);
        switch (kind) {
            case "full": t.p++; break;
            case "skip": case "heavySkip": t.sk++; break;
            case "queueAdd": t.q++; break;
            case "pick": t.pk++; break;
        }
        t.s = t.s * settings.decay + getDelta(kind);
        if (t.s > settings.clamp) t.s = settings.clamp;
        if (t.s < -settings.clamp) t.s = -settings.clamp;
        t.t = Date.now();
        saveTracks();
    }

    function weightFromScore(score) {
        return Math.pow(2, score / 3);
    }

    function weightedShuffle(uris) {
        var items = uris.map(function(uri) {
            return { uri: uri, w: weightFromScore(getTrack(uri).s) };
        });
        var result = [];
        while (items.length > 0) {
            var total = 0;
            for (var i = 0; i < items.length; i++) total += items[i].w;
            var r = Math.random() * total;
            var idx = 0;
            for (var i = 0; i < items.length; i++) {
                r -= items[i].w;
                if (r <= 0) { idx = i; break; }
                idx = i;
            }
            result.push(items[idx].uri);
            items.splice(idx, 1);
        }
        return result;
    }

    // --- TRACKER ---

    Player.addEventListener("onprogress", function() {
        try { lastProgressMs = Player.getProgress(); } catch (e) {}
    });

    Player.addEventListener("songchange", function() {
        try {
            if (lastUri && lastDurationMs > 0) {
                var ratio = lastProgressMs / lastDurationMs;
                var kind = classifyListened(ratio, lastProgressMs);
                if (kind) recordEvent(lastUri, kind);
            }

            var data = Player.data;
            if (data && data.item) {
                lastUri = data.item.uri;
                lastDurationMs = data.duration;
                lastProgressMs = 0;
            }

            // check for queue adds
            var qs = getQueueState();
            var cur = qs.queued;
            for (var i = 0; i < cur.length; i++) {
                if (!prevQueuedUris[cur[i]]) recordEvent(cur[i], "queueAdd");
            }
            var newPrev = {};
            for (var i = 0; i < cur.length; i++) newPrev[cur[i]] = true;
            prevQueuedUris = newPrev;
        } catch (e) {}
    });

    setInterval(function() {
        try {
            if (!settings.learning) return;
            var qs = getQueueState();
            var cur = qs.queued;
            for (var i = 0; i < cur.length; i++) {
                if (!prevQueuedUris[cur[i]]) recordEvent(cur[i], "queueAdd");
            }
            var newPrev = {};
            for (var i = 0; i < cur.length; i++) newPrev[cur[i]] = true;
            prevQueuedUris = newPrev;
        } catch (e) {}
    }, settings.pollIntervalMs);

    function getQueueState() {
        try {
            var qs = Platform.PlayerAPI._queue._queueState;
            return {
                nextUp: (qs.nextUp || []).map(function(t) { return t.uri; }),
                queued: (qs.queued || []).map(function(t) { return t.uri; })
            };
        } catch (e) { return { nextUp: [], queued: [] }; }
    }

    // --- QUEUE API ---

    async function adaptiveReshuffleCurrentQueue() {
        try {
            var qs = getQueueState();
            var upcoming = qs.nextUp;
            if (upcoming.length < 2) {
                notify("Fila pequena demais para embaralhar");
                return;
            }
            var shuffled = weightedShuffle(upcoming);
            await setQueueFromUris(shuffled, true, null);
            notify("Fila reordenada: " + shuffled.length + " musicas");
        } catch (e) {
            console.error("[AS]", e);
            notify("Erro ao reordenar", true);
        }
    }

    async function playAdaptive(uris, contextUri) {
        if (!uris || uris.length === 0) { notify("Nada para tocar"); return; }
        var shuffled = weightedShuffle(uris);
        await setQueueFromUris(shuffled, false, contextUri);
        Player.next();
        notify("Tocando " + shuffled.length + " musicas");
    }

    async function setQueueFromUris(uris, keepCurrent, contextUri) {
        var list = uris.slice();
        list.push("spotify:delimiter");
        var q = Platform.PlayerAPI._queue;
        var _queue = q._queue;
        var _client = q._client;
        var nextTracks = list.map(function(uri) {
            return { contextTrack: { uri: uri, uid: "", metadata: { is_queued: "false" } }, removed: [], blocked: [], provider: "context" };
        });
        _client.setQueue({ nextTracks: nextTracks, prevTracks: _queue.prevTracks, queueRevision: _queue.queueRevision });
        if (contextUri) {
            var sessionId = Platform.PlayerAPI.getState().sessionId;
            Platform.PlayerAPI.updateContext(sessionId, { uri: contextUri, url: "context://" + contextUri });
        }
    }

    // --- FETCH ---

    async function fetchPlaylistTracks(uri) {
        var res = await Platform.PlaylistAPI.getContents(uri, { limit: 9999999 });
        return res.items.filter(function(t) { return t.isPlayable; }).map(function(t) { return t.uri; });
    }

    async function fetchAlbumTracks(uri) {
        var q = Spicetify.GraphQL.Definitions.queryAlbumTracks;
        var res = await Spicetify.GraphQL.Request(q, { uri: uri, offset: 0, limit: 100 });
        if (res.errors) throw res.errors[0].message;
        var items = (res.data.albumUnion && (res.data.albumUnion.tracksV2 || res.data.albumUnion.tracks) || {}).items || [];
        return items.filter(function(i) { return i.track.playability.playable; }).map(function(i) { return i.track.uri; });
    }

    async function fetchArtistTracks(uri) {
        var q = Spicetify.GraphQL.Definitions.queryArtistOverview;
        var res = await Spicetify.GraphQL.Request(q, { uri: uri, locale: Spicetify.Locale.getLocale(), includePrerelease: false });
        if (res.errors) throw res.errors[0].message;
        return res.data.artistUnion.discography.topTracks.items.map(function(i) { return i.track.uri; });
    }

    async function fetchLikedTracks() {
        var res = await Platform.LibraryAPI.getTracks({ limit: 9999999 });
        return res.items.filter(function(t) { return t.isPlayable; }).map(function(t) { return t.uri; });
    }

    function notify(msg) {
        try { Spicetify.showNotification(msg, false, 4000); } catch (e) { notify(msg); }
    }

    // Helper: pega URI da faixa atual (tenta data.item, data.track, e Queue.track)
    function getCurrentTrackUri() {
        var data = Player.data;
        if (data) {
            if (data.item && data.item.uri) return data.item.uri;
            if (data.track && data.track.uri) return data.item ? data.item.uri : data.track.uri;
        }
        try {
            var q = Spicetify.Queue;
            if (q && q.track && q.track.uri) return q.track.uri;
        } catch (e) {}
        try {
            var qs = Platform.PlayerAPI._queue._queueState;
            if (qs && qs.current && qs.current.uri) return qs.current.uri;
        } catch (e) {}
        return null;
    }

    var btnShuffle = new Spicetify.Playbar.Button(
        "Adaptive Shuffle",
        "shuffle",
        function(self) {
            self.active = true;
            adaptiveReshuffleCurrentQueue().then(function() {
                self.active = false;
            }).catch(function(e) {
                self.active = false;
                notify("Erro ao reordenar: " + e);
            });
        },
        false, false
    );
    btnShuffle.register();

    var btnScore = new Spicetify.Playbar.Button(
        "Score",
        "enhance",
        function(self) {
            self.active = true;
            var uri = getCurrentTrackUri();
            if (!uri) {
                notify("Nao foi possivel detectar a musica atual");
                self.active = false;
                return;
            }
            var t = tracks[uri];
            if (!t) {
                notify("Faixa ainda nao avaliada. Continue ouvindo!");
                self.active = false;
                return;
            }
            notify("Score " + t.s.toFixed(1) + "  plays:" + t.p + " skips:" + t.sk + " queue:" + t.q);
            self.active = false;
        },
        false, false
    );
    btnScore.register();

    var btnBoost = new Spicetify.Playbar.Button(
        "Turbinar",
        "heart-active",
        function(self) {
            self.active = true;
            var uri = getCurrentTrackUri();
            if (!uri) {
                notify("Nao foi possivel detectar a musica atual");
                self.active = false;
                return;
            }
            var t = getTrack(uri);
            t.s = Math.min(t.s + 5, settings.clamp);
            t.pk++;
            t.t = Date.now();
            saveTracks();
            notify("Turbinada! Score " + t.s.toFixed(1));
            self.active = false;
        },
        false, false
    );
    btnBoost.register();

    var btnAvoid = new Spicetify.Playbar.Button(
        "Evitar",
        "block",
        function(self) {
            self.active = true;
            var uri = getCurrentTrackUri();
            if (!uri) {
                notify("Nao foi possivel detectar a musica atual");
                self.active = false;
                return;
            }
            var t = getTrack(uri);
            t.s = Math.max(t.s - 5, -settings.clamp);
            t.sk++;
            t.t = Date.now();
            saveTracks();
            notify("Evitada! Score " + t.s.toFixed(1));
            self.active = false;
        },
        false, false
    );
    btnAvoid.register();

    var btnConfig = new Spicetify.Playbar.Button(
        "Config",
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.249 2.506a.75.75 0 0 1 1.502 0v.51a3.5 3.5 0 0 1 1.198.496l.367-.367a.75.75 0 1 1 1.06 1.06l-.367.367a3.5 3.5 0 0 1 .496 1.198h.51a.75.75 0 0 1 0 1.502h-.51a3.5 3.5 0 0 1-.496 1.198l.367.367a.75.75 0 1 1-1.06 1.06l-.367-.367a3.5 3.5 0 0 1-1.198.496v.51a.75.75 0 0 1-1.502 0v-.51a3.5 3.5 0 0 1-1.198-.496l-.367.367a.75.75 0 0 1-1.06-1.06l.367-.367a3.5 3.5 0 0 1-.496-1.198h-.51a.75.75 0 0 1 0-1.502h.51a3.5 3.5 0 0 1 .496-1.198l-.367-.367a.75.75 0 0 1 1.06-1.06l.367.367a3.5 3.5 0 0 1 1.198-.496V2.506zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
        function(self) {
            self.active = true;
            try {
                openSettings();
            } catch(e) {
                notify("Erro ao abrir configuracoes: " + e);
            }
            setTimeout(function() { self.active = false; }, 500);
        }, false, false
    );
    btnConfig.register();

    // --- UI: CONTEXT MENU (playlist/album/artist only - known working) ---

    new Spicetify.ContextMenu.Item(
        "Tocar com Adaptive Shuffle",
        async function(uris) {
            try {
                var raw = uris[0];
                var uriObj = Spicetify.URI.fromString(raw);
                var id = uriObj._base62Id || uriObj.id;
                var list, context = raw;
                switch (uriObj.type) {
                    case Type.PLAYLIST: case Type.PLAYLIST_V2: list = await fetchPlaylistTracks(raw); break;
                    case Type.ALBUM: list = await fetchAlbumTracks(raw); break;
                    case Type.ARTIST: list = await fetchArtistTracks(raw); break;
                    default: notify("Selecione uma playlist, album ou artista"); return;
                }
                if (!list || !list.length) { notify("Nada para tocar"); return; }
                await playAdaptive(list, context);
            } catch (e) { notify("Erro", true); }
        },
        function(uris) {
            if (uris.length !== 1) return false;
            try { var t = Spicetify.URI.fromString(uris[0]).type; return [Type.PLAYLIST, Type.PLAYLIST_V2, Type.ALBUM, Type.ARTIST].indexOf(t) !== -1; }
            catch (e) { return false; }
        },
        "shuffle"
    ).register();

    // --- UI: MENU & SETTINGS ---

    function openSettings() {
        var entries = Object.keys(tracks).map(function(k) { return [k, tracks[k]]; });
        entries.sort(function(a, b) { return b[1].s - a[1].s; });
        var count = entries.length;

        var style = React.createElement("style", null,
            ".as-row{display:flex;padding:10px 0;align-items:center}" +
            ".as-label{flex:1;color:var(--spice-text)}" +
            ".as-action{margin-left:15px}" +
            ".as-divider{height:2px;border:0;background:var(--spice-button-disabled);margin:8px 0}" +
            ".as-stat{padding:4px 0;color:var(--spice-subtext)}" +
            ".as-track-item{display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)}" +
            ".as-track-name{flex:1;color:var(--spice-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}" +
            ".as-bar{width:80px;height:6px;background:var(--spice-card);border-radius:3px;margin:0 8px;overflow:hidden}" +
            ".as-bar-fill{height:100%;border-radius:3px}" +
            ".as-score{width:32px;text-align:right;color:var(--spice-subtext);font-size:12px}" +
            "button.as-btn{border:0;border-radius:8px;background:var(--spice-button);color:var(--spice-text);cursor:pointer;padding:8px 14px}" +
            "button.as-danger{background:#e22134}" +
            "select.as-select{color:var(--spice-text);background:var(--spice-card);border:0;height:32px;border-radius:6px}" +
            ".as-toggle{width:44px;height:24px;border-radius:12px;background:var(--spice-button-disabled);position:relative;cursor:pointer;transition:background .2s}" +
            ".as-toggle.on{background:var(--spice-button)}" +
            ".as-toggle::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s}" +
            ".as-toggle.on::after{transform:translateX(20px)}"
        );

        function buildList(arr, n) {
            return arr.slice(0, n).map(function(e) {
                var uri = e[0], track = e[1];
                var name = uri.split(":").pop() || uri;
                var ratio = (track.s + settings.clamp) / (2 * settings.clamp);
                var pct = Math.round(ratio * 100);
                var color = ratio >= 0.5 ? "#1ed760" : "#e22134";
                return React.createElement("div", { key: uri, className: "as-track-item" },
                    React.createElement("span", { className: "as-track-name", title: uri }, name),
                    React.createElement("div", { className: "as-bar" },
                        React.createElement("div", { className: "as-bar-fill", style: { width: pct + "%", background: color } })
                    ),
                    React.createElement("span", { className: "as-score" }, track.s.toFixed(1))
                );
            });
        }

        var sortedAsc = entries.slice().sort(function(a, b) { return a[1].s - b[1].s; });
        var topFav = buildList(entries, 15);
        var topAvo = buildList(sortedAsc, 15);

        var content = React.createElement("div", null,
            style,
            React.createElement("h3", { style: { color: "var(--spice-text)" } }, "Aprendizado"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Aprendizado: " + (settings.learning ? "LIGADO" : "DESLIGADO")),
                React.createElement("div", { className: "as-action" },
                    React.createElement("button", {
                        className: "as-btn",
                        onClick: function() {
                            settings.learning = !settings.learning;
                            saveSettings();
                            Spicetify.PopupModal.hide();
                            notify("Aprendizado " + (settings.learning ? "LIGADO" : "DESLIGADO"));
                            openSettings();
                        }
                    }, settings.learning ? "Desligar" : "Ligar")
                )
            ),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Agressividade: " + settings.aggressiveness.toUpperCase()),
                React.createElement("div", { className: "as-action" },
                    React.createElement("select", {
                        className: "as-select",
                        value: settings.aggressiveness,
                        onChange: function(e) {
                            settings.aggressiveness = e.target.value;
                            saveSettings();
                            Spicetify.PopupModal.hide();
                            notify("Agressividade: " + e.target.value);
                            openSettings();
                        }
                    },
                        React.createElement("option", { value: "leve" }, "Leve"),
                        React.createElement("option", { value: "normal" }, "Normal"),
                        React.createElement("option", { value: "intenso" }, "Intenso")
                    )
                )
            ),

            React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Estatisticas"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-stat" }, "Faixas conhecidas: " + count),
            React.createElement("div", { className: "as-stat" }, "Mais amadas (top 15)"),
            React.createElement("div", null, topFav),
            React.createElement("div", { className: "as-stat", style: { marginTop: "8px" } }, "Mais evitadas (top 15)"),
            React.createElement("div", null, topAvo),
            React.createElement("div", { className: "as-stat", style: { marginTop: "6px", fontSize: "12px" } },
                "Dica: use os botoes na barra do player para turbinar/evitar/ver score da musica tocando"
            ),

            React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Acoes"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Apagar tudo e comecar do zero"),
                React.createElement("div", { className: "as-action" },
                    React.createElement("button", {
                        className: "as-btn as-danger",
                        onClick: function() { tracks = {}; saveTracks(); Spicetify.PopupModal.hide(); notify("Historico apagado!"); }
                    }, "Resetar")
                )
            ),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, count + " faixas conhecidas. Reordenar fila:"),
                React.createElement("div", { className: "as-action" },
                    React.createElement("button", {
                        className: "as-btn",
                        onClick: function() { adaptiveReshuffleCurrentQueue(); }
                    }, "Embaralhar")
                )
            )
        );

        Spicetify.PopupModal.display({ title: "Adaptive Shuffle", content: content, isLarge: true });
    }

    // --- MENU & SETTINGS (com fallback no botao) ---
    try {
        if (Spicetify.Menu && Spicetify.Menu.Item) {
            new Spicetify.Menu.Item("Adaptive Shuffle", false, openSettings).register();
        }
    } catch (e) {
        console.error("[AS] Menu indisponivel - use botao direito no botao Adaptive Shuffle");
    }

    // --- INIT ---

    var init = function() {
        try {
            var d = Player.data;
            if (d && d.item) { lastUri = d.item.uri; lastDurationMs = d.duration; }
            var qs = getQueueState();
            var p = {};
            for (var i = 0; i < qs.queued.length; i++) p[qs.queued[i]] = true;
            prevQueuedUris = p;
        } catch (e) {}
    };
    init();

    window.AdaptiveShuffle = {
        version: VERSION, settings: settings, tracks: tracks,
        getTrack: getTrack, recordEvent: recordEvent, weightedShuffle: weightedShuffle,
        reshuffle: adaptiveReshuffleCurrentQueue, playAdaptive: playAdaptive, openSettings: openSettings,
        _resetTracking: function() {
            try {
                var d = Player.data;
                if (d && d.item) { lastUri = d.item.uri; lastDurationMs = d.duration; }
                lastProgressMs = 0;
            } catch (e) {}
        }
    };

    console.log("[Adaptive Shuffle v" + VERSION + "] carregado. " + Object.keys(tracks).length + " faixas.");
})();
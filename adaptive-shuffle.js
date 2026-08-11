// NAME: Adaptive Shuffle
// AUTHOR: joseg
// DESCRIPTION: Shuffle inteligente que aprende seu comportamento - musicas que vc ama tocam mais, as que vc sempre pula somem.

(function adaptiveShuffle() {
    if (!(Spicetify.Player && Spicetify.Platform && Spicetify.LocalStorage)) {
        setTimeout(adaptiveShuffle, 300);
        return;
    }

    const { Player, Platform, LocalStorage } = Spicetify;
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
        pollIntervalMs: 15000,
    };

    const AGGRESSIVENESS = {
        leve:    { clamp: 20, weightDiv: 3,  full: 1.0,  skip: -1.0,  heavySkip: -1.5,  queueAdd: 1.5,  pick: 1.0  },
        normal: { clamp: 35, weightDiv: 2,  full: 2.0,  skip: -2.0,  heavySkip: -3.0,  queueAdd: 3.0,  pick: 2.0  },
        intenso: { clamp: 50, weightDiv: 1.2, full: 3.0, skip: -3.0, heavySkip: -5.0, queueAdd: 5.0, pick: 3.0 },
    };

    function agg() { return AGGRESSIVENESS[settings.aggressiveness] || AGGRESSIVENESS.normal; }

    var settings = loadSettings();
    var tracks = {};
    var knownQueuedUris = {};
    var lastUri = null, lastTrackName = "", lastProgressMs = 0, lastDurationMs = 0;
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
        if (!tracks[uri]) tracks[uri] = { s: 0, p: 0, sk: 0, q: 0, pk: 0, t: Date.now(), n: "" };
        return tracks[uri];
    }

    function getCurrentTrackName() {
        try {
            var data = Player.data;
            if (data) {
                if (data.item) {
                    if (data.item.name) return data.item.name;
                    if (data.item.metadata && data.item.metadata.title) return data.item.metadata.title;
                }
                if (data.track) {
                    if (data.track.name) return data.track.name;
                    if (data.track.metadata && data.track.metadata.title) return data.track.metadata.title;
                }
            }
        } catch (e) {}
        return "";
    }

    function classifyListened(ratio, listenedMs) {
        if (listenedMs < settings.minListenMs) return null;
        if (ratio >= settings.fullPlayThreshold) return "full";
        if (ratio < settings.heavySkipThreshold) return "heavySkip";
        if (ratio < settings.skipThreshold) return "skip";
        return "partial";
    }

    function getDelta(kind) {
        var a = agg();
        return a[kind] || 0;
    }

    function recordEvent(uri, kind, optName) {
        if (!settings.learning) return;
        var t = getTrack(uri);
        switch (kind) {
            case "full": t.p++; break;
            case "skip": case "heavySkip": t.sk++; break;
            case "queueAdd": t.q++; break;
            case "pick": t.pk++; break;
        }
        t.s = t.s * settings.decay + getDelta(kind);
        var clamp = agg().clamp;
        if (t.s > clamp) t.s = clamp;
        if (t.s < -clamp) t.s = -clamp;
        t.t = Date.now();
        if (optName && optName !== "") t.n = optName;
        else if (!t.n) { var n = getCurrentTrackName(); if (n && n !== "") t.n = n; }
        saveTracks();
    }

    function weightFromScore(score) {
        return Math.pow(2, score / agg().weightDiv);
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
                if (kind) recordEvent(lastUri, kind, lastTrackName);
            }

            var data = Player.data;
            if (data && data.item) {
                lastUri = data.item.uri;
                lastTrackName = data.item.name || data.item.metadata?.title || "";
                lastDurationMs = data.duration;
                lastProgressMs = 0;
            } else {
                lastUri = null;
                lastTrackName = "";
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
            // Tenta pegar a playlist/contexto inteiro via context_uri
            var data = Player.data;
            var contextUri = data && data.context_uri;
            var allTracks = null;

            if (contextUri) {
                try {
                    var uriObj = Spicetify.URI.fromString(contextUri);
                    if (uriObj.type === Type.PLAYLIST || uriObj.type === Type.PLAYLIST_V2) {
                        allTracks = await fetchPlaylistTracks(contextUri);
                    } else if (uriObj.type === Type.ALBUM) {
                        allTracks = await fetchAlbumTracks(contextUri);
                    }
                } catch (e) {}
            }

            if (allTracks && allTracks.length >= 2) {
                // Temos a playlist/album inteiro -> shuffle completo adaptativo
                var shuffled = weightedShuffle(allTracks);
                // Remove a musica atual do shuffle pra nao duplicar
                var currentUri = getCurrentTrackUri();
                if (currentUri) {
                    shuffled = shuffled.filter(function(u) { return u !== currentUri; });
                }
                await setQueueFromUris(shuffled, true, contextUri);
                // Forca tocar a primeira da fila nova (a atual continua por design)
                var preview = shuffled.slice(1, 5).map(function(u) {
                    var s = getTrack(u).s;
                    return (s >= 0 ? "+" : "") + s.toFixed(0);
                }).join(" ");
                notify(shuffled.length + " faixas reordenadas. Proximas: " + preview);
                return;
            }

            // Fallback: reordena so o nextUp
            var qs = getQueueState();
            var upcoming = qs.nextUp;
            if (upcoming.length < 2) {
                notify("Fila pequena demais para embaralhar");
                return;
            }
            var shuffledNext = weightedShuffle(upcoming);
            await setQueueFromUris(shuffledNext, true, null);
            var preview = shuffledNext.slice(0, 4).map(function(u) {
                var s = getTrack(u).s;
                return (s >= 0 ? "+" : "") + s.toFixed(0);
            }).join(" ");
            notify(upcoming.length + " reordenadas. Topo: " + preview);
        } catch (e) {
            console.error("[AS]", e);
            notify("Erro ao reordenar: " + (e && e.message || e));
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
            t.s = Math.min(t.s + 3, agg().clamp);
            t.pk++;
            t.t = Date.now();
            if (!t.n) t.n = getCurrentTrackName() || uri.split(":").pop() || "";
            saveTracks();
            notify("Turbinada! Score " + t.s.toFixed(0));
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
            t.s = Math.max(t.s - 3, -agg().clamp);
            t.sk++;
            t.t = Date.now();
            if (!t.n) t.n = getCurrentTrackName() || uri.split(":").pop() || "";
            saveTracks();
            notify("Evitada! Score " + t.s.toFixed(0));
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
        try {
        var entries = Object.keys(tracks).map(function(k) { return [k, tracks[k]]; });
        entries.sort(function(a, b) { return b[1].s - a[1].s; });
        var count = entries.length;

        var style = Spicetify.React.createElement("style", null,
            ".as-row{display:flex;padding:10px 0;align-items:center}" +
            ".as-label{flex:1;color:var(--spice-text)}" +
            ".as-action{margin-left:15px}" +
            ".as-divider{height:2px;border:0;background:var(--spice-button-disabled);margin:8px 0}" +
            ".as-stat{padding:4px 0;color:var(--spice-subtext)}" +
            ".as-track-item{display:flex;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)}" +
            ".as-track-name{flex:1;color:var(--spice-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}" +
            ".as-bar{width:100px;height:8px;background:linear-gradient(to right,#5c0000 0%,#c0392b 20%,#888 45%,#666 50%,#888 55%,#1db954 65%,#0ce6f2 82%,#ffd700 100%);border-radius:4px;margin:0 10px;position:relative;overflow:hidden}" +
            ".as-bar-fill{position:absolute;top:0;height:100%;border-radius:4px;box-shadow:0 0 6px currentColor;transition:left .3s,width .3s}" +
            ".as-bar-dot{position:absolute;top:-3px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid currentColor;box-shadow:0 0 8px currentColor;transform:translateX(-7px);transition:left .3s}" +
            ".as-score{width:32px;text-align:right;color:var(--spice-subtext);font-size:12px}" +
            "button.as-btn{border:0;border-radius:8px;background:var(--spice-button);color:var(--spice-text);cursor:pointer;padding:8px 14px}" +
            "button.as-danger{background:#e22134}" +
            "select.as-select{color:var(--spice-text);background:var(--spice-card);border:0;height:32px;border-radius:6px}" +
            ".as-toggle{width:44px;height:24px;border-radius:12px;background:var(--spice-button-disabled);position:relative;cursor:pointer;transition:background .2s}" +
            ".as-toggle.on{background:var(--spice-button)}" +
            ".as-toggle::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s}" +
            ".as-toggle.on::after{transform:translateX(20px)}" +
            ".as-list-scroll{max-height:260px;overflow-y:auto;padding-right:4px}"
        );

        function buildList(arr, n) {
            return arr.slice(0, n).map(function(e) {
                var uri = e[0], track = e[1];
                var name = (track.n && track.n !== "") ? track.n : (uri.split(":").pop() || uri);
                var clamp = agg().clamp;
                var ratio = (track.s + clamp) / (2 * clamp);
                var left = Math.round(ratio * 100);
                var fillColor;
                if (ratio > 0.8) fillColor = "#ffd700";
                else if (ratio > 0.65) fillColor = "#0ce6f2";
                else if (ratio > 0.55) fillColor = "#1db954";
                else if (ratio > 0.45) fillColor = "#888";
                else if (ratio > 0.2) fillColor = "#c0392b";
                else fillColor = "#5c0000";

                return Spicetify.React.createElement("div", { key: uri, className: "as-track-item" },
                    Spicetify.React.createElement("span", { className: "as-track-name", title: uri }, name),
                    Spicetify.React.createElement("div", { className: "as-bar" },
                        Spicetify.React.createElement("div", { className: "as-bar-dot", style: { left: left + "%", color: fillColor } })
                    ),
                    Spicetify.React.createElement("span", { className: "as-score" }, track.s.toFixed(0))
                );
            });
        }

        var sortedAsc = entries.slice().sort(function(a, b) { return a[1].s - b[1].s; });
        var topFav = buildList(entries, 15);
        var topAvo = buildList(sortedAsc, 15);

        var content = Spicetify.React.createElement("div", null,
            style,
            Spicetify.React.createElement("h3", { style: { color: "var(--spice-text)" } }, "Aprendizado"),
            Spicetify.React.createElement("hr", { className: "as-divider" }),
            Spicetify.React.createElement("div", { className: "as-row" },
                Spicetify.React.createElement("span", { className: "as-label" }, "Aprendizado: " + (settings.learning ? "LIGADO" : "DESLIGADO")),
                Spicetify.React.createElement("div", { className: "as-action" },
                    Spicetify.React.createElement("button", {
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
            Spicetify.React.createElement("div", { className: "as-row" },
                Spicetify.React.createElement("span", { className: "as-label" }, "Agressividade: " + settings.aggressiveness.toUpperCase()),
                Spicetify.React.createElement("div", { className: "as-action" },
                    Spicetify.React.createElement("select", {
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
                        Spicetify.React.createElement("option", { value: "leve" }, "Leve"),
                        Spicetify.React.createElement("option", { value: "normal" }, "Normal"),
                        Spicetify.React.createElement("option", { value: "intenso" }, "Intenso")
                    )
                )
            ),

            Spicetify.React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Estatisticas"),
            Spicetify.React.createElement("hr", { className: "as-divider" }),
            Spicetify.React.createElement("div", { className: "as-stat" }, "Faixas conhecidas: " + count),
            Spicetify.React.createElement("div", { className: "as-stat" }, "Mais amadas (top 15)"),
            Spicetify.React.createElement("div", { className: "as-list-scroll" }, topFav),
            Spicetify.React.createElement("div", { className: "as-stat", style: { marginTop: "8px" } }, "Mais evitadas (top 15)"),
            Spicetify.React.createElement("div", { className: "as-list-scroll" }, topAvo),
            Spicetify.React.createElement("div", { className: "as-stat", style: { marginTop: "6px", fontSize: "12px" } },
                "Dica: use os botoes na barra do player para turbinar/evitar/ver score da musica tocando"
            ),

            Spicetify.React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Acoes"),
            Spicetify.React.createElement("hr", { className: "as-divider" }),
            Spicetify.React.createElement("div", { className: "as-row" },
                Spicetify.React.createElement("span", { className: "as-label" }, "Apagar tudo e comecar do zero"),
                Spicetify.React.createElement("div", { className: "as-action" },
                    Spicetify.React.createElement("button", {
                        className: "as-btn as-danger",
                        onClick: function() { tracks = {}; saveTracks(); Spicetify.PopupModal.hide(); notify("Historico apagado!"); }
                    }, "Resetar")
                )
            ),
            Spicetify.React.createElement("div", { className: "as-row" },
                Spicetify.React.createElement("span", { className: "as-label" }, count + " faixas conhecidas. Reordenar fila:"),
                Spicetify.React.createElement("div", { className: "as-action" },
                    Spicetify.React.createElement("button", {
                        className: "as-btn",
                        onClick: function() { adaptiveReshuffleCurrentQueue(); }
                    }, "Embaralhar")
                )
            )
        );

        Spicetify.PopupModal.display({ title: "Adaptive Shuffle", content: content });
        } catch (e) {
            console.error("[AS] openSettings:", e);
            notify("Erro no modal: " + (e && e.message || String(e)));
        }
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

    window.AdaptiveShuffle = {
        version: VERSION, settings: settings, tracks: tracks,
        getTrack: getTrack, recordEvent: recordEvent, weightedShuffle: weightedShuffle,
        reshuffle: adaptiveReshuffleCurrentQueue, playAdaptive: playAdaptive, openSettings: openSettings,
        _resetTracking: function() {
            try {
                var d = Player.data;
                if (d && d.item) {
                    lastUri = d.item.uri;
                    lastTrackName = d.item.name || (d.item.metadata && d.item.metadata.title) || "";
                    lastDurationMs = d.duration;
                }
                lastProgressMs = 0;
            } catch (e) {}
        }
    };

    var init = function() {
        try {
            var d = Player.data;
            if (d && d.item) {
                lastUri = d.item.uri;
                lastTrackName = d.item.name || (d.item.metadata && d.item.metadata.title) || "";
                lastDurationMs = d.duration;
            }
            var qs = getQueueState();
            var p = {};
            for (var i = 0; i < qs.queued.length; i++) p[qs.queued[i]] = true;
            prevQueuedUris = p;
        } catch (e) {}
    };
    init();

    console.log("[Adaptive Shuffle v" + VERSION + "] carregado. " + Object.keys(tracks).length + " faixas.");
})();
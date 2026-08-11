// NAME: Adaptive Shuffle
// AUTHOR: joseg
// DESCRIPTION: Shuffle inteligente que aprende seu comportamento - musicas que vc ama tocam mais, as que vc sempre pula somem.

/// <reference path="globals.d.ts" />

(function adaptiveShuffle() {
    // ============================================================
    // SEÇÃO 1: CONSTANTES E CONFIG PADRÃO
    // ============================================================

    const STORE_KEY = "adaptiveShuffle:tracks";
    const SETTINGS_KEY = "adaptiveShuffle:settings";
    const KNOWN_QUEUED_KEY = "adaptiveShuffle:knownQueued";
    const VERSION = "1.0.0";
    const MAX_TRACKS = 4000; // limite de faixas armazenadas (LRU)

    const DEFAULT_SETTINGS = {
        learning: true,          // aprendizado ligado/desligado
        aggressiveness: "normal", // leve | normal | intenso
        skipThreshold: 0.25,     // % considerada skip
        fullPlayThreshold: 0.80, // % considerada play completo
        heavySkipThreshold: 0.10,// % skip pesado
        minListenMs: 3000,       // minimo pra contar (evita ruido)
        decay: 0.9,              // quanto do score antigo se mantem
        clamp: 10,               // limite ± do score
        pollIntervalMs: 15000,   // intervalo pra checar fila manual
    };

    // Deltas por nivel de agressividade
    const DELTAS = {
        leve:    { fullPlay: 1.0,  skip: -1.0,  heavySkip: -1.5,  queueAdd: 1.5,  pick: 1.0  },
        normal: { fullPlay: 2.0,  skip: -2.0,  heavySkip: -3.0,  queueAdd: 3.0,  pick: 2.0  },
        intenso: { fullPlay: 3.0,  skip: -3.0,  heavySkip: -5.0,  queueAdd: 5.0,  pick: 3.0  },
    };

    // ============================================================
    // SEÇÃO 2: ESPERAR O SPICETIFY FICAR PRONTO
    // ============================================================

    if (!(Spicetify.Player && Spicetify.Platform && Spicetify.LocalStorage)) {
        setTimeout(adaptiveShuffle, 300);
        return;
    }

    const { Player, Platform, LocalStorage, React, addToQueue, showNotification } = Spicetify;

    // ============================================================
    // SEÇÃO 3: STORE (persistência em LocalStorage)
    // ============================================================

    let settings = loadSettings();
    let tracks = loadTracks();
    let knownQueuedUris = loadKnownQueued();

    function loadSettings() {
        try {
            const parsed = JSON.parse(LocalStorage.get(SETTINGS_KEY) || "null");
            if (parsed && typeof parsed === "object") {
                return Object.assign({}, DEFAULT_SETTINGS, parsed);
            }
        } catch (e) { /* ignora */ }
        const s = Object.assign({}, DEFAULT_SETTINGS);
        saveSettings(s);
        return s;
    }

    function saveSettings(s) {
        LocalStorage.set(SETTINGS_KEY, JSON.stringify(s));
    }

    function loadTracks() {
        try {
            const parsed = JSON.parse(LocalStorage.get(STORE_KEY) || "null");
            if (parsed && typeof parsed === "object") return parsed;
        } catch (e) { /* ignora */ }
        return {};
    }

    function saveTracks() {
        try {
            LocalStorage.set(STORE_KEY, JSON.stringify(tracks));
        } catch (e) {
            // storage cheio? limpa entradas antigas
            pruneOldEntries();
            try { LocalStorage.set(STORE_KEY, JSON.stringify(tracks)); } catch (e2) { /* sem sorte */ }
        }
    }

    function loadKnownQueued() {
        try {
            const parsed = JSON.parse(LocalStorage.get(KNOWN_QUEUED_KEY) || "null");
            if (Array.isArray(parsed)) return new Set(parsed);
        } catch (e) { /* ignora */ }
        return new Set();
    }

    function saveKnownQueued() {
        // mantém só os ultimos 200
        const arr = Array.from(knownQueuedUris).slice(-200);
        LocalStorage.set(KNOWN_QUEUED_KEY, JSON.stringify(arr));
    }

    function getTrack(uri) {
        if (!tracks[uri]) {
            tracks[uri] = { s: 0, p: 0, sk: 0, q: 0, pk: 0, t: Date.now() };
        }
        return tracks[uri];
    }

    function pruneOldEntries() {
        const entries = Object.entries(tracks);
        if (entries.length <= MAX_TRACKS) return;
        // remove as mais antigas (menor t) e com score proximo de 0 primeiro
        entries.sort((a, b) => {
            const aWeight = Math.abs(a[1].s) + (a[1].p + a[1].sk + a[1].q + a[1].pk);
            const bWeight = Math.abs(b[1].s) + (b[1].p + b[1].sk + b[1].q + b[1].pk);
            return aWeight - bWeight;
        });
        const toRemove = entries.length - MAX_TRACKS;
        for (let i = 0; i < toRemove; i++) {
            delete tracks[entries[i][0]];
        }
    }

    // ============================================================
    // SEÇÃO 4: SCORE ENGINE (funções puras - testáveis)
    // ============================================================

    // Aplica delta com decaimento e clamp. Exportado pra teste.
    function applyDelta(track, delta) {
        track.s = track.s * settings.decay + delta;
        if (track.s > settings.clamp) track.s = settings.clamp;
        if (track.s < -settings.clamp) track.s = -settings.clamp;
        track.t = Date.now();
        return track;
    }

    // Classifica o comportamento a partir do % ouvido (0..1) e se pulou manualmente.
    // Retorna: "full" | "skip" | "heavySkip" | "partial" | null
    function classifyListened(ratio, listenedMs) {
        if (listenedMs < settings.minListenMs) return null;
        if (ratio >= settings.fullPlayThreshold) return "full";
        if (ratio < settings.heavySkipThreshold) return "heavySkip";
        if (ratio < settings.skipThreshold) return "skip";
        return "partial";
    }

    function getDelta(kind) {
        const d = DELTAS[settings.aggressiveness] || DELTAS.normal;
        switch (kind) {
            case "full": return d.fullPlay;
            case "skip": return d.skip;
            case "heavySkip": return d.heavySkip;
            case "queueAdd": return d.queueAdd;
            case "pick": return d.pick;
            default: return 0;
        }
    }

    function recordEvent(uri, kind) {
        if (!settings.learning) return;
        const track = getTrack(uri);
        switch (kind) {
            case "full": track.p++; break;
            case "skip": case "heavySkip": track.sk++; break;
            case "queueAdd": track.q++; break;
            case "pick": track.pk++; break;
        }
        applyDelta(track, getDelta(kind));
        saveTracks();
    }

    // Pesos para shuffle ponderado. score em [-clamp, +clamp].
    // peso = 2^(score/3) => score +9 => 8x, score -9 => 0.125x (rara mas nunca 0)
    function weightFromScore(score) {
        return Math.pow(2, score / 3);
    }

    // Permutação aleatória ponderada (weighted shuffle).
    // Faixas com score alto tendem a aparecer antes. Nunca exclui ninguém.
    function weightedShuffle(uris) {
        const items = uris.map((uri) => ({ uri, w: weightFromScore(getTrack(uri).s) }));
        const result = [];
        while (items.length > 0) {
            let total = 0;
            for (const it of items) total += it.w;
            let r = Math.random() * total;
            let idx = 0;
            for (let i = 0; i < items.length; i++) {
                r -= items[i].w;
                if (r <= 0) { idx = i; break; }
                idx = i;
            }
            result.push(items[idx].uri);
            items.splice(idx, 1);
        }
        return result;
    }

    // ============================================================
    // SEÇÃO 5: TRACKER (aprendizado em background)
    // ============================================================

    let lastUri = null;        // URI da musica que estava tocando antes da troca
    let lastStartTs = 0;       // quando comecou a tocar
    let lastProgressMs = 0;    // progresso capturado no onprogress
    let lastDurationMs = 0;
    let lastWasPlaying = false;
    let prevNextTrackUris = new Set(); // snapshot das proximas previstas
    let prevQueuedUris = new Set();    // snapshot da fila manual
    let pollTimer = null;

    function getCurrentTrackInfo() {
        const data = Player.data;
        if (!data || !data.item) return null;
        return {
            uri: data.item.uri,
            duration: data.duration,
        };
    }

    function captureQueueSnapshot() {
        const nextUp = [];
        const queued = [];
        try {
            const qs = Platform.PlayerAPI._queue._queueState;
            if (qs) {
                if (Array.isArray(qs.nextUp)) nextUp.push(...qs.nextUp.map((t) => t.uri));
                if (Array.isArray(qs.queued)) queued.push(...qs.queued.map((t) => t.uri));
            }
        } catch (e) { /* estrutura pode variar */ }
        return { nextUp: new Set(nextUp), queued: new Set(queued) };
    }

    function onProgress() {
        try {
            lastProgressMs = Player.getProgress();
            lastWasPlaying = Player.isPlaying();
        } catch (e) { /* ignora */ }
    }

    function onSongChange() {
        // 1. Classifica a musica ANTERIOR
        if (lastUri && lastDurationMs > 0) {
            const listenedMs = lastProgressMs;
            const ratio = listenedMs / lastDurationMs;
            const kind = classifyListened(ratio, listenedMs);
            if (kind) recordEvent(lastUri, kind);
        }

        // 2. Decide se a NOVA musica foi escolha manual (pick)
        const snap = captureQueueSnapshot();
        const data = Player.data;
        if (data && data.item) {
            const newUri = data.item.uri;
            // Se a nova faixa NAO estava nas proximas previstas => usuario clicou nela
            if (lastUri && newUri !== lastUri && prevNextTrackUris.size > 0 && !prevNextTrackUris.has(newUri)) {
                // e tambem nao tava na fila manual prevista => foi pick direto
                if (!prevQueuedUris.has(newUri)) {
                    recordEvent(newUri, "pick");
                }
            }
        }

        // 3. Detecta "adicionar a fila" (compara snapshot anterior do queued)
        const newQueuedArr = Array.from(snap.queued);
        for (const uri of newQueuedArr) {
            if (!prevQueuedUris.has(uri) && !knownQueuedUris.has(uri)) {
                // nova entrada na fila manual => boost
                recordEvent(uri, "queueAdd");
                knownQueuedUris.add(uri);
            }
        }
        // limpa conhecidas que sumiram pra liberar (mantem so as atuais + historico curto)
        for (const uri of newQueuedArr) knownQueuedUris.add(uri);

        // 4. Atualiza snapshots pra proxima troca
        prevNextTrackUris = snap.nextUp;
        prevQueuedUris = snap.queued;
        lastProgressMs = 0;

        // 5. Seta a musica atual como "a anterior" para a proxima rodada
        const info = getCurrentTrackInfo();
        if (info) {
            lastUri = info.uri;
            lastStartTs = Date.now();
            lastDurationMs = info.duration;
        } else {
            lastUri = null;
        }

        saveKnownQueued();
    }

    function startTracker() {
        Player.addEventListener("songchange", onSongChange);
        Player.addEventListener("onprogress", onProgress);

        // snapshot inicial
        const snap = captureQueueSnapshot();
        prevNextTrackUris = snap.nextUp;
        prevQueuedUris = snap.queued;
        const info = getCurrentTrackInfo();
        if (info) {
            lastUri = info.uri;
            lastDurationMs = info.duration;
        }

        // poll leve pra detectar "add to queue" fora de trocas de musica
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (!settings.learning) return;
            try {
                const snap2 = captureQueueSnapshot();
                for (const uri of snap2.queued) {
                    if (!prevQueuedUris.has(uri) && !knownQueuedUris.has(uri)) {
                        recordEvent(uri, "queueAdd");
                        knownQueuedUris.add(uri);
                    }
                }
                prevQueuedUris = snap2.queued;
                saveKnownQueued();
            } catch (e) { /* ignora */ }
        }, settings.pollIntervalMs);
    }

    // ============================================================
    // SEÇÃO 6: APLICAR SHUFFLE NA FILA (sem parar a musica atual)
    // ============================================================

    // Reordena as proximas faixas do contexto atual com peso adaptativo.
    // Mantem a musica tocando intacta.
    async function adaptiveReshuffleCurrentQueue() {
        try {
            const snap = captureQueueSnapshot();
            let upcoming = Array.from(snap.nextUp);
            if (upcoming.length < 2) {
                showNotification("Fila pequena demais pra embaralhar");
                return;
            }
            const shuffled = weightedShuffle(upcoming);
            await setQueueFromUris(shuffled, /*keepCurrent*/ true);
            showNotification(`✨ Adaptive Shuffle: ${shuffled.length} faixas reordenadas`);
        } catch (e) {
            console.error("[Adaptive Shuffle] reshuffle falhou", e);
            showNotification("Erro ao reordenar a fila", true);
        }
    }

    // Toca um conjunto de URIs com shuffle adaptativo (estilo shuffle+).
    async function playAdaptive(uris, contextUri) {
        try {
            if (!uris || uris.length === 0) {
                showNotification("Nada para tocar");
                return;
            }
            const shuffled = weightedShuffle(uris);
            await setQueueFromUris(shuffled, /*keepCurrent*/ false, contextUri);
            Player.next();
            showNotification(`✨ Adaptive Shuffle: ${shuffled.length} faixas`);
        } catch (e) {
            console.error("[Adaptive Shuffle] playAdaptive falhou", e);
            showNotification("Erro ao iniciar Adaptive Shuffle", true);
        }
    }

    // Reescreve a fila usando a API interna de baixo nivel (mesma do shuffle+).
    async function setQueueFromUris(uris, keepCurrent, contextUri) {
        // delimita o fim (spotify pode adicionar faixas do contexto)
        const list = uris.slice();
        list.push("spotify:delimiter");

        const q = Platform.PlayerAPI._queue;
        const _queue = q._queue;
        const _client = q._client;
        if (!_queue || !_client) throw new Error("fila interna indisponivel");

        const { prevTracks, queueRevision } = _queue;

        const nextTracks = list.map((uri) => ({
            contextTrack: {
                uri,
                uid: "",
                metadata: { is_queued: "false" },
            },
            removed: [],
            blocked: [],
            provider: "context",
        }));

        _client.setQueue({ nextTracks, prevTracks, queueRevision });

        if (contextUri) {
            const { sessionId } = Platform.PlayerAPI.getState();
            Platform.PlayerAPI.updateContext(sessionId, {
                uri: contextUri,
                url: `context://${contextUri}`,
            });
        }
    }

    // ============================================================
    // SEÇÃO 7: BUSCAR FAIXAS DE PLAYLIST/ALBUM/CURTIDAS
    // ============================================================

    async function fetchPlaylistTracks(uri) {
        const res = await Platform.PlaylistAPI.getContents(uri, { limit: 9999999 });
        return res.items.filter((t) => t.isPlayable).map((t) => t.uri);
    }

    async function fetchAlbumTracks(uri) {
        const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
        const { data, errors } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
            uri, offset: 0, limit: 100,
        });
        if (errors) throw errors[0].message;
        const items = data.albumUnion?.tracksV2?.items ?? data.albumUnion?.tracks?.items ?? [];
        return items.filter(({ track }) => track.playability.playable).map(({ track }) => track.uri);
    }

    async function fetchArtistTracks(uri) {
        const { queryArtistOverview } = Spicetify.GraphQL.Definitions;
        const { data, errors } = await Spicetify.GraphQL.Request(queryArtistOverview, {
            uri, locale: Spicetify.Locale.getLocale(), includePrerelease: false,
        });
        if (errors) throw errors[0].message;
        return data.artistUnion.discography.topTracks.items.map(({ track }) => track.uri);
    }

    async function fetchLikedTracks() {
        const res = await Platform.LibraryAPI.getTracks({ limit: 9999999 });
        return res.items.filter((t) => t.isPlayable).map((t) => t.uri);
    }

    // ============================================================
    // SEÇÃO 8: UI - BOTÃO NA PLAYBAR
    // ============================================================

    const SHUFFLE_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.696 1.146L4.217 8.604a2.25 2.25 0 0 1-1.617.687H2.493a.75.75 0 0 0 0 1.5h.107a3.75 3.75 0 0 0 2.696-1.146l4.247-4.458a2.25 2.25 0 0 1 1.617-.687h1.949l-1.018 1.018a.75.75 0 0 0 1.06 1.06l2.248-2.248a.75.75 0 0 0 0-1.06L13.151.922zM2.493 3.292h.107a3.75 3.75 0 0 1 2.696 1.146l.396.415a.75.75 0 0 0 1.078-1.044l-.4-.421A5.25 5.25 0 0 0 2.6 1.792h-.107a.75.75 0 0 0 0 1.5zM11.16 13h1.949l-1.018-1.018a.75.75 0 1 1 1.06-1.06l2.248 2.248a.75.75 0 0 1 0 1.06l-2.248 2.248a.75.75 0 1 1-1.06-1.06L13.109 14.5H11.16a3.75 3.75 0 0 1-2.696-1.146l-4.247-4.458a2.25 2.25 0 0 0-1.617-.687H2.493a.75.75 0 0 1 0-1.5h.107a3.75 3.75 0 0 1 2.696 1.146l4.247 4.458a2.25 2.25 0 0 0 1.617.687z"/>
    </svg>`;

    const playbarButton = new Spicetify.Playbar.Button(
        "Adaptive Shuffle",
        "shuffle",
        (self) => {
            self.active = !self.active;
            adaptiveReshuffleCurrentQueue();
            setTimeout(() => { self.active = false; }, 800);
        },
        false, // disabled
        false  // active
    );
    playbarButton.register();

    // ============================================================
    // SEÇÃO 9: UI - MENU DE CONTEXTO (clique direito)
    // ============================================================

    // "Tocar com Adaptive Shuffle" em playlists/albuns/artistas
    new Spicetify.ContextMenu.Item(
        "Tocar com Adaptive Shuffle",
        async (uris) => {
            try {
                const raw = uris[0];
                const uriObj = Spicetify.URI.fromString(raw);
                const type = uriObj.type;
                const id = uriObj._base62Id ?? uriObj.id;
                let list = null;
                let context = raw;
                switch (type) {
                    case Spicetify.URI.Type.PLAYLIST:
                    case Spicetify.URI.Type.PLAYLIST_V2:
                        list = await fetchPlaylistTracks(raw);
                        break;
                    case Spicetify.URI.Type.ALBUM:
                        list = await fetchAlbumTracks(raw);
                        break;
                    case Spicetify.URI.Type.ARTIST:
                        list = await fetchArtistTracks(raw);
                        break;
                    default:
                        showNotification("Selecione uma playlist, álbum ou artista", true);
                        return;
                }
                if (!list || !list.length) {
                    showNotification("Nada para tocar", true);
                    return;
                }
                await playAdaptive(list, context);
            } catch (e) {
                console.error("[Adaptive Shuffle]", e);
                showNotification("Erro: " + String(e), true);
            }
        },
        (uris) => {
            if (uris.length !== 1) return false;
            try {
                const type = Spicetify.URI.fromString(uris[0]).type;
                return [Spicetify.URI.Type.PLAYLIST, Spicetify.URI.Type.PLAYLIST_V2,
                        Spicetify.URI.Type.ALBUM, Spicetify.URI.Type.ARTIST].includes(type);
            } catch (e) { return false; }
        },
        "shuffle"
    ).register();

    // Ações por faixa (clique direito numa musica): turbinar / evitar / resetar
    new Spicetify.ContextMenu.Item(
        "Adaptive Shuffle: Turbinar ⭐",
        (uris) => {
            for (const uri of uris) {
                const t = getTrack(uri);
                t.s = Math.max(t.s + 5, settings.clamp);
                t.pk += 1;
                t.t = Date.now();
            }
            saveTracks();
            showNotification(uris.length > 1 ? `${uris.length} faixas turbinadas` : "Faixa turbinada ⭐");
        },
        (uris) => uris.every((u) => Spicetify.URI.fromString(u).type === Spicetify.URI.Type.TRACK),
        "heart-active"
    ).register();

    new Spicetify.ContextMenu.Item(
        "Adaptive Shuffle: Evitar 🙅",
        (uris) => {
            for (const uri of uris) {
                const t = getTrack(uri);
                t.s = Math.min(t.s - 5, -settings.clamp);
                t.sk += 1;
                t.t = Date.now();
            }
            saveTracks();
            showNotification(uris.length > 1 ? `${uris.length} faixas marcadas p/ evitar` : "Faixa marcada p/ evitar 🙅");
        },
        (uris) => uris.every((u) => Spicetify.URI.fromString(u).type === Spicetify.URI.Type.TRACK),
        "block"
    ).register();

    new Spicetify.ContextMenu.Item(
        "Adaptive Shuffle: Resetar 🔄",
        (uris) => {
            for (const uri of uris) {
                delete tracks[uri];
            }
            saveTracks();
            showNotification(uris.length > 1 ? `${uris.length} faixas resetadas` : "Faixa resetada 🔄");
        },
        (uris) => uris.every((u) => Spicetify.URI.fromString(u).type === Spicetify.URI.Type.TRACK),
        "reset"
    ).register();

    new Spicetify.ContextMenu.Item(
        "Adaptive Shuffle: Score 🎯",
        (uris) => {
            for (const uri of uris) {
                const t = tracks[uri];
                if (!t) {
                    showNotification("Esta faixa ainda nao foi avaliada");
                    return;
                }
                const score = t.s.toFixed(1);
                const bar = score > 0
                    ? "🟢".repeat(Math.max(1, Math.round((t.s + settings.clamp) / (2 * settings.clamp) * 5)))
                    : "🔴".repeat(Math.max(1, Math.round((settings.clamp - Math.abs(t.s)) / (2 * settings.clamp) * 5)));
                const msg = `🎯 Score: ${score} ${bar}\n▶ plays: ${t.p}  ⏩ skips: ${t.sk}\n📋 na fila: ${t.q}  👆 escolhas: ${t.pk}`;
                showNotification(msg);
            }
        },
        (uris) => uris.every((u) => Spicetify.URI.fromString(u).type === Spicetify.URI.Type.TRACK),
        "info"
    ).register();

    // ============================================================
    // SEÇÃO 10: UI - MENU DE CONFIGURAÇÕES (modal)
    // ============================================================

    function openSettings() {
        const style = React.createElement("style", null, `
            .as-row { display: flex; padding: 10px 0; align-items: center; }
            .as-row .as-label { flex: 1; color: var(--spice-text); }
            .as-row .as-action { margin-left: 15px; }
            .as-divider { height: 2px; border: 0; background: var(--spice-button-disabled); margin: 8px 0; }
            .as-stat { padding: 6px 0; color: var(--spice-subtext); }
            .as-track-item { display: flex; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
            .as-track-name { flex: 1; color: var(--spice-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .as-bar { width: 100px; height: 8px; background: var(--spice-card); border-radius: 4px; margin: 0 12px; position: relative; overflow: hidden; }
            .as-bar-fill { position: absolute; top: 0; height: 100%; border-radius: 4px; }
            .as-score { width: 40px; text-align: right; color: var(--spice-subtext); font-size: 12px; }
            button.as-btn { align-items: center; border: 0; border-radius: 8px; background: var(--spice-button); color: var(--spice-text); cursor: pointer; padding: 8px 14px; }
            button.as-btn.as-danger { background: #e22134; }
            button.as-btn.as-ghost { background: transparent; border: 1px solid var(--spice-button-disabled); }
            select.as-select { color: var(--spice-text); background: var(--spice-card); border: 0; height: 32px; border-radius: 6px; }
            .as-toggle { width: 44px; height: 24px; border-radius: 12px; background: var(--spice-button-disabled); position: relative; cursor: pointer; transition: background .2s; }
            .as-toggle.on { background: var(--spice-button); }
            .as-toggle::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .2s; }
            .as-toggle.on::after { transform: translateX(20px); }
        `);

        function Toggle({ value, onChange }) {
            const [on, setOn] = React.useState(value);
            return React.createElement("div", {
                className: `as-toggle${on ? " on" : ""}`,
                onClick: () => { setOn(!on); onChange(!on); },
            });
        }

        function AggressivenessSelect() {
            const [val, setVal] = React.useState(settings.aggressiveness);
            return React.createElement("select", {
                className: "as-select",
                value: val,
                onChange: (e) => {
                    setVal(e.target.value);
                    settings.aggressiveness = e.target.value;
                    saveSettings(settings);
                    showNotification("Agressividade: " + e.target.value);
                },
            },
                React.createElement("option", { value: "leve" }, "Leve"),
                React.createElement("option", { value: "normal" }, "Normal"),
                React.createElement("option", { value: "intenso" }, "Intenso"),
            );
        }

        function buildScoreList(sortedEntries, n) {
            return sortedEntries.slice(0, n).map((entry) => {
                const uri = entry[0];
                const track = entry[1];
                let name = uri;
                try {
                    const id = uri.split(":").pop() || uri;
                    name = id.length > 30 ? id.slice(0, 28) + "…" : id;
                } catch (e) { /* mantém */ }
                const ratio = (track.s + settings.clamp) / (2 * settings.clamp); // 0..1
                const fillPct = Math.round(ratio * 100);
                const isPositive = ratio >= 0.5;
                const fillColor = isPositive ? "#1ed760" : "#e22134";
                return React.createElement("div", { key: uri, className: "as-track-item" },
                    React.createElement("span", { className: "as-track-name", title: uri }, name),
                    React.createElement("div", { className: "as-bar" },
                        React.createElement("div", {
                            className: "as-bar-fill",
                            style: { width: fillPct + "%", background: fillColor },
                        })),
                    React.createElement("span", { className: "as-score" }, track.s.toFixed(1)),
                );
            });
        }

        const allEntries = Object.entries(tracks);
        const sortedDesc = allEntries.slice().sort((a, b) => b[1].s - a[1].s);
        const sortedAsc = allEntries.slice().sort((a, b) => a[1].s - b[1].s);
        const topFavorites = buildScoreList(sortedDesc, 15);
        const topAvoided = buildScoreList(sortedAsc, 15);

        const count = allEntries.length;

        const content = React.createElement("div", null,
            style,

            // Aprendizado
            React.createElement("h3", { style: { color: "var(--spice-text)" } }, "Aprendizado"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Aprender com meu comportamento"),
                React.createElement("div", { className: "as-action" },
                    React.createElement(Toggle, {
                        value: settings.learning,
                        onChange: (v) => { settings.learning = v; saveSettings(settings); },
                    })
                ),
            ),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Agressividade do shuffle"),
                React.createElement("div", { className: "as-action" },
                    React.createElement(AggressivenessSelect)
                ),
            ),

            // Estatisticas
            React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Estatísticas"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-stat" }, `🎵 Faixas conhecidas: ${count}`),
            React.createElement("div", { className: "as-stat" }, `⭐ Mais amadas (top 15)`),
            ...topFavorites,
            React.createElement("div", { className: "as-stat", style: { marginTop: "10px" } }, `🙅 Mais evitadas (top 15)`),
            ...topAvoided,
            React.createElement("div", { className: "as-stat", style: { marginTop: "8px", fontSize: "13px", color: "var(--spice-subtext)" } },
                `💡 Dica: clique direito em qualquer música → "Adaptive Shuffle: Score 🎯" para ver o score dela`
            ),

            // Acoes
            React.createElement("h3", { style: { color: "var(--spice-text)", marginTop: "16px" } }, "Ações"),
            React.createElement("hr", { className: "as-divider" }),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, "Apagar tudo que aprendeu"),
                React.createElement("div", { className: "as-action" },
                    React.createElement("button", {
                        className: "as-btn as-danger",
                        onClick: () => {
                            tracks = {};
                            saveTracks();
                            Spicetify.PopupModal.hide();
                            showNotification("Histórico apagado. Começando do zero.");
                        },
                    }, "Começar do zero")
                ),
            ),
            React.createElement("div", { className: "as-row" },
                React.createElement("span", { className: "as-label" }, `Reordenar fila agora (${count} faixas conhecidas)`),
                React.createElement("div", { className: "as-action" },
                    React.createElement("button", {
                        className: "as-btn",
                        onClick: () => { adaptiveReshuffleCurrentQueue(); },
                    }, "✨ Embaralhar")
                ),
            ),
        );

        Spicetify.PopupModal.display({
            title: "Adaptive Shuffle",
            content,
            isLarge: true,
        });
    }

    // item no menu principal do Spicetify
    new Spicetify.Menu.Item(
        "Adaptive Shuffle",
        false,
        openSettings,
        "shuffle"
    ).register();

    // ============================================================
    // SEÇÃO 11: INICIALIZAÇÃO
    // ============================================================

    startTracker();

    // API publica pra debug no DevTools
    window.AdaptiveShuffle = {
        version: VERSION,
        settings,
        tracks,
        getTrack,
        recordEvent,
        weightedShuffle,
        reshuffle: adaptiveReshuffleCurrentQueue,
        playAdaptive,
        openSettings,
        // Sincroniza o estado do tracker com a musica atual (util p/ debug e testes).
        _resetTracking() {
            const info = getCurrentTrackInfo();
            lastUri = info ? info.uri : null;
            lastDurationMs = info ? info.duration : 0;
            lastProgressMs = 0;
            lastStartTs = Date.now();
            const snap = captureQueueSnapshot();
            prevNextTrackUris = snap.nextUp;
            prevQueuedUris = snap.queued;
        },
    };

    console.log(`[Adaptive Shuffle v${VERSION}] carregado. ${Object.keys(tracks).length} faixas conhecidas.`);
})();
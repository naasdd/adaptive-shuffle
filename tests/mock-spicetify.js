// Mock do ambiente Spicetify para rodar a extensão em Node.
// Simula o Player (com relógio e posição controláveis), a fila do Spotify,
// PlaylistAPI/LibraryAPI e o GraphQL usado pra descobrir título/artista.

function createStore() {
    const data = {};
    return {
        get: (k) => (k in data ? data[k] : null),
        set: (k, v) => { data[k] = String(v); },
        remove: (k) => { delete data[k]; },
        clear: () => { for (const k of Object.keys(data)) delete data[k]; },
        _data: data,
    };
}

class FakeEventTarget {
    constructor() { this.listeners = {}; }
    addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
    removeEventListener(type, cb) {
        if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((f) => f !== cb);
    }
    dispatchEvent(ev) { (this.listeners[ev && ev.type] || []).forEach((cb) => cb(ev)); }
}

// Faixa de teste -> item no formato do Player.data / _queueState do Spotify
function makeItem(t) {
    return {
        type: "track",
        uri: t.uri,
        name: t.name || "",
        artists: t.artist ? [{ name: t.artist }] : [],
        duration: { milliseconds: t.duration || 200000 },
        provider: t.provider || "context",
        images: [],
        metadata: Object.assign(
            { title: t.name || "", artist_name: t.artist || "", duration: String(t.duration || 200000) },
            t.liked === undefined ? {} : { "collection.in_collection": t.liked ? "true" : "false" }
        ),
    };
}
function makeRaw(t, provider) {
    return {
        contextTrack: { uri: t.uri, uid: "uid-" + t.uri, metadata: { title: t.name || "", artist_name: t.artist || "" } },
        removed: [], blocked: [], provider: provider || t.provider || "context",
    };
}

function buildMockSpicetify(opts = {}) {
    const storage = createStore();
    const clock = { t: opts.startTime || Date.UTC(2026, 10, 1, 12, 0, 0) };
    const state = { pos: 0 };
    const notifications = [];

    const player = Object.assign(new FakeEventTarget(), {
        data: null,
        getProgress: () => state.pos,
        getDuration: () => (player.data ? player.data.duration : 0),
        isPlaying: () => !!(player.data && !player.data.isPaused),
        next: () => { player._nextCalls = (player._nextCalls || 0) + 1; },
        play: () => {}, pause: () => {},
        origin: {},
        _nextCalls: 0,
    });

    // ---- fila ----
    const _queueState = { current: null, queued: [], nextUp: [] };
    const _queue = { nextTracks: [], prevTracks: [], queueRevision: "rev1" };
    const queueListeners = [];
    let setQueueCalls = [];
    let queueUid = 0;
    const catalog = {}; // uri -> {name, artist}

    function syncStateFromRaw() {
        _queueState.queued = _queue.nextTracks.filter((t) => t.provider === "queue")
            .map((t) => Object.assign(makeItem({ uri: t.contextTrack.uri, ...(catalog[t.contextTrack.uri] || {}) }), { provider: "queue" }));
        _queueState.nextUp = _queue.nextTracks.filter((t) => t.provider !== "queue")
            .map((t) => Object.assign(makeItem({ uri: t.contextTrack.uri, ...(catalog[t.contextTrack.uri] || {}) }), { provider: t.provider }));
    }

    const _client = {
        setQueue: (arg) => {
            setQueueCalls.push(arg);
            // o que passa pelo setQueue vira entrada de fila (uid "q...")
            _queue.nextTracks = arg.nextTracks.map((t) => {
                if (t.contextTrack.uid) return t;
                return { ...t, contextTrack: { ...t.contextTrack, uid: "q" + (++queueUid) } };
            });
            syncStateFromRaw();
        },
    };
    const PlayerAPI = {
        _queue: { _queue, _client, _queueState, _events: { addListener: (n, cb) => { if (n === "queue_update") queueListeners.push(cb); } } },
        getState: () => ({ sessionId: "sess-1" }),
        play: async (ctx, origin, opts) => {
            PlayerAPI._lastPlay = { ctx, opts };
            env.changeTrack({ uri: opts.skipTo.uri, ...(catalog[opts.skipTo.uri] || {}), context: ctx.uri });
        },
        _lastPlay: null,
    };

    const playlists = {}; // uri -> [tracks]
    const liked = new Set();
    const PlaylistAPI = {
        getContents: async (uri) => {
            if (!playlists[uri]) throw new Error("playlist desconhecida");
            return { items: playlists[uri].map((t) => ({ uri: t.uri, name: t.name, artists: [{ name: t.artist }], isPlayable: true })) };
        },
    };
    const LibraryAPI = {
        contains: async (...uris) => uris.map((u) => liked.has(u)),
        getTracks: async () => ({ items: [...liked].map((u) => ({ uri: u, name: (catalog[u] || {}).name, artists: [{ name: (catalog[u] || {}).artist }], isPlayable: true })) }),
    };

    const React = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => [typeof init === "function" ? init() : init, () => {}],
        useEffect: () => {},
    };

    const Spicetify = {
        Player: player,
        Platform: { PlayerAPI, PlaylistAPI, LibraryAPI },
        LocalStorage: storage,
        React,
        SVGIcons: {},
        showNotification: (msg) => { notifications.push(msg); },
        URI: {
            Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist", TRACK: "track", COLLECTION: "collection" },
            fromString: (uri) => {
                const parts = uri.split(":");
                let type = parts[1];
                if (uri.includes(":collection")) type = "collection";
                return { type, id: parts[parts.length - 1] };
            },
        },
        GraphQL: {
            Definitions: { decorateContextTracks: "decorateContextTracks", queryAlbumTracks: "queryAlbumTracks" },
            Request: async (def, vars) => {
                if (def === "decorateContextTracks") {
                    return { data: { tracks: vars.uris.filter((u) => catalog[u]).map((u) => ({ uri: u, name: catalog[u].name, artists: { items: [{ profile: { name: catalog[u].artist } }] } })) } };
                }
                throw new Error("sem graphql para " + def);
            },
        },
        Locale: { getLocale: () => "pt-BR" },
        Playbar: {
            Button: function (label, icon, onClick, disabled, active) {
                this.label = label; this.icon = icon; this.onClick = onClick; this.disabled = disabled; this.active = active;
                this.element = null;
                this.register = () => {}; this.deregister = () => {};
            },
        },
        ContextMenu: {
            Item: function (name, onClick, shouldAdd, icon) {
                this.name = name; this.onClick = onClick; this.shouldAdd = shouldAdd; this.icon = icon;
                this.register = () => { registeredMenus.push(this); };
            },
            SubMenu: function (name, items, shouldAdd) {
                this.name = name; this.items = items; this.shouldAdd = shouldAdd;
                this.register = () => { registeredMenus.push(this); };
            },
        },
        Menu: { Item: function () { this.register = () => {}; } },
        PopupModal: { display: () => {}, hide: () => {} },
    };
    const registeredMenus = [];

    globalThis.Spicetify = Spicetify;

    const env = {
        Spicetify, storage, clock, state, notifications, catalog, playlists, liked, registeredMenus,
        _queue, _queueState,
        setQueueCalls: () => setQueueCalls,
        resetSetQueueCalls: () => { setQueueCalls = []; },

        // Define a faixa atual SEM disparar songchange (estado inicial, antes de carregar a extensão)
        initTrack(t, pos = 0, extra = {}) {
            if (t.name) catalog[t.uri] = { name: t.name, artist: t.artist };
            state.pos = pos;
            player.data = Object.assign({
                item: makeItem(t), duration: t.duration || 200000, isPaused: false, shuffle: false,
                context: t.context ? { uri: t.context } : null,
            }, extra);
            _queueState.current = player.data.item;
        },
        // Troca de faixa como o Spotify faz: atualiza o estado e dispara songchange
        changeTrack(t, extra = {}) {
            const prevCtx = player.data && player.data.context;
            const prevShuffle = player.data ? player.data.shuffle : false;
            env.initTrack(t, 0, Object.assign({ context: t.context ? { uri: t.context } : prevCtx, shuffle: prevShuffle }, extra));
            // a faixa que comecou sai do topo da fila
            if (_queue.nextTracks.length && _queue.nextTracks[0].contextTrack.uri === t.uri) {
                _queue.nextTracks.shift();
                syncStateFromRaw();
            }
            player.dispatchEvent({ type: "songchange", data: player.data });
        },
        // Adicionar a fila no Spotify: entra depois das faixas com uid "q..."
        addToQueue(t) {
            if (t.name) catalog[t.uri] = { name: t.name, artist: t.artist };
            let at = 0;
            _queue.nextTracks.forEach((x, i) => { if (/^q/.test(x.contextTrack.uid) || x.provider === "queue") at = i + 1; });
            _queue.nextTracks.splice(at, 0, { ...makeRaw(t, "queue"), contextTrack: { uri: t.uri, uid: "q" + (++queueUid), metadata: {} } });
            syncStateFromRaw();
            queueListeners.forEach((cb) => cb());
        },
        // Avanca o relogio tocando: posicao anda junto, onprogress a cada `step` ms
        play(ms, step = 1000) {
            for (let done = 0; done < ms; done += step) {
                const dt = Math.min(step, ms - done);
                clock.t += dt;
                state.pos += dt;
                player.dispatchEvent({ type: "onprogress", data: state.pos });
            }
        },
        seek(pos) {
            state.pos = pos;
            clock.t += 100;
            player.dispatchEvent({ type: "onprogress", data: state.pos });
        },
        wait(ms) { clock.t += ms; },
        pause() { player.data.isPaused = true; player.dispatchEvent({ type: "onplaypause", data: player.data }); },
        resume() { player.data.isPaused = false; player.dispatchEvent({ type: "onplaypause", data: player.data }); },
        setLiked(on) {
            player.data.item.metadata["collection.in_collection"] = on ? "true" : "false";
            if (on) liked.add(player.data.item.uri); else liked.delete(player.data.item.uri);
        },
        // Define a fila do Spotify: queued = fila manual, nextUp = resto do contexto
        setQueue({ queued = [], nextUp = [] }) {
            queued.concat(nextUp).forEach((t) => { if (t.name) catalog[t.uri] = { name: t.name, artist: t.artist }; });
            _queue.nextTracks = queued.map((t) => makeRaw(t, "queue")).concat(nextUp.map((t) => makeRaw(t, t.provider || "context")));
            syncStateFromRaw();
        },
        addPlaylist(uri, tracks) {
            tracks.forEach((t) => { catalog[t.uri] = { name: t.name, artist: t.artist }; });
            playlists[uri] = tracks;
        },
    };
    return env;
}

module.exports = { buildMockSpicetify };

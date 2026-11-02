// Mock do ambiente Spicetify para rodar a extensão em Node (teste de fumaça).
// Simula o minimo necessario para adaptive-shuffle.js carregar sem erros.

function createStore() {
    const data = {};
    return {
        get: (k) => (k in data ? data[k] : null),
        set: (k, v) => { data[k] = String(v); },
        remove: (k) => { delete data[k]; },
        clear: () => { for (const k of Object.keys(data)) delete data[k]; },
    };
}

class FakeEventTarget {
    constructor() { this.listeners = {}; }
    addEventListener(type, cb) {
        (this.listeners[type] = this.listeners[type] || []).push(cb);
    }
    removeEventListener(type, cb) {
        if (!this.listeners[type]) return;
        this.listeners[type] = this.listeners[type].filter((f) => f !== cb);
    }
    dispatchEvent(ev) {
        (this.listeners[ev && ev.type] || []).forEach((cb) => cb(ev));
    }
}

function buildMockSpicetify() {
    const storage = createStore();
    const player = Object.assign(new FakeEventTarget(), {
        data: { item: { uri: "spotify:track:start" }, duration: 180000 },
        getProgress: () => 0,
        isPlaying: () => true,
        getDuration: () => 180000,
        next: () => {},
        play: () => {},
        pause: () => {},
    });

    const _queueState = { nextUp: [], queued: [], current: null };
    let setQueueCalls = [];
    const _client = {
        setQueue: (arg) => {
            setQueueCalls.push(arg);
            _queueState.queued = (arg.nextTracks || []).map((t) => t.contextTrack.uri);
        },
    };
    const PlayerAPI = {
        _queue: { _queue: { prevTracks: [], queueRevision: "rev1" }, _client, _queueState },
        getState: () => ({ sessionId: "sess-1" }),
        updateContext: () => {},
        addToQueue: async () => {},
        removeFromQueue: async () => {},
    };

    // Simple React mock com createElement funcional
    const React = {
        createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: (init) => [typeof init === "function" ? init() : init, () => {}],
        useEffect: () => {},
    };

    const Spicetify = {
        Player: player,
        Platform: { PlayerAPI },
        LocalStorage: storage,
        React,
        addToQueue: async () => {},
        showNotification: () => {},
        URI: {
            Type: { PLAYLIST: "playlist", PLAYLIST_V2: "playlist-v2", ALBUM: "album", ARTIST: "artist", TRACK: "track" },
            fromString: (uri) => {
                const id = uri.split(":").pop();
                let type = "track";
                if (uri.includes(":playlist:")) type = "playlist";
                else if (uri.includes(":album:")) type = "album";
                else if (uri.includes(":artist:")) type = "artist";
                else if (uri.includes(":track:")) type = "track";
                return { type, id, _base62Id: id };
            },
        },
        GraphQL: { Definitions: {}, Request: async () => { throw new Error("no graphql"); } },
        Locale: { getLocale: () => "pt-BR" },
        Playbar: { Button: function (label, icon, onClick, disabled, active) {
            this.label = label; this.icon = icon; this.onClick = onClick;
            this.disabled = disabled; this.active = active;
            this.element = { getBoundingClientRect: function() { return { left: 0, top: 0, bottom: 0, width: 0, height: 0, right: 0 }; } };
            this.register = () => {}; this.deregister = () => {};
        }},
        ContextMenu: { Item: function (name, onClick, shouldAdd, icon) {
            this.name = name; this.onClick = onClick; this.shouldAdd = shouldAdd; this.icon = icon;
            this.register = () => {};
        }},
        Menu: { Item: function (name, active, onClick, icon) {
            this.name = name; this.active = active; this.onClick = onClick; this.icon = icon;
            this.register = () => {};
        }},
        PopupModal: { display: () => {}, hide: () => {} },
    };

    globalThis.Spicetify = Spicetify;
    return {
        Spicetify,
        storage,
        _queueState,
        setQueueCalls: () => setQueueCalls,
        resetSetQueueCalls: () => { setQueueCalls = []; },
        // helpers para avancar "tocando"
        advanceTo: (uri, duration = 180000, progress = 0) => {
            player.data = { item: { uri }, duration };
            player.getProgress = () => progress;
        },
        emitSongChange: (uri, duration) => {
            player.data = { item: { uri }, duration };
            player.dispatchEvent({ type: "songchange", data: player.data });
        },
        emitProgress: (ms) => {
            player.getProgress = () => ms;
            player.dispatchEvent({ type: "onprogress", data: ms });
        },
    };
}

module.exports = { buildMockSpicetify };
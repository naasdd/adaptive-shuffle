// NAME: Adaptive Shuffle
// AUTHOR: joseg
// DESCRIPTION: Shuffle inteligente que aprende seu gosto: músicas que você ama tocam mais, as que você sempre pula ficam raras.

(function adaptiveShuffle() {
    // Spicetify.Player.origin so existe depois que o Spicetify termina o setup (ele SUBSTITUI o objeto
    // Spicetify.Player nessa hora); antes disso o Spicetify.Player.data de quem carregou cedo fica velho.
    if (!(Spicetify.Player && Spicetify.Player.origin && Spicetify.Platform && Spicetify.Platform.PlayerAPI && Spicetify.LocalStorage &&
          Spicetify.React && Spicetify.URI && Spicetify.Playbar && Spicetify.ContextMenu)) {
        setTimeout(adaptiveShuffle, 300);
        return;
    }

    // Sempre ler Spicetify.Player/Platform na hora: o Spicetify pode trocar esses objetos depois.
    const LocalStorage = {
        get: function (k) { return Spicetify.LocalStorage.get(k); },
        set: function (k, v) { return Spicetify.LocalStorage.set(k, v); },
    };
    const h = Spicetify.React.createElement;
    const VERSION = "2.0.0";
    const STORE_KEY = "adaptiveShuffle:v2";
    const LEGACY_STORE_KEY = "adaptiveShuffle:tracks"; // v1: mantido intacto como backup
    const SETTINGS_KEY = "adaptiveShuffle:settings";
    const DELIMITER = "spotify:delimiter";
    const HOUR = 3600000, DAY = 24 * HOUR;

    // ============================================================
    // MODELO
    // ============================================================
    // Cada musica acumula evidencia de que voce gosta (l) e de que nao gosta (d).
    // A preferencia e (L - D) / (L + D + prior), entre -1 e +1: com poucas observacoes
    // ela fica perto de 0, entao um pulo isolado nao enterra ninguem. A evidencia perde
    // metade do peso a cada halfLifeDays, pra musica poder "voltar" se seu gosto mudar.
    const MODEL = {
        halfLifeDays: 120,
        prior: 3,
        likedBonus: 2.5,      // estar nas Curtidas vale ~2.5 audicoes completas (nao decai)
        manualStep: 0.2,      // cada Turbinar/Evitar soma +-0.2 na preferencia (20 pontos)
        manualMax: 5,
        novelty: 0.1,         // musica sem historico ganha um leve empurrao pra ser descoberta
        minListenMs: 3000,    // menos que isso e "navegando", nao conta
        heavySkipRatio: 0.10,
        skipRatio: 0.25,
        fullRatio: 0.80,
        resumedRatio: 0.10,   // faixa que ja estava no meio (abriu o app, trocou de aparelho) nao e penalizada
        recentWindowMs: 24 * HOUR,
        recentFloor: 0.15,    // peso minimo de uma faixa que acabou de tocar (anti-repeticao)
        maxSongs: 6000,
        maxLog: 200,
    };

    const EVIDENCE = {
        full:      { l: 1 },
        partial:   { l: 0.5 },   // multiplicado pela fracao ouvida entre 25% e 80%
        pick:      { l: 0.7 },   // voce escolheu tocar essa faixa
        queueAdd:  { l: 1 },
        skip:      { d: 0.6 },
        heavySkip: { d: 1 },
    };

    // Quanto a preferencia pesa no sorteio: peso = e^(forca * preferencia)
    const STRENGTH = { leve: 1.0, normal: 2.0, intenso: 3.0 };
    const STRENGTH_LABEL = { leve: "Leve", normal: "Normal", intenso: "Intenso" };

    const EVENT_LABEL = {
        full: "Ouviu inteira", partial: "Ouviu boa parte", pick: "Escolheu tocar", queueAdd: "Pôs na fila",
        skip: "Pulou", heavySkip: "Pulou no começo", boost: "Turbinou", avoid: "Evitou", reset: "Resetou",
        like: "Curtiu", unlike: "Descurtiu",
    };

    // ============================================================
    // UTILITARIOS
    // ============================================================
    function now() { return Date.now(); }
    function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function isTrackUri(uri) { return typeof uri === "string" && /^spotify:(track|local):/.test(uri); }
    function isLikedSongsUri(uri) { return typeof uri === "string" && /^spotify:(user:[^:]+:)?collection(:tracks)?$/.test(uri); }
    function uriType(uri) {
        try { return Spicetify.URI.fromString(uri).type; } catch (e) { return (String(uri).split(":")[1] || ""); }
    }
    function isPlaylistUri(uri) { var t = uriType(uri); return t === Spicetify.URI.Type.PLAYLIST || t === Spicetify.URI.Type.PLAYLIST_V2; }
    function isAlbumUri(uri) { return uriType(uri) === Spicetify.URI.Type.ALBUM; }
    function isArtistUri(uri) { return uriType(uri) === Spicetify.URI.Type.ARTIST; }
    function firstArtist(artists) {
        var a = artists && (artists.items || artists)[0];
        return (a && (a.name || (a.profile && a.profile.name))) || "";
    }
    function imageUrl(src) {
        if (!src) return "";
        var m = /^spotify:image:(.+)$/.exec(src);
        return m ? "https://i.scdn.co/image/" + m[1] : src;
    }
    function debug() {
        if (window.AdaptiveShuffle && window.AdaptiveShuffle.debug) console.log.apply(console, ["[AS]"].concat([].slice.call(arguments)));
    }
    function notify(msg, isError) {
        try { Spicetify.showNotification(msg, !!isError, 3500); } catch (e) { console.log("[AS]", msg); }
    }
    function fmtScore(n) { return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n); }
    function scoreClass(n) { return n >= 10 ? "as-pos" : n <= -10 ? "as-neg" : "as-zero"; }
    function scoreWord(n) {
        if (n >= 60) return "Favorita";
        if (n >= 25) return "Você curte";
        if (n > -25) return "Neutra";
        if (n > -60) return "Pouco ouvida";
        return "Evitada";
    }
    function timeAgo(t) {
        var d = now() - t;
        if (d < 60000) return "agora";
        if (d < HOUR) return "há " + Math.round(d / 60000) + " min";
        if (d < DAY) return "há " + Math.round(d / HOUR) + " h";
        if (d < 2 * DAY) return "ontem";
        return "há " + Math.round(d / DAY) + " dias";
    }

    // ============================================================
    // CONFIGURACOES
    // ============================================================
    const DEFAULT_SETTINGS = {
        learning: true,
        aggressiveness: "normal",
        autoShuffle: false,
        avoidRepeats: true,
        spreadArtists: true,
        seenWelcome: false,
    };

    var settings = loadSettings();

    function loadSettings() {
        var s = null;
        try { s = JSON.parse(LocalStorage.get(SETTINGS_KEY) || "null"); } catch (e) {}
        var out = Object.assign({}, DEFAULT_SETTINGS);
        if (s && typeof s === "object") {
            // so as chaves conhecidas: descarta lixo de versoes antigas (clamp, decay, thresholds...)
            for (var k in DEFAULT_SETTINGS) if (typeof s[k] === typeof DEFAULT_SETTINGS[k]) out[k] = s[k];
        }
        if (!STRENGTH[out.aggressiveness]) out.aggressiveness = "normal";
        LocalStorage.set(SETTINGS_KEY, JSON.stringify(out));
        return out;
    }
    function saveSettings() { LocalStorage.set(SETTINGS_KEY, JSON.stringify(settings)); }

    // ============================================================
    // ARMAZENAMENTO
    // ============================================================
    // songs: chave de identidade ("titulo|artista" normalizado, ou a propria URI enquanto
    //        nao sabemos titulo/artista) -> dados da musica
    // uris:  URI -> chave. A mesma musica pode ter varias URIs (single, album, remaster,
    //        relinking regional), e todas compartilham o mesmo aprendizado.
    // log:   ultimos eventos aprendidos (aba "Atividade")
    function emptyStore() { return { v: 2, songs: {}, uris: {}, log: [] }; }
    function newSong(name, artist, uri) {
        return { n: name || "", a: artist || "", u: uri || "", l: 0, d: 0, t: now(), p: 0, sk: 0, q: 0, pk: 0, m: 0, lk: 0, lp: 0 };
    }

    var store = loadStore();
    var savePending = false;

    function loadStore() {
        try {
            var s = JSON.parse(LocalStorage.get(STORE_KEY) || "null");
            if (s && s.v === 2 && s.songs && s.uris) {
                if (!Array.isArray(s.log)) s.log = [];
                return s;
            }
        } catch (e) {}
        var fresh = emptyStore();
        migrateLegacy(fresh);
        try { LocalStorage.set(STORE_KEY, JSON.stringify(fresh)); } catch (e) {}
        return fresh;
    }

    // v1 guardava um score por URI. Converte as contagens em evidencia (o score antigo e
    // descartado: ele era inflado/enterrado por bugs). As entradas ficam por URI ate o
    // resolvedor em background descobrir titulo/artista e juntar as duplicatas.
    function migrateLegacy(target) {
        var old = null;
        try { old = JSON.parse(LocalStorage.get(LEGACY_STORE_KEY) || "null"); } catch (e) {}
        if (!old || typeof old !== "object") return;
        for (var uri in old) {
            var o = old[uri];
            if (!o || !isTrackUri(uri)) continue;
            var l = (o.p || 0) + (o.q || 0) + 0.5 * (o.pk || 0);
            var d = 0.6 * (o.sk || 0);
            if (l === 0 && d === 0) continue;
            var song = newSong(o.n && o.n !== uri.split(":").pop() ? o.n : "", "", uri);
            song.l = l; song.d = d; song.t = o.t || now();
            song.p = o.p || 0; song.sk = o.sk || 0; song.q = o.q || 0; song.pk = o.pk || 0;
            target.songs[uri] = song;
            target.uris[uri] = uri;
        }
    }

    function saveStore(immediate) {
        if (immediate) { flushStore(); return; }
        if (savePending) return;
        savePending = true;
        setTimeout(function () { savePending = false; flushStore(); }, 1000);
    }
    function flushStore() {
        try {
            pruneStore();
            LocalStorage.set(STORE_KEY, JSON.stringify(store));
        } catch (e) { console.warn("[AS] falha ao salvar", e); }
    }
    function pruneStore() {
        if (store.log.length > MODEL.maxLog) store.log = store.log.slice(-MODEL.maxLog);
        var keys = Object.keys(store.songs);
        if (keys.length <= MODEL.maxSongs) return;
        var t = now();
        function importance(s) {
            return (s.l + s.d) * decayFactor(s, t) + Math.abs(s.m) * 5 + (s.lk ? 2 : 0) + (t - (s.lp || s.t) < 30 * DAY ? 1 : 0);
        }
        keys.sort(function (a, b) { return importance(store.songs[b]) - importance(store.songs[a]); });
        for (var i = MODEL.maxSongs; i < keys.length; i++) delete store.songs[keys[i]];
        for (var u in store.uris) if (!store.songs[store.uris[u]]) delete store.uris[u];
    }

    // ============================================================
    // IDENTIDADE (junta versoes da mesma musica)
    // ============================================================
    function normText(s) {
        return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    }
    function normTitle(title) {
        var t = normText(title);
        t = t.replace(/\s*[\(\[]\s*(feat|ft|featuring|with|com)\b[^\)\]]*[\)\]]/g, "");
        t = t.replace(/\s*[\(\[][^\)\]]*\bremaster(ed)?\b[^\)\]]*[\)\]]/g, "");
        t = t.replace(/\s+-\s+[^-]*\b(remaster(ed)?|single version|album version|radio edit|mono|stereo)\b.*$/, "");
        t = t.replace(/\s+-\s+(feat|ft)\b.*$/, "");
        return t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    }
    function normArtist(artist) { return normText(artist).replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
    function identityKey(title, artist) {
        var t = normTitle(title), a = normArtist(artist);
        return t && a ? t + "|" + a : null;
    }

    function peekSong(uri) {
        var k = store.uris[uri];
        return k ? store.songs[k] || null : null;
    }
    function keyOf(uri) { return store.uris[uri] || null; }

    // Garante a musica de uma URI. Quando titulo/artista sao conhecidos, junta com outras
    // versoes ja aprendidas da mesma musica.
    function songFor(uri, name, artist) {
        var key = identityKey(name, artist);
        var curKey = store.uris[uri];
        if (!key) {
            if (curKey && store.songs[curKey]) return store.songs[curKey];
            key = uri;
        }
        if (curKey && curKey !== key && store.songs[curKey]) mergeInto(key, curKey);
        var s = store.songs[key];
        if (!s) s = store.songs[key] = newSong(name, artist, uri);
        if (name) s.n = name;
        if (artist) s.a = artist;
        if (!s.u) s.u = uri;
        store.uris[uri] = key;
        return s;
    }

    // Liga uma URI a uma musica ja conhecida (mesmo titulo/artista) sem criar entrada nova
    function identify(uri, name, artist) {
        var key = identityKey(name, artist);
        var curKey = store.uris[uri];
        if (curKey && store.songs[curKey]) {
            if (key && curKey !== key) songFor(uri, name, artist);
            return;
        }
        if (key && store.songs[key]) store.uris[uri] = key;
    }

    function mergeInto(targetKey, srcKey) {
        if (targetKey === srcKey) return;
        var src = store.songs[srcKey], dst = store.songs[targetKey];
        if (!src) return;
        if (!dst) {
            store.songs[targetKey] = src;
        } else {
            var t = now();
            decayTo(dst, t); decayTo(src, t);
            dst.l += src.l; dst.d += src.d;
            dst.p += src.p; dst.sk += src.sk; dst.q += src.q; dst.pk += src.pk;
            if (Math.abs(src.m) > Math.abs(dst.m)) dst.m = src.m;
            dst.lk = dst.lk || src.lk;
            dst.lp = Math.max(dst.lp || 0, src.lp || 0);
            if (!dst.n) dst.n = src.n;
            if (!dst.a) dst.a = src.a;
            if (!dst.u) dst.u = src.u;
        }
        delete store.songs[srcKey];
        for (var u in store.uris) if (store.uris[u] === srcKey) store.uris[u] = targetKey;
    }

    // ============================================================
    // SCORE
    // ============================================================
    function decayFactor(s, t) {
        var dt = (t || now()) - (s.t || 0);
        return dt <= 0 ? 1 : Math.pow(0.5, dt / (MODEL.halfLifeDays * DAY));
    }
    function decayTo(s, t) {
        var f = decayFactor(s, t);
        s.l *= f; s.d *= f; s.t = t;
    }
    function hasHistory(s) { return !!s && (s.l + s.d > 0.05 || !!s.m || !!s.lk); }

    // Preferencia entre -1 e +1. likedOverride: status de Curtida vindo do Spotify (mais fresco que o salvo)
    function preference(s, likedOverride) {
        if (!s) return likedOverride ? MODEL.likedBonus / (MODEL.likedBonus + MODEL.prior) : 0;
        var f = decayFactor(s);
        var liked = likedOverride === undefined ? s.lk : likedOverride;
        var L = s.l * f + (liked ? MODEL.likedBonus : 0);
        var D = s.d * f;
        var p = (L - D) / (L + D + MODEL.prior);
        return clamp(p + (s.m || 0) * MODEL.manualStep, -1, 1);
    }
    function scoreOf(s, likedOverride) { return Math.round(preference(s, likedOverride) * 100); }
    function scoreOfUri(uri) { return scoreOf(peekSong(uri)); }

    function recencyFactor(ago) {
        if (ago >= MODEL.recentWindowMs) return 1;
        return MODEL.recentFloor + (1 - MODEL.recentFloor) * Math.max(0, ago) / MODEL.recentWindowMs;
    }

    function weightFor(uri, t, liked) {
        var s = peekSong(uri);
        var isLiked = liked && uri in liked ? liked[uri] : undefined;
        var p = hasHistory(s) || isLiked ? preference(s, isLiked) : MODEL.novelty;
        var w = Math.exp(STRENGTH[settings.aggressiveness] * p);
        if (settings.avoidRepeats && s && s.lp) w *= recencyFactor(t - s.lp);
        return w;
    }

    // Permutacao aleatoria ponderada (Efraimidis-Spirakis): cada faixa sorteia uma chave
    // log(u)/peso e ordenamos. Mesma distribuicao de "sortear sem reposicao", em O(n log n).
    function weightedShuffle(uris, liked) {
        var t = now();
        return uris.map(function (uri) {
            return { uri: uri, k: Math.log(Math.random()) / weightFor(uri, t, liked) };
        }).sort(function (a, b) { return b.k - a.k; }).map(function (x) { return x.uri; });
    }

    // Evita o mesmo artista duas vezes seguidas trocando com a proxima faixa de outro artista
    function spreadArtists(list, artistOf) {
        var out = list.slice();
        for (var i = 1; i < out.length; i++) {
            var prev = artistOf(out[i - 1]);
            if (!prev || artistOf(out[i]) !== prev) continue;
            for (var j = i + 1; j < Math.min(out.length, i + 6); j++) {
                if (artistOf(out[j]) !== prev) { var tmp = out[i]; out[i] = out[j]; out[j] = tmp; break; }
            }
        }
        return out;
    }

    // ============================================================
    // APRENDIZADO
    // ============================================================
    function logEvent(kind, s, before) {
        store.log.push({ k: kind, n: s.n, a: s.a, t: now(), b: before, s: scoreOf(s) });
        if (store.log.length > MODEL.maxLog + 50) store.log = store.log.slice(-MODEL.maxLog);
    }

    function learn(uri, name, artist, kind, amount) {
        if (!settings.learning || !isTrackUri(uri) || !EVIDENCE[kind]) return null;
        var s = songFor(uri, name, artist);
        var t = now(), before = scoreOf(s), ev = EVIDENCE[kind];
        var a = typeof amount === "number" ? amount : 1;
        decayTo(s, t);
        if (ev.l) s.l += ev.l * a;
        if (ev.d) s.d += ev.d * a;
        switch (kind) {
            case "full": s.p++; s.lp = t; break;
            case "partial": s.lp = t; break;
            case "skip": case "heavySkip": s.sk++; break;
            case "queueAdd": s.q++; break;
            case "pick": s.pk++; break;
        }
        logEvent(kind, s, before);
        debug("learn", kind, a.toFixed(2), s.n, before, "->", scoreOf(s));
        saveStore();
        return s;
    }

    // Turbinar (+1) / Evitar (-1): ajuste manual, nao decai com o tempo
    function nudgeSong(s, dir) {
        var before = scoreOf(s);
        var m = s.m || 0;
        // clicar no oposto primeiro volta pro neutro
        s.m = (m > 0 && dir < 0) || (m < 0 && dir > 0) ? 0 : clamp(m + dir, -MODEL.manualMax, MODEL.manualMax);
        logEvent(dir > 0 ? "boost" : "avoid", s, before);
        saveStore(true);
        return s;
    }
    function nudge(uri, name, artist, dir) { return nudgeSong(songFor(uri, name, artist), dir); }

    function resetSong(s) {
        var before = scoreOf(s);
        s.l = 0; s.d = 0; s.p = 0; s.sk = 0; s.q = 0; s.pk = 0; s.m = 0; s.t = now();
        logEvent("reset", s, before);
        saveStore(true);
    }

    function setLiked(s, liked) {
        if (!!s.lk === !!liked) return;
        var before = scoreOf(s);
        s.lk = liked ? 1 : 0;
        logEvent(liked ? "like" : "unlike", s, before);
        saveStore();
    }

    // ============================================================
    // TRACKER
    // ============================================================
    // Em vez de olhar so a posicao final, soma o tempo realmente ouvido (ignora seeks).
    var cur = null;
    var skipStreak = 0;
    var programmaticUntil = 0;  // trocas de faixa causadas pela propria extensao
    var expectedNext = null;    // o que o Spotify ia tocar em seguida (pra detectar "escolheu outra")
    var knownQueued = {};       // fila manual (provider "queue"), pra detectar adicoes
    var lastShuffleFlag = null;

    function safeProgress() { try { return Spicetify.Player.getProgress() || 0; } catch (e) { return 0; } }
    function contextUriOf(d) {
        return (d && d.context && d.context.uri) || (d && d.item && d.item.metadata && d.item.metadata.context_uri) || null;
    }
    function itemInfo(item) {
        if (!item || !item.uri) return null;
        var md = item.metadata || {};
        var liked = md["collection.in_collection"];
        var img = item.images && (item.images.filter(function (i) { return i.label === "small"; })[0] || item.images[0]);
        return {
            uri: item.uri,
            name: item.name || md.title || "",
            artist: firstArtist(item.artists) || md.artist_name || "",
            duration: (item.duration && item.duration.milliseconds) || parseInt(md.duration, 10) || 0,
            liked: liked === "true" ? 1 : liked === "false" ? 0 : -1,
            image: imageUrl((img && img.url) || md.image_small_url || md.image_url),
        };
    }

    function startTracking(d) {
        var info = d && itemInfo(d.item);
        if (!info || !isTrackUri(info.uri)) { cur = null; return; }
        var pos = safeProgress();
        var dur = info.duration || d.duration || 0;
        cur = {
            uri: info.uri, name: info.name, artist: info.artist, duration: dur,
            context: contextUriOf(d), liked: info.liked,
            listened: 0, lastPos: pos, lastTick: now(), playing: !d.isPaused,
            resumed: dur > 0 && pos > MODEL.resumedRatio * dur,
        };
        var s = peekSong(info.uri);
        if (s && info.liked !== -1) s.lk = info.liked;
    }

    function tick() {
        var d = Spicetify.Player.data;
        if (!d || !d.item) return;
        if (!cur) { startTracking(d); return; }
        if (d.item.uri !== cur.uri) return; // songchange vai tratar
        var t = now(), pos = safeProgress();
        var dPos = pos - cur.lastPos, dWall = t - cur.lastTick;
        if (dPos > 0 && dPos <= dWall * 2 + 1500) {
            cur.listened += dPos;  // tocando normalmente
        } else if (cur.duration && cur.lastPos > 0.9 * cur.duration && pos < 0.1 * cur.duration) {
            // repeat de uma faixa so: deu a volta sem songchange
            finalize("loop");
            startTracking(d);
            return;
        }
        cur.lastPos = pos;
        cur.lastTick = t;
        cur.playing = !d.isPaused;

        // curtiu / descurtiu durante a musica
        var info = itemInfo(d.item);
        if (info && info.liked !== -1 && info.liked !== cur.liked) {
            var wasKnown = cur.liked !== -1;
            cur.liked = info.liked;
            if (wasKnown && settings.learning) setLiked(songFor(cur.uri, cur.name, cur.artist), info.liked);
            else { var known = peekSong(cur.uri); if (known) known.lk = info.liked; }
        }
        expectedNext = peekNextUri();

        // ligou o aleatorio do Spotify: o shuffle automatico assume
        var sh = !!d.shuffle;
        if (lastShuffleFlag === false && sh) maybeAutoShuffle(d, true);
        lastShuffleFlag = sh;
    }

    function onPlayPause() {
        var d = Spicetify.Player.data;
        if (!cur || !d || !d.item || d.item.uri !== cur.uri) return;
        if (d.isPaused) tick();
        cur.playing = !d.isPaused;
        cur.lastPos = safeProgress();
        cur.lastTick = now();
    }

    // Classifica a faixa que acabou de sair. transition: next | jump | context | auto | loop
    function finalize(transition) {
        var c = cur;
        cur = null;
        if (!c || !c.duration) return;
        var t = now();
        var sinceTick = c.playing ? Math.min(t - c.lastTick, 5 * 60000) : 0;
        var endPos = c.lastPos + sinceTick;
        var endedNaturally = transition === "loop" || endPos >= c.duration - 3000;
        if (endedNaturally) c.listened += Math.max(0, Math.min(sinceTick, c.duration - c.lastPos));
        var ratio = c.listened / c.duration;

        var kind = null, amount = 1;
        if (endedNaturally || ratio >= MODEL.fullRatio) kind = "full";
        else if (c.listened < MODEL.minListenMs) kind = null;
        else if (ratio >= MODEL.skipRatio) {
            kind = "partial";
            amount = (ratio - MODEL.skipRatio) / (MODEL.fullRatio - MODEL.skipRatio);
        } else kind = ratio < MODEL.heavySkipRatio ? "heavySkip" : "skip";

        if (kind === "skip" || kind === "heavySkip") {
            if (c.resumed || transition === "auto") kind = null;
            else {
                if (transition === "jump" || transition === "context") amount *= 0.5; // trocou por outra coisa, nao "odiou"
                amount /= 1 + 0.5 * skipStreak; // varios pulos seguidos = procurando algo, cada um pesa menos
            }
        }
        if (kind === "full" || kind === "partial") skipStreak = 0;
        else if (transition !== "auto") skipStreak++;

        debug("finalize", c.name, transition, kind, "ratio", ratio.toFixed(2), "streak", skipStreak);
        if (kind) learn(c.uri, c.name, c.artist, kind, amount);
    }

    function onSongChange(d) {
        var info = d && itemInfo(d.item);
        var newUri = info && info.uri;
        var newCtx = contextUriOf(d);
        var transition = "next";
        if (now() < programmaticUntil) transition = "auto";
        else if (cur && cur.context && newCtx && newCtx !== cur.context) transition = "context";
        else if (newUri && expectedNext && newUri !== expectedNext) transition = "jump";

        finalize(transition);
        if (transition === "jump" && info && isTrackUri(newUri)) learn(newUri, info.name, info.artist, "pick");

        startTracking(d);
        expectedNext = peekNextUri();
        checkQueueAdds();
        maybeAutoShuffle(d, false);
        if (panel && !panel.closing) renderTrack(panel, true);
    }

    Spicetify.Player.addEventListener("onprogress", function () { try { tick(); } catch (e) { debug("tick", e); } });
    Spicetify.Player.addEventListener("onplaypause", function () { try { onPlayPause(); } catch (e) { debug("playpause", e); } });
    Spicetify.Player.addEventListener("songchange", function (ev) {
        try { onSongChange((ev && ev.data) || Spicetify.Player.data); } catch (e) { console.warn("[AS] songchange", e); }
    });

    // ============================================================
    // FILA
    // ============================================================
    function queueApi() { return Spicetify.Platform.PlayerAPI._queue; }
    function queueState() {
        try {
            var qs = queueApi()._queueState;
            return { queued: qs.queued || [], nextUp: qs.nextUp || [] };
        } catch (e) { return { queued: [], nextUp: [] }; }
    }
    function peekNextUri() {
        var qs = queueState();
        var lists = [qs.queued, qs.nextUp];
        for (var i = 0; i < lists.length; i++) {
            for (var j = 0; j < lists[i].length; j++) {
                var u = lists[i][j] && lists[i][j].uri;
                if (u && u !== DELIMITER) return u;
            }
        }
        return null;
    }
    function contextItemsLeft() {
        var n = 0, nextUp = queueState().nextUp;
        for (var i = 0; i < nextUp.length; i++) {
            if (nextUp[i].uri === DELIMITER) break;
            if (nextUp[i].provider === "context") n++;
        }
        return n;
    }

    function checkQueueAdds() {
        var queued = queueState().queued.filter(function (i) { return i && isTrackUri(i.uri); });
        var added = queued.filter(function (i) { return !knownQueued[i.uri]; });
        knownQueued = {};
        queued.forEach(function (i) { knownQueued[i.uri] = true; });
        if (!added.length) return;
        // adicionar um album inteiro de uma vez e um sinal fraco por faixa
        var amount = added.length >= 5 ? 0.3 : 1;
        added.forEach(function (i) { learn(i.uri, i.name, firstArtist(i.artists), "queueAdd", amount); });
    }
    setInterval(function () {
        try { checkQueueAdds(); if (!cur || !cur.playing) expectedNext = peekNextUri(); } catch (e) { debug("queue poll", e); }
    }, 2000);

    function contextTrack(uri) {
        return { contextTrack: { uri: uri, uid: "", metadata: { is_queued: "false" } }, removed: [], blocked: [], provider: "context" };
    }
    function rawNextTracks() {
        try { return queueApi()._queue.nextTracks || []; } catch (e) { return []; }
    }
    function rawUri(t) { return t && t.contextTrack && t.contextTrack.uri; }

    function applyQueue(nextTracks) {
        var q = queueApi();
        q._client.setQueue({ nextTracks: nextTracks, prevTracks: q._queue.prevTracks, queueRevision: q._queue.queueRevision });
        // a fila manual continua igual: nao conta como adicao
        knownQueued = {};
        nextTracks.forEach(function (t) { if (t.provider === "queue" && rawUri(t)) knownQueued[rawUri(t)] = true; });
        var first = nextTracks.filter(function (t) { return rawUri(t) && rawUri(t) !== DELIMITER; })[0];
        expectedNext = first ? rawUri(first) : null;
    }

    // ---- busca do contexto inteiro (playlist, album, Curtidas, artista) ----
    async function fetchPlaylistTracks(uri) {
        var res = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 9999999 });
        return res.items.filter(function (t) { return t.isPlayable !== false && isTrackUri(t.uri); })
            .map(function (t) { return { uri: t.uri, name: t.name, artist: firstArtist(t.artists) }; });
    }
    async function fetchAlbumTracks(uri) {
        var res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.queryAlbumTracks, { uri: uri, offset: 0, limit: 500 });
        if (res.errors) throw new Error(res.errors[0].message);
        var u = res.data.albumUnion;
        var items = ((u && (u.tracksV2 || u.tracks)) || {}).items || [];
        return items.filter(function (i) { return i.track && (!i.track.playability || i.track.playability.playable); })
            .map(function (i) { return { uri: i.track.uri, name: i.track.name, artist: firstArtist(i.track.artists) }; });
    }
    async function fetchLikedTracks() {
        var res = await Spicetify.Platform.LibraryAPI.getTracks({ limit: 9999999 });
        return res.items.filter(function (t) { return t.isPlayable !== false && isTrackUri(t.uri); })
            .map(function (t) { return { uri: t.uri, name: t.name, artist: firstArtist(t.artists) }; });
    }
    async function fetchArtistTracks(uri) {
        var res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.queryArtistOverview,
            { uri: uri, locale: Spicetify.Locale ? Spicetify.Locale.getLocale() : "", includePrerelease: false });
        if (res.errors) throw new Error(res.errors[0].message);
        return res.data.artistUnion.discography.topTracks.items.map(function (i) {
            return { uri: i.track.uri, name: i.track.name, artist: firstArtist(i.track.artists) };
        });
    }
    async function fetchContextTracks(uri, allowArtist) {
        if (!uri) return null;
        if (isPlaylistUri(uri)) return fetchPlaylistTracks(uri);
        if (isAlbumUri(uri)) return fetchAlbumTracks(uri);
        if (isLikedSongsUri(uri)) return fetchLikedTracks();
        if (allowArtist && isArtistUri(uri)) return fetchArtistTracks(uri);
        return null;
    }

    async function likedMap(uris, ctx) {
        var out = {};
        if (isLikedSongsUri(ctx)) { uris.forEach(function (u) { out[u] = true; }); return out; }
        var lib = Spicetify.Platform.LibraryAPI;
        if (!lib || !lib.contains) return out;
        for (var i = 0; i < uris.length; i += 200) {
            var chunk = uris.slice(i, i + 200);
            try {
                var res = await lib.contains.apply(lib, chunk);
                chunk.forEach(function (u, j) { out[u] = !!(res && res[j]); });
            } catch (e) { debug("contains", e); }
        }
        return out;
    }

    function dedupeTracks(list) {
        var seen = {};
        return list.filter(function (x) { if (!x.uri || seen[x.uri]) return false; seen[x.uri] = true; return true; });
    }

    // Ordena uma lista de faixas {uri, name, artist} pelo gosto aprendido
    function adaptiveOrder(tracks, liked) {
        var byUri = {};
        tracks.forEach(function (x) {
            byUri[x.uri] = x;
            identify(x.uri, x.name, x.artist);
            var s = peekSong(x.uri);
            if (s && liked && x.uri in liked) s.lk = liked[x.uri] ? 1 : 0;
        });
        var order = weightedShuffle(tracks.map(function (x) { return x.uri; }), liked);
        if (settings.spreadArtists) order = spreadArtists(order, function (u) { return normArtist(byUri[u] && byUri[u].artist); });
        saveStore();
        return order;
    }

    function previewOf(order) {
        return order.slice(0, 3).map(function (u) { var s = peekSong(u); return s && s.n ? s.n : null; }).filter(Boolean).join(", ");
    }

    // Reordena o que vem depois da musica atual. Mantem a fila manual na frente.
    async function reshuffle(opts) {
        opts = opts || {};
        try {
            var d = Spicetify.Player.data;
            var ctx = contextUriOf(d);
            var current = d && d.item && d.item.uri;
            var userQueued = rawNextTracks().filter(function (t) { return t.provider === "queue"; });

            var list = null;
            try { list = await fetchContextTracks(ctx, false); } catch (e) { debug("fetch context", e); }
            if (list) list = dedupeTracks(list.filter(function (x) { return x.uri !== current; }));

            if (list && list.length >= 2) {
                var liked = await likedMap(list.map(function (x) { return x.uri; }), ctx);
                var order = adaptiveOrder(list, liked);
                applyQueue(userQueued.concat(order.concat([DELIMITER]).map(contextTrack)));
                if (!opts.silent) notify(order.length + " músicas reorganizadas" + (previewOf(order) ? " · a seguir: " + previewOf(order) : ""));
                return true;
            }

            // Contexto que nao da pra buscar inteiro (radio, artista, DJ...): reordena so o
            // trecho do contexto que ja esta na fila, mantendo os objetos originais do Spotify.
            var raw = rawNextTracks();
            var ctxItems = raw.filter(function (t) { return t.provider === "context" && isTrackUri(rawUri(t)); });
            if (ctxItems.length < 2) {
                if (!opts.silent) notify("Não há músicas suficientes na fila para embaralhar");
                return false;
            }
            var rest = raw.filter(function (t) { return t.provider !== "queue" && ctxItems.indexOf(t) === -1; });
            var pool = {};
            ctxItems.forEach(function (t) { (pool[rawUri(t)] = pool[rawUri(t)] || []).push(t); });
            var tracks = ctxItems.map(function (t) {
                var md = t.contextTrack.metadata || {};
                return { uri: rawUri(t), name: md.title || "", artist: md.artist_name || "" };
            });
            var order2 = adaptiveOrder(dedupeTracks(tracks), null);
            var reordered = [];
            order2.forEach(function (u) { reordered = reordered.concat(pool[u]); });
            applyQueue(userQueued.concat(reordered, rest));
            if (!opts.silent) notify(reordered.length + " músicas da fila reorganizadas");
            return true;
        } catch (e) {
            console.error("[AS] reshuffle", e);
            if (!opts.silent) notify("Não consegui reorganizar a fila: " + ((e && e.message) || e), true);
            return false;
        }
    }

    // Toca um contexto (playlist, album, artista, Curtidas) ja na ordem adaptativa
    async function playAdaptive(ctxUri) {
        try {
            var list = await fetchContextTracks(ctxUri, true);
            if (!list || !list.length) { notify("Nada para tocar aqui"); return; }
            list = dedupeTracks(list);
            var liked = await likedMap(list.map(function (x) { return x.uri; }), ctxUri);
            var order = adaptiveOrder(list, liked);
            var userQueued = rawNextTracks().filter(function (t) { return t.provider === "queue"; });
            programmaticUntil = now() + 4000; // trocar de faixa agora nao e "pular" a atual
            applyQueue(userQueued.concat(order.concat([DELIMITER]).map(contextTrack)));
            try {
                var sessionId = Spicetify.Platform.PlayerAPI.getState().sessionId;
                Spicetify.Platform.PlayerAPI.updateContext(sessionId, { uri: ctxUri, url: "context://" + ctxUri });
            } catch (e) { debug("updateContext", e); }
            Spicetify.Player.next();
            lastAutoContext = ctxUri;
            notify("Tocando " + order.length + " músicas no Adaptive Shuffle");
        } catch (e) {
            console.error("[AS] playAdaptive", e);
            notify("Não consegui tocar: " + ((e && e.message) || e), true);
        }
    }

    // ---- shuffle automatico ----
    // Com o aleatorio do Spotify ligado, assume a ordem quando um contexto novo comeca,
    // quando o aleatorio e ligado, e quando a fila esta acabando.
    var autoBusy = false, lastAutoContext = null;
    function maybeAutoShuffle(d, force) {
        if (!settings.autoShuffle || autoBusy || !d || !d.item) return;
        var ctx = contextUriOf(d);
        if (!ctx || !d.shuffle || d.smartShuffle) return;
        if (!force && ctx === lastAutoContext && contextItemsLeft() >= 3) return;
        lastAutoContext = ctx;
        autoBusy = true;
        function done() { autoBusy = false; }
        setTimeout(function () { reshuffle({ silent: true }).then(done, done); }, 800);
    }

    // ============================================================
    // RESOLVEDOR EM BACKGROUND
    // ============================================================
    // Descobre titulo/artista de faixas antigas (guardadas so por URI) pra juntar duplicatas,
    // e atualiza o status de Curtida das musicas conhecidas.
    async function backgroundMaintenance() {
        try {
            var defs = Spicetify.GraphQL && Spicetify.GraphQL.Definitions;
            var pending = Object.keys(store.songs).filter(function (k) { return /^spotify:track:/.test(k); });
            if (defs && defs.decorateContextTracks && pending.length) {
                for (var i = 0; i < pending.length; i += 50) {
                    var chunk = pending.slice(i, i + 50);
                    try {
                        var res = await Spicetify.GraphQL.Request(defs.decorateContextTracks, { uris: chunk });
                        var tracks = (res && res.data && res.data.tracks) || [];
                        tracks.forEach(function (tr) {
                            if (tr && tr.uri && tr.name && store.uris[tr.uri]) songFor(tr.uri, tr.name, firstArtist(tr.artists));
                        });
                    } catch (e) { debug("resolve chunk", e); }
                    await sleep(400);
                }
            }
            var uris = Object.keys(store.uris).filter(isTrackUri);
            var liked = await likedMap(uris, null);
            var likedKeys = {};
            uris.forEach(function (u) { if (u in liked) likedKeys[store.uris[u]] = likedKeys[store.uris[u]] || liked[u]; });
            for (var k in likedKeys) if (store.songs[k]) store.songs[k].lk = likedKeys[k] ? 1 : 0;
            saveStore();
            debug("manutencao ok", pending.length, "resolvidas,", uris.length, "checadas");
        } catch (e) { debug("maintenance", e); }
    }

    // ============================================================
    // UI: estilos, icones e movimento
    // ============================================================
    const ICON_SVG = '<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M1.5 4.5h1.8c1.3 0 2.1.5 2.8 1.5l3.3 5c.7 1 1.5 1.5 2.8 1.5h1.6"/>' +
        '<path d="M12.3 10.8l1.7 1.7-1.7 1.7"/>' +
        '<path d="M1.5 12.5h1.8c1.3 0 2.1-.5 2.8-1.5l.5-.7"/>' +
        '<path d="M9.4 6l.4-.6c.5-.7 1-1.1 1.7-1.3"/>' +
        '<path d="M13.2 1.3l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" fill="currentColor" stroke-width="0.6"/>' +
        '</svg>';

    function svgIcon(name, size) {
        var p = Spicetify.SVGIcons && Spicetify.SVGIcons[name];
        if (!p) return "";
        size = size || 16;
        return '<svg role="img" height="' + size + '" width="' + size + '" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' + p + "</svg>";
    }

    function reducedMotion() {
        try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; }
    }

    // Anima um numero de `from` ate `to` (ease-out) escrevendo em el.textContent. Devolve o cancelador.
    function tweenNumber(node, from, to, format, duration) {
        format = format || String;
        if (from === to || reducedMotion() || !window.requestAnimationFrame) { node.textContent = format(to); return function () {}; }
        var dur = duration || 560, start = null, raf = 0;
        function frame(t) {
            if (start === null) start = t;
            var k = Math.min(1, (t - start) / dur);
            var eased = 1 - Math.pow(1 - k, 4);
            node.textContent = format(Math.round(from + (to - from) * eased));
            if (k < 1) raf = requestAnimationFrame(frame);
        }
        node.textContent = format(from);
        raf = requestAnimationFrame(frame);
        return function () { cancelAnimationFrame(raf); };
    }

    // Reinicia uma animacao CSS baseada em classe (ex.: "as-bump")
    function replay(node, cls) {
        if (!node) return;
        node.classList.remove(cls);
        void node.offsetWidth;
        node.classList.add(cls);
        node.addEventListener("animationend", function done(e) {
            if (e.target !== node) return;
            node.classList.remove(cls);
            node.removeEventListener("animationend", done);
        });
    }

    // Tokens: todos os raios sao concentricos a partir destes valores, e todo movimento usa
    // as mesmas curvas: ease-out longo pra entradas, spring curto pra respostas a clique.
    const CSS = [
        ".as-pop,.as-settings,.as-welcome,#as-playbar-button{" +
            "--as-ease-out:cubic-bezier(.16,1,.3,1);--as-ease-spring:cubic-bezier(.34,1.5,.64,1);--as-ease-in:cubic-bezier(.55,0,.75,.2);" +
            "--as-fast:.2s;--as-med:.34s;--as-slow:.6s;" +
            "--as-r-xl:28px;--as-r-lg:22px;--as-r-md:16px;--as-r-sm:12px;--as-pill:999px;" +
            "--as-green:#1ed760;--as-red:#f3727f;" +
            "--as-fill-1:rgba(255,255,255,.055);--as-fill-2:rgba(255,255,255,.1);--as-fill-3:rgba(255,255,255,.16);--as-hair:rgba(255,255,255,.08)}",

        // ---- keyframes ----
        "@keyframes as-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
        "@keyframes as-pop-in{from{opacity:0;transform:translateY(12px) scale(.94)}to{opacity:1;transform:none}}",
        "@keyframes as-pop-out{to{opacity:0;transform:translateY(8px) scale(.96)}}",
        "@keyframes as-grow{from{transform:scaleX(0)}to{transform:none}}",
        "@keyframes as-bump{0%{transform:scale(1)}35%{transform:scale(1.24)}100%{transform:scale(1)}}",
        "@keyframes as-float{0%{opacity:0;transform:translateY(6px) scale(.85)}25%{opacity:1;transform:translateY(-2px) scale(1)}100%{opacity:0;transform:translateY(-18px)}}",
        "@keyframes as-kick-up{40%{transform:translateY(-4px) scale(1.15)}}",
        "@keyframes as-kick-down{40%{transform:translateY(4px) scale(1.15)}}",
        "@keyframes as-fade{from{opacity:.15}to{opacity:1}}",
        "@keyframes as-swap{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}",
        "@keyframes as-pop-small{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}",
        "@keyframes as-countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}",

        // ---- botao da barra ----
        "#as-playbar-button{display:inline-flex;align-items:center;justify-content:center;position:relative;transition:color var(--as-fast) ease-out}",
        "#as-playbar-button svg{margin:0!important;transition:transform var(--as-med) var(--as-ease-spring)}",
        "#as-playbar-button:hover svg{transform:scale(1.12)}",
        "#as-playbar-button:active svg{transform:scale(.86);transition-duration:.08s}",
        "#as-playbar-button.as-open{color:var(--text-base,#fff)!important}",
        "#as-playbar-button::after{content:'';position:absolute;bottom:1px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--as-green);transform:scale(0);opacity:0;transition:transform var(--as-med) var(--as-ease-spring),opacity var(--as-fast) ease-out}",
        "#as-playbar-button.main-genericButton-buttonActive{color:var(--as-green)!important}",
        "#as-playbar-button.main-genericButton-buttonActive::after{transform:none;opacity:1}",

        // ---- painel (popover de vidro) ----
        ".as-pop{position:fixed;z-index:9999;width:320px;box-sizing:border-box;padding:16px;border-radius:var(--as-r-lg);" +
            "background:rgba(38,38,38,.78);-webkit-backdrop-filter:blur(16px) saturate(1.5);backdrop-filter:blur(16px) saturate(1.5);" +
            "box-shadow:0 28px 70px rgba(0,0,0,.5),0 6px 18px rgba(0,0,0,.3);" +
            "color:var(--text-base,#fff);font-family:var(--encore-body-font-stack,inherit);font-size:14px;" +
            "transform-origin:var(--as-origin,50% 100%);animation:as-pop-in .48s var(--as-ease-out) both}",
        ".as-pop.as-closing{animation:as-pop-out .2s var(--as-ease-in) both;pointer-events:none}",
        ".as-pop *{box-sizing:border-box}",
        ".as-rise{animation:as-rise .55s var(--as-ease-out) both;animation-delay:calc(var(--i,0) * 32ms + 60ms)}",
        ".as-kicker{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-subdued,#b3b3b3);margin-bottom:12px;display:flex;align-items:center;gap:6px}",
        ".as-track.as-swap{animation:as-swap .5s var(--as-ease-out)}",
        ".as-head{display:flex;gap:12px;align-items:center;min-width:0}",
        ".as-cover{width:56px;height:56px;border-radius:var(--as-r-sm);object-fit:cover;flex:none;background:var(--as-fill-2);box-shadow:0 8px 20px rgba(0,0,0,.35);" +
            "opacity:0;transform:scale(.94);transition:opacity var(--as-med) ease-out,transform var(--as-slow) var(--as-ease-out)}",
        ".as-cover.as-loaded,.as-cover.as-blank{opacity:1;transform:none}",
        ".as-head-text{min-width:0;flex:1}",
        ".as-title{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".as-sub{color:var(--text-subdued,#b3b3b3);font-size:13px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".as-scoreline{position:relative;display:flex;align-items:center;gap:12px;margin-top:16px}",
        ".as-meter{position:relative;flex:1;height:6px;border-radius:var(--as-pill);background:var(--as-fill-2);min-width:40px}",
        ".as-meter-fill{position:absolute;top:0;bottom:0;border-radius:var(--as-pill);" +
            "transition:left .7s var(--as-ease-out),width .7s var(--as-ease-out),background-color .45s ease-out;animation:as-grow .8s var(--as-ease-out) both}",
        ".as-meter-mid{position:absolute;left:50%;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:var(--as-pill);background:rgba(255,255,255,.35)}",
        ".as-score{display:inline-block;min-width:44px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700;transition:color .45s ease-out}",
        ".as-score.as-bump{animation:as-bump .5s var(--as-ease-spring)}",
        ".as-delta{position:absolute;right:0;top:-10px;font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;pointer-events:none;animation:as-float 1s var(--as-ease-out) both}",
        ".as-pos{color:var(--as-green,#1ed760)}.as-neg{color:var(--as-red,#f3727f)}.as-zero{color:var(--text-subdued,#b3b3b3)}",
        ".as-facts{margin-top:8px;color:var(--text-subdued,#b3b3b3);font-size:12px;line-height:1.45}",
        ".as-facts.as-fade{animation:as-fade .45s ease-out}",
        ".as-heart{color:var(--as-green,#1ed760);display:inline-flex;vertical-align:-2px;margin-right:4px}",
        ".as-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px}",
        ".as-sep{height:1px;background:var(--as-hair);margin:16px -16px 8px}",
        ".as-item{display:flex;align-items:center;gap:12px;padding:10px;margin:0 -8px;border-radius:var(--as-r-sm);cursor:pointer;user-select:none;outline:none;" +
            "transition:background-color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-item:hover,.as-item:focus-visible{background:var(--as-fill-2)}",
        ".as-item:active{transform:scale(.98);transition-duration:.08s}",
        ".as-item-icon{display:inline-flex;color:var(--text-subdued,#b3b3b3);flex:none;transition:color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-item:hover .as-item-icon{color:var(--text-base,#fff);transform:scale(1.1)}",
        ".as-item-label{flex:1}",

        // ---- controles compartilhados ----
        ".as-btn{appearance:none;border:0;border-radius:var(--as-pill);padding:9px 16px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;" +
            "background:var(--as-fill-2);color:var(--text-base,#fff);display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;position:relative;overflow:hidden;" +
            "transition:background-color var(--as-med) var(--as-ease-out),color var(--as-med) var(--as-ease-out),transform var(--as-med) var(--as-ease-spring),box-shadow var(--as-med) var(--as-ease-out)}",
        ".as-btn:hover{background:var(--as-fill-3)}",
        ".as-btn:active{transform:scale(.95);transition-duration:.08s}",
        ".as-btn svg{flex:none}",
        ".as-btn.as-kick-up svg{animation:as-kick-up .5s var(--as-ease-spring)}",
        ".as-btn.as-kick-down svg{animation:as-kick-down .5s var(--as-ease-spring)}",
        ".as-btn.as-on-pos{background:rgba(30,215,96,.16);color:var(--as-green)}.as-btn.as-on-pos:hover{background:rgba(30,215,96,.24)}",
        ".as-btn.as-on-neg{background:rgba(243,114,127,.16);color:var(--as-red)}.as-btn.as-on-neg:hover{background:rgba(243,114,127,.24)}",
        ".as-btn.as-primary{background:var(--as-green);color:#000}",
        ".as-btn.as-primary:hover{background:#3be477;box-shadow:0 8px 24px rgba(30,215,96,.28)}",
        ".as-btn.as-danger{background:rgba(243,114,127,.14);color:var(--as-red)}",
        ".as-btn.as-danger:hover{background:rgba(243,114,127,.22)}",
        ".as-btn.as-danger.as-armed{background:#e22134;color:#fff}",
        ".as-btn.as-danger.as-armed::after{content:'';position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.6);transform-origin:left;animation:as-countdown 4s linear forwards}",
        ".as-btn:focus-visible,.as-icon-btn:focus-visible,.as-switch:focus-visible,.as-seg button:focus-visible{outline:2px solid rgba(255,255,255,.7);outline-offset:2px}",
        ".as-switch{appearance:none;border:0;padding:0;flex:none;width:42px;height:26px;border-radius:var(--as-pill);background:rgba(255,255,255,.22);position:relative;cursor:pointer;" +
            "transition:background-color .35s var(--as-ease-out)}",
        ".as-switch::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:var(--as-pill);background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.3);" +
            "transition:transform .45s var(--as-ease-spring),width .28s var(--as-ease-out)}",
        ".as-switch.on{background:var(--as-green)}",
        ".as-switch.on::after{transform:translateX(16px)}",
        // como no iOS: o botao "estica" enquanto esta pressionado
        ".as-switch:active::after,.as-item:active .as-switch::after{width:25px}",
        ".as-switch.on:active::after,.as-item:active .as-switch.on::after{transform:translateX(11px)}",
        ".as-icon-btn{appearance:none;border:0;background:transparent;color:var(--text-subdued,#b3b3b3);width:30px;height:30px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;" +
            "transition:background-color var(--as-fast) ease-out,color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-icon-btn:hover{background:var(--as-fill-2);color:var(--text-base,#fff)}",
        ".as-icon-btn:active{transform:scale(.82);transition-duration:.08s}",

        // ---- segmented control com indicador deslizante ----
        ".as-seg{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:3px;border-radius:var(--as-pill);background:var(--as-fill-2);flex:none;isolation:isolate}",
        ".as-seg-wide{display:grid}",
        ".as-seg-thumb{position:absolute;z-index:-1;top:3px;bottom:3px;left:3px;width:calc((100% - 6px) / var(--n));border-radius:var(--as-pill);background:var(--text-base,#fff);" +
            "box-shadow:0 3px 10px rgba(0,0,0,.3);transform:translateX(calc(var(--idx) * 100%));transition:transform .55s var(--as-ease-spring),opacity .25s ease-out}",
        ".as-seg.as-none .as-seg-thumb{opacity:0}",
        ".as-seg button{appearance:none;border:0;background:transparent;color:var(--text-subdued,#b3b3b3);font:inherit;font-size:13px;font-weight:700;padding:7px 14px;border-radius:var(--as-pill);cursor:pointer;white-space:nowrap;" +
            "transition:color .35s var(--as-ease-out)}",
        ".as-seg button:hover{color:var(--text-base,#fff)}",
        ".as-seg button.on{color:#000}",

        // ---- modal (configuracoes / boas-vindas) ----
        ".as-dialog{border-radius:28px!important;overflow:hidden}",
        // o modal do Spicetify abre seco: entrada com ease-out e fundo desfocado
        "@keyframes as-modal-in{from{opacity:0;transform:translateY(18px) scale(.965)}to{opacity:1;transform:none}}",
        ".as-modal{border-radius:28px!important;animation:as-modal-in .6s cubic-bezier(.16,1,.3,1) both;" +
            "background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.015) 40%),rgba(34,34,34,.58)!important;" +
            "-webkit-backdrop-filter:blur(28px) saturate(1.8);backdrop-filter:blur(28px) saturate(1.8);box-shadow:0 30px 80px rgba(0,0,0,.45);will-change:transform,opacity}",
        // Fundo do modal: o desfoque fica num ::before em vez do proprio overlay. Se o overlay tivesse
        // backdrop-filter, ele viraria a "raiz" do vidro e o modal so enxergaria o preto do overlay
        // (sem vidro). E em vez de animar o raio do blur (caro, travava), so a opacidade do ::before anima.
        "@keyframes as-veil-in{from{opacity:0}}",
        "@keyframes as-veil-out{to{opacity:0}}",
        ".as-overlay{background:transparent!important}",
        ".as-overlay::before{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;" +
            "background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2);will-change:opacity;animation:as-veil-in .45s ease-out both}",
        ".as-overlay.as-modal-closing::before{animation:as-veil-out .24s ease-in both}",
        ".as-overlay>*{position:relative;z-index:1}",
        "@keyframes as-modal-out{to{opacity:0;transform:translateY(12px) scale(.97)}}",
        ".as-modal.as-modal-closing{animation:as-modal-out .22s cubic-bezier(.55,0,.75,.2) both!important;pointer-events:none}",
        ".as-dialog-wide{width:min(660px,92vw)!important;max-width:min(660px,92vw)!important}",
        ".as-settings,.as-welcome{font-family:var(--encore-body-font-stack,inherit);color:var(--text-base,#fff);font-size:14px}",
        ".as-settings{padding-bottom:8px}",
        ".as-settings *,.as-welcome *{box-sizing:border-box}",
        ".as-sec{margin-top:26px;animation:as-rise .65s var(--as-ease-out) both;animation-delay:calc(var(--i,0) * 80ms)}",
        ".as-sec:first-child{margin-top:4px}",
        ".as-sec-title{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-subdued,#b3b3b3);margin:0 0 10px 4px}",
        ".as-card{background:var(--as-fill-1);border-radius:var(--as-r-md);padding:2px 16px}",
        ".as-srow{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--as-hair)}",
        ".as-srow:last-child{border-bottom:0}",
        ".as-srow-text{flex:1;min-width:0}",
        ".as-srow-title{font-weight:600}",
        ".as-srow-desc{color:var(--text-subdued,#b3b3b3);font-size:13px;margin-top:3px;line-height:1.45}",
        ".as-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}",
        ".as-stat{background:var(--as-fill-1);border-radius:var(--as-r-md);padding:14px 16px;transition:background-color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-stat:hover{background:var(--as-fill-2);transform:translateY(-2px)}",
        ".as-stat b{display:block;font-size:26px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.15}",
        ".as-stat span{font-size:12px;color:var(--text-subdued,#b3b3b3)}",
        ".as-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}",
        ".as-searchbox{position:relative;flex:1;min-width:170px}",
        ".as-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);display:inline-flex;color:var(--text-subdued,#b3b3b3);pointer-events:none;transition:color var(--as-fast) ease-out}",
        ".as-searchbox:focus-within .as-search-icon{color:var(--text-base,#fff)}",
        ".as-search{width:100%;height:36px;border-radius:var(--as-pill);border:0;padding:0 36px;background:var(--as-fill-2);color:var(--text-base,#fff);font:inherit;font-size:13px;outline:none;" +
            "transition:background-color var(--as-fast) ease-out,box-shadow var(--as-med) var(--as-ease-out)}",
        ".as-search:hover{background:var(--as-fill-3)}",
        ".as-search:focus{background:var(--as-fill-3);box-shadow:0 0 0 2px rgba(255,255,255,.35)}",
        ".as-search-clear{position:absolute;right:6px;top:50%;width:24px;height:24px;margin-top:-12px;border:0;border-radius:50%;background:var(--as-fill-3);color:var(--text-base,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;" +
            "animation:as-pop-small .35s var(--as-ease-spring);transition:background-color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-search-clear:hover{background:rgba(255,255,255,.26)}.as-search-clear:active{transform:scale(.85)}",
        ".as-list{height:340px;overflow-y:auto;margin:0 -10px;padding:6px 10px 10px;" +
            "-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 8px,#000 calc(100% - 16px),transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 8px,#000 calc(100% - 16px),transparent 100%)}",
        ".as-list::-webkit-scrollbar{width:10px}",
        ".as-list::-webkit-scrollbar-track{background:transparent}",
        ".as-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:var(--as-pill);border:3px solid transparent;background-clip:padding-box}",
        ".as-list::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.3)}",
        ".as-song,.as-act{display:flex;align-items:center;gap:12px;padding:8px 10px;margin:0 -10px;border-radius:var(--as-r-sm);" +
            "transition:background-color var(--as-fast) ease-out;animation:as-rise .5s var(--as-ease-out) both;animation-delay:calc(min(var(--i,0), 14) * 24ms)}",
        ".as-song:hover,.as-act:hover{background:var(--as-fill-1)}",
        ".as-song-main{flex:1;min-width:0}",
        ".as-song-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14px}",
        ".as-song-sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--text-subdued,#b3b3b3);margin-top:1px}",
        ".as-song .as-meter{flex:none;width:90px}",
        ".as-song-actions{display:flex;gap:2px;opacity:0;transform:translateX(10px);transition:opacity var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-out)}",
        ".as-song:hover .as-song-actions,.as-song:focus-within .as-song-actions{opacity:1;transform:none}",
        ".as-empty{color:var(--text-subdued,#b3b3b3);padding:28px 0;text-align:center;animation:as-rise .5s var(--as-ease-out) both}",
        ".as-act{font-size:13px}",
        ".as-act-kind{flex:none;width:122px;color:var(--text-subdued,#b3b3b3)}",
        ".as-act-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".as-act-delta{flex:none;padding:3px 10px;border-radius:var(--as-pill);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--as-fill-1)}",
        ".as-act-delta.as-pos{background:rgba(30,215,96,.12)}.as-act-delta.as-neg{background:rgba(243,114,127,.12)}",
        ".as-act-time{flex:none;width:64px;text-align:right;color:var(--text-subdued,#b3b3b3);font-size:12px}",
        ".as-btnrow{display:flex;gap:8px;flex-wrap:wrap}",
        ".as-note{color:var(--text-subdued,#b3b3b3);font-size:13px;line-height:1.45;margin:0 4px 12px}",
        ".as-foot{margin-top:22px;font-size:12px;color:var(--text-subdued,#b3b3b3);text-align:center;animation:as-rise .6s var(--as-ease-out) both;animation-delay:.3s}",

        // ---- boas-vindas ----
        ".as-welcome h2{font-size:24px;letter-spacing:-.01em;margin:0 0 6px;animation:as-rise .6s var(--as-ease-out) both}",
        ".as-welcome p{color:var(--text-subdued,#b3b3b3);line-height:1.5;margin:0 0 18px;animation:as-rise .6s var(--as-ease-out) both;animation-delay:.06s}",
        ".as-steps{display:grid;gap:10px}",
        ".as-step{display:flex;gap:14px;background:var(--as-fill-1);border-radius:var(--as-r-md);padding:14px 16px;" +
            "animation:as-rise .6s var(--as-ease-out) both;animation-delay:calc(var(--i,0) * 90ms + 140ms);transition:background-color var(--as-fast) ease-out,transform var(--as-med) var(--as-ease-spring)}",
        ".as-step:hover{background:var(--as-fill-2);transform:translateY(-1px)}",
        ".as-step-n{flex:none;width:26px;height:26px;border-radius:50%;background:var(--as-green);color:#000;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:13px;" +
            "animation:as-pop-small .6s var(--as-ease-spring) both;animation-delay:calc(var(--i,0) * 90ms + 260ms)}",
        ".as-step b{display:block;margin-bottom:3px}",
        ".as-step span{color:var(--text-subdued,#b3b3b3);font-size:13px;line-height:1.45}",
        ".as-welcome .as-btnrow{margin-top:20px;animation:as-rise .6s var(--as-ease-out) both;animation-delay:.48s}",

        // ---- acessibilidade: quem pediu menos movimento no sistema nao ve animacao ----
        "@media (prefers-reduced-motion:reduce){.as-pop,.as-pop *,.as-settings,.as-settings *,.as-welcome,.as-welcome *,#as-playbar-button,#as-playbar-button *," +
            ".as-modal,.as-overlay,.as-modal-closing{" +
            "animation-duration:1ms!important;animation-delay:0s!important;transition-duration:1ms!important}}",
    ].join("\n");

    (function injectStyles() {
        try {
            var old = document.getElementById("as-styles");
            if (old && old.remove) old.remove();
            var s = document.createElement("style");
            s.id = "as-styles";
            s.textContent = CSS;
            (document.head || document.body).appendChild(s);
        } catch (e) {}
    })();

    // ============================================================
    // UI: botao na barra do player
    // ============================================================
    var btn = new Spicetify.Playbar.Button("Adaptive Shuffle", ICON_SVG, togglePanel, false, settings.autoShuffle);
    btn.register();

    // Spotify 1.3.x nao tem mais .main-nowPlayingBar-right: o Spicetify.Playbar nunca acha
    // onde montar o botao. Fallback: injeta na linha de botoes da direita (a do volume) e
    // reinjeta se o React recriar a barra.
    function findPlaybarRow() {
        var queueBtn = document.querySelector("[data-testid=control-button-queue]");
        var node = queueBtn;
        while (node && node.parentElement) {
            if (node.parentElement.querySelector(":scope > [data-testid=volume-bar]")) return { row: node.parentElement, sample: queueBtn };
            node = node.parentElement;
        }
        return null;
    }
    // Classes de estilo comuns a todos os botoes nativos da linha (sem as de estado, tipo "ativo")
    function nativeButtonClasses(row, sample) {
        var buttons = Array.prototype.filter.call(row.querySelectorAll("button[data-encore-id]"), function (b) { return b !== btn.element; });
        if (!buttons.length) buttons = [sample];
        return Array.prototype.filter.call(buttons[0].classList, function (c) {
            return buttons.every(function (b) { return b.classList.contains(c); });
        });
    }
    function ensurePlaybarButton() {
        try {
            var b = btn.element;
            if (!b || b.isConnected) return;
            var found = findPlaybarRow();
            if (!found) return;
            b.id = "as-playbar-button";
            b.setAttribute("aria-label", "Adaptive Shuffle");
            nativeButtonClasses(found.row, found.sample).forEach(function (c) { b.classList.add(c); });
            found.row.prepend(b);
        } catch (e) {}
    }
    ensurePlaybarButton();
    setInterval(ensurePlaybarButton, 1000);

    function refreshButton() { try { btn.active = !!settings.autoShuffle; } catch (e) {} }

    // ============================================================
    // UI: painel do botao
    // ============================================================
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        for (var k in attrs || {}) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) continue;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = v;
            else if (k === "html") node.innerHTML = v;
            else if (k === "style") node.style.cssText = v;
            else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2).toLowerCase(), v);
            else node.setAttribute(k, v);
        }
        (children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) return;
            node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        });
        return node;
    }

    // A barra cresce a partir do centro: pra direita (verde) ou pra esquerda (vermelho)
    function meterFill(score) {
        var w = Math.abs(score) / 2;
        return { left: (score >= 0 ? 50 : 50 - w) + "%", width: w + "%", background: score >= 0 ? "#1ed760" : "#f3727f", transformOrigin: score >= 0 ? "left" : "right" };
    }
    function applyFill(node, score) {
        var f = meterFill(score);
        node.style.left = f.left;
        node.style.width = f.width;
        node.style.background = f.background;
        node.style.transformOrigin = f.transformOrigin;
    }
    function factsText(s) {
        if (!s) return "";
        var parts = [];
        if (s.p) parts.push(s.p + "× até o fim");
        if (s.sk) parts.push(s.sk + (s.sk === 1 ? " pulo" : " pulos"));
        if (s.q) parts.push(s.q + "× na fila");
        if (s.m > 0) parts.push("turbinada" + (s.m > 1 ? " ×" + s.m : ""));
        if (s.m < 0) parts.push("evitada" + (s.m < -1 ? " ×" + -s.m : ""));
        return parts.join(" · ");
    }

    var panel = null; // { el, ui, closing }

    function togglePanel() {
        if (panel && !panel.closing) { closePanel(); return; }
        if (panel) { panel.el.remove(); panel = null; }
        openPanel();
    }

    function openPanel() {
        var pop = el("div", { id: "as-pop", class: "as-pop", role: "dialog", "aria-label": "Adaptive Shuffle" });
        document.body.appendChild(pop);
        panel = { el: pop, ui: {}, closing: false };
        buildPanel(panel);
        positionPanel(pop);
        if (btn.element) btn.element.classList.add("as-open");
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onEsc, true);
    }

    function closePanel() {
        if (!panel || panel.closing) return;
        var p = panel, finished = false;
        p.closing = true;
        if (btn.element) btn.element.classList.remove("as-open");
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onEsc, true);
        function done() {
            if (finished) return;
            finished = true;
            p.el.remove();
            if (panel === p) panel = null;
        }
        p.el.classList.add("as-closing");
        p.el.addEventListener("animationend", function (e) { if (e.target === p.el) done(); });
        setTimeout(done, reducedMotion() ? 0 : 280);
    }
    function onOutside(e) {
        if (panel && !panel.el.contains(e.target) && !(btn.element && btn.element.contains(e.target))) closePanel();
    }
    function onEsc(e) { if (e.key === "Escape") closePanel(); }

    function positionPanel(pop) {
        var r;
        try { r = btn.element.getBoundingClientRect(); } catch (e) { r = null; }
        if (!r || (!r.width && !r.height)) { pop.style.right = "16px"; pop.style.bottom = "96px"; return; }
        var width = pop.offsetWidth || 320;
        var center = r.left + r.width / 2;
        var left = clamp(center - width / 2, 8, window.innerWidth - width - 8);
        pop.style.left = left + "px";
        pop.style.bottom = (window.innerHeight - r.top + 12) + "px";
        // cresce a partir do botao
        pop.style.setProperty("--as-origin", Math.round(center - left) + "px 100%");
    }

    function menuItem(icon, label, onClick, trailing) {
        var item = el("div", { class: "as-item", role: "button", tabindex: "0", onclick: onClick }, [
            el("span", { class: "as-item-icon", html: icon }),
            el("span", { class: "as-item-label", text: label }),
            trailing || null,
        ]);
        item.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        });
        return item;
    }

    function currentTrack() {
        var d = Spicetify.Player.data;
        var info = d && itemInfo(d.item);
        return info && isTrackUri(info.uri) ? info : null;
    }
    function trackView(info) {
        var s = peekSong(info.uri);
        var liked = info.liked === 1 || (info.liked === -1 && !!(s && s.lk));
        return { s: s, liked: liked, score: scoreOf(s, liked ? 1 : 0), known: hasHistory(s) || liked };
    }

    // Monta o painel uma vez; depois so atualiza no lugar (pra transicoes rodarem de verdade)
    function buildPanel(p) {
        var pop = p.el, ui = p.ui, i = 0;
        function add(node) {
            node.classList.add("as-rise");
            node.style.setProperty("--i", i++);
            // a entrada roda uma vez so; sem isso, outra animacao de classe (as-swap) faria ela repetir
            node.addEventListener("animationend", function done(e) {
                if (e.target !== node || e.animationName !== "as-rise") return;
                node.classList.remove("as-rise");
                node.removeEventListener("animationend", done);
            });
            pop.appendChild(node);
            return node;
        }
        add(el("div", { class: "as-kicker", html: ICON_SVG + "<span>Adaptive Shuffle</span>" }));
        ui.track = add(el("div", { class: "as-track" }));
        renderTrack(p, false);
        add(el("div", { class: "as-sep" }));
        add(menuItem(ICON_SVG, "Embaralhar a fila agora", function () { closePanel(); reshuffle(); }));
        ui.autoSwitch = el("span", { class: "as-switch" + (settings.autoShuffle ? " on" : ""), role: "switch", "aria-checked": settings.autoShuffle ? "true" : "false" });
        add(menuItem(svgIcon("enhance"), "Shuffle automático", function () {
            settings.autoShuffle = !settings.autoShuffle;
            saveSettings();
            refreshButton();
            ui.autoSwitch.classList.toggle("on", settings.autoShuffle);
            ui.autoSwitch.setAttribute("aria-checked", settings.autoShuffle ? "true" : "false");
            if (settings.autoShuffle) maybeAutoShuffle(Spicetify.Player.data, true);
        }, ui.autoSwitch));
        add(menuItem(svgIcon("edit"), "Configurações e estatísticas", function () { closePanel(); openSettings(); }));
        add(menuItem(svgIcon("more"), "Como funciona", function () { closePanel(); openWelcome(); }));
    }

    function renderTrack(p, swap) {
        var ui = p.ui, box = ui.track;
        if (ui.cancelTween) ui.cancelTween();
        box.innerHTML = "";
        var info = ui.info = currentTrack();
        ui.score = null;
        if (!info) {
            box.appendChild(el("div", { class: "as-facts", text: "Nada tocando agora. Dê play em alguma playlist para ver o score da faixa." }));
            if (swap) replay(box, "as-swap");
            return;
        }
        var v = trackView(info);
        var cover;
        if (info.image) {
            cover = el("img", { class: "as-cover", src: info.image, alt: "" });
            cover.addEventListener("load", function () { cover.classList.add("as-loaded"); });
            if (cover.complete) cover.classList.add("as-loaded");
        } else cover = el("div", { class: "as-cover as-blank" });

        ui.fill = el("div", { class: "as-meter-fill" });
        applyFill(ui.fill, v.score);
        ui.score = el("span", { class: "as-score " + scoreClass(v.score), text: v.known ? fmtScore(v.score) : "novo" });
        ui.scoreLine = el("div", { class: "as-scoreline" }, [el("div", { class: "as-meter" }, [ui.fill, el("div", { class: "as-meter-mid" })]), ui.score]);
        ui.facts = el("div", { class: "as-facts" });
        fillFacts(ui.facts, v);
        ui.boost = el("button", { class: "as-btn", html: svgIcon("chart-up") + "<span>Turbinar</span>", title: "Tocar mais essa música", onclick: function () { act(p, +1); } });
        ui.avoid = el("button", { class: "as-btn", html: svgIcon("chart-down") + "<span>Evitar</span>", title: "Tocar menos essa música", onclick: function () { act(p, -1); } });
        syncButtons(ui, v);
        ui.shown = v.score;
        ui.known = v.known;

        box.appendChild(el("div", { class: "as-head" }, [cover, el("div", { class: "as-head-text" }, [
            el("div", { class: "as-title", title: info.name, text: info.name || "Faixa atual" }),
            el("div", { class: "as-sub", text: info.artist }),
        ])]));
        box.appendChild(ui.scoreLine);
        box.appendChild(ui.facts);
        box.appendChild(el("div", { class: "as-pair" }, [ui.boost, ui.avoid]));
        if (swap) replay(box, "as-swap");
    }

    function fillFacts(node, v) {
        node.innerHTML = "";
        if (v.liked) node.appendChild(el("span", { class: "as-heart", html: svgIcon("heart-active", 12) }));
        node.appendChild(document.createTextNode(v.known
            ? scoreWord(v.score) + (factsText(v.s) ? " · " + factsText(v.s) : "")
            : "Ainda sem histórico: ela tem uma leve vantagem pra ser descoberta."));
    }
    function syncButtons(ui, v) {
        ui.boost.classList.toggle("as-on-pos", !!(v.s && v.s.m > 0));
        ui.avoid.classList.toggle("as-on-neg", !!(v.s && v.s.m < 0));
    }

    function act(p, dir) {
        var info = p.ui.info;
        if (!info) return;
        nudge(info.uri, info.name, info.artist, dir);
        updateTrack(p, dir > 0 ? "up" : "down");
    }

    // Atualiza score, barra e textos sem recriar nada: a barra desliza e o numero conta
    function updateTrack(p, kick) {
        var ui = p.ui, info = ui.info;
        if (!info || !ui.score) return;
        var v = trackView(info);
        var from = ui.known ? ui.shown : 0;
        applyFill(ui.fill, v.score);
        ui.score.className = "as-score " + scoreClass(v.score);
        if (ui.cancelTween) ui.cancelTween();
        if (v.known) ui.cancelTween = tweenNumber(ui.score, from, v.score, fmtScore);
        else ui.score.textContent = "novo";
        if (v.score !== from) {
            replay(ui.score, "as-bump");
            floatDelta(ui.scoreLine, v.score - from);
        }
        ui.shown = v.score;
        ui.known = v.known;
        fillFacts(ui.facts, v);
        replay(ui.facts, "as-fade");
        syncButtons(ui, v);
        if (kick) replay(kick === "up" ? ui.boost : ui.avoid, kick === "up" ? "as-kick-up" : "as-kick-down");
    }

    // "+30" que sobe e some ao lado do score
    function floatDelta(container, delta) {
        if (!delta || reducedMotion()) return;
        var chip = el("span", { class: "as-delta " + (delta > 0 ? "as-pos" : "as-neg"), text: fmtScore(delta) });
        container.appendChild(chip);
        var gone = function () { if (chip.parentNode) chip.remove(); };
        chip.addEventListener("animationend", gone);
        setTimeout(gone, 1400);
    }

    // ============================================================
    // UI: configuracoes (React)
    // ============================================================
    // Numero que conta ate o valor novo (ou a partir de 0 quando countUp)
    function AnimatedNumber(props) {
        var R = Spicetify.React;
        var ref = R.useRef(null), prev = R.useRef(null);
        R.useLayoutEffect(function () {
            var node = ref.current;
            if (!node) return;
            var from = prev.current === null ? (props.countUp ? 0 : props.value) : prev.current;
            prev.current = props.value;
            if (from !== props.value && props.bump) replay(node, "as-bump");
            return tweenNumber(node, from, props.value, props.format || String, props.duration);
        }, [props.value]);
        return h(props.tag || "span", { ref: ref, className: props.className });
    }

    function Meter(props) {
        return h("div", { className: "as-meter" },
            h("div", { className: "as-meter-fill", style: meterFill(props.score) }),
            h("div", { className: "as-meter-mid" }));
    }

    function Segmented(props) {
        var idx = -1;
        props.options.forEach(function (o, i) { if (o[0] === props.value) idx = i; });
        return h("div", {
            className: "as-seg" + (props.wide ? " as-seg-wide" : "") + (idx < 0 ? " as-none" : ""), role: "tablist",
            style: { "--n": String(props.options.length), "--idx": String(Math.max(0, idx)) },
        },
            h("span", { className: "as-seg-thumb", "aria-hidden": "true" }),
            props.options.map(function (o) {
                var on = o[0] === props.value;
                return h("button", { key: o[0], role: "tab", "aria-selected": on ? "true" : "false", className: on ? "on" : "", onClick: function () { props.onChange(o[0]); } }, o[1]);
            }));
    }

    function SwitchRow(props) {
        return h("div", { className: "as-srow" },
            h("div", { className: "as-srow-text" },
                h("div", { className: "as-srow-title" }, props.title),
                props.desc ? h("div", { className: "as-srow-desc" }, props.desc) : null),
            h("button", {
                className: "as-switch" + (props.on ? " on" : ""), role: "switch", "aria-checked": props.on ? "true" : "false",
                "aria-label": props.title, onClick: function () { props.onChange(!props.on); },
            }));
    }

    function IconButton(props) {
        return h("button", {
            className: "as-icon-btn", title: props.title, "aria-label": props.title,
            // stopPropagation: o clique nao pode chegar no "clicou fora" do modal
            onClick: function (e) { e.stopPropagation(); props.onClick(); },
            dangerouslySetInnerHTML: { __html: svgIcon(props.icon) },
        });
    }

    function SongRow(props) {
        var s = props.song, sc = scoreOf(s);
        var sub = [s.a, factsText(s)].filter(Boolean).join(" · ");
        return h("div", { className: "as-song", style: { "--i": String(props.index) } },
            h("div", { className: "as-song-main" },
                h("div", { className: "as-song-name", title: s.n },
                    s.lk ? h("span", { className: "as-heart", dangerouslySetInnerHTML: { __html: svgIcon("heart-active", 12) } }) : null,
                    s.n || "Faixa sem nome"),
                sub ? h("div", { className: "as-song-sub" }, sub) : null),
            h("div", { className: "as-song-actions" },
                h(IconButton, { icon: "chart-up", title: "Turbinar", onClick: function () { nudgeSong(s, +1); props.onChange(); } }),
                h(IconButton, { icon: "chart-down", title: "Evitar", onClick: function () { nudgeSong(s, -1); props.onChange(); } }),
                h(IconButton, { icon: "x", title: "Esquecer o que aprendi", onClick: function () { resetSong(s); props.onChange(); } })),
            h(Meter, { score: sc }),
            h(AnimatedNumber, { value: sc, format: fmtScore, bump: true, className: "as-score " + scoreClass(sc) }));
    }

    function ActivityRow(props) {
        var e = props.e, delta = e.s - e.b;
        return h("div", { className: "as-act", style: { "--i": String(props.index) } },
            h("span", { className: "as-act-kind" }, EVENT_LABEL[e.k] || e.k),
            h("span", { className: "as-act-name", title: e.n }, (e.n || "Faixa sem nome") + (e.a ? " · " + e.a : "")),
            h("span", { className: "as-act-delta " + scoreClass(delta * 3) }, fmtScore(e.b) + " → " + fmtScore(e.s)),
            h("span", { className: "as-act-time" }, timeAgo(e.t)));
    }

    // Marca o modal do Spicetify com classes nossas enquanto o nosso conteudo esta montado.
    // (Antes era :has(.as-settings) no CSS: o navegador reavaliava isso a cada mudanca no DOM,
    // como os numeros contando, e a animacao caia pra ~17 fps.)
    function useModalChrome(ref, wide) {
        Spicetify.React.useLayoutEffect(function () {
            var node = ref.current;
            var box = node && node.closest(".spicetify-popup-container");
            var dialog = node && node.closest("[role=dialog]");
            var overlay = dialog && dialog.closest(".GenericModal__overlay");
            var marks = [[box, "as-modal"], [dialog, "as-dialog"], [overlay, "as-overlay"]];
            if (wide) marks.push([dialog, "as-dialog-wide"]);
            marks.forEach(function (m) { if (m[0]) m[0].classList.add(m[1]); });
            return function () {
                marks.forEach(function (m) { if (m[0]) m[0].classList.remove(m[1], "as-modal-closing"); });
            };
        }, []);
    }

    function SettingsView() {
        var R = Spicetify.React;
        var bump = R.useState(0)[1];
        var tabState = R.useState("loved"), tab = tabState[0], setTab = tabState[1];
        var qState = R.useState(""), query = qState[0], setQuery = qState[1];
        var armState = R.useState(false), armed = armState[0], setArmed = armState[1];
        var wipeState = R.useState(0), wipes = wipeState[0], setWipes = wipeState[1];
        var orderRef = R.useRef({ sig: null, keys: [] });
        var armTimer = R.useRef(0);
        var rootRef = R.useRef(null);
        useModalChrome(rootRef, true);
        R.useEffect(function () { return function () { clearTimeout(armTimer.current); }; }, []);
        // A lista e o pedaco pesado: montar 150 linhas junto com a entrada do modal travava a
        // animacao. Ela entra depois da entrada e em blocos, um por frame.
        var shownState = R.useState(0), shown = shownState[0], setShown = shownState[1];
        var mounted = R.useRef(false);
        R.useEffect(function () {
            var raf = 0, cancelled = false;
            function grow(n) {
                if (cancelled) return;
                setShown(n);
                if (n < 150) raf = requestAnimationFrame(function () { grow(n + 25); });
            }
            // na abertura espera a entrada do modal; ao trocar de aba/busca, comeca na hora
            var first = !mounted.current;
            mounted.current = true;
            if (!first) setShown(0);
            var t = setTimeout(function () { grow(25); }, first && !reducedMotion() ? 420 : 0);
            return function () { cancelled = true; clearTimeout(t); cancelAnimationFrame(raf); };
        }, [tab, query, wipes]);
        function refresh() { bump(function (x) { return x + 1; }); }
        function reload() { setWipes(function (x) { return x + 1; }); }
        function set(k, v) {
            settings[k] = v;
            saveSettings();
            if (k === "autoShuffle") { refreshButton(); if (v) maybeAutoShuffle(Spicetify.Player.data, true); }
            refresh();
        }

        var scored = Object.keys(store.songs).filter(function (k) { return hasHistory(store.songs[k]); })
            .map(function (k) { return { k: k, s: store.songs[k], sc: scoreOf(store.songs[k]) }; });
        var likedCount = scored.filter(function (x) { return x.s.lk; }).length;
        var loved = scored.filter(function (x) { return x.sc >= 10; }).length;
        var avoided = scored.filter(function (x) { return x.sc <= -10; }).length;

        // A ordem da lista so e recalculada ao trocar de aba ou de busca: turbinar/evitar/esquecer
        // atualiza o score na hora, mas a musica fica no lugar pra dar pra clicar varias vezes.
        var q = normText(query).trim();
        var order = orderRef.current;
        var sig = tab + "|" + q + "|" + wipes;
        if (order.sig !== sig) {
            var picked;
            if (q) {
                picked = scored.filter(function (x) { return normText(x.s.n + " " + x.s.a).indexOf(q) !== -1; })
                    .sort(function (a, b) { return b.sc - a.sc; });
            } else if (tab === "loved") {
                picked = scored.filter(function (x) { return x.sc > 0; }).sort(function (a, b) { return b.sc - a.sc; });
            } else if (tab === "avoided") {
                picked = scored.filter(function (x) { return x.sc < 0; }).sort(function (a, b) { return a.sc - b.sc; });
            } else picked = [];
            orderRef.current = order = { sig: sig, keys: picked.slice(0, 150).map(function (x) { return x.k; }) };
        }
        var list = order.keys.filter(function (k) { return store.songs[k]; }).map(function (k) { return { k: k, s: store.songs[k] }; });

        var listEl;
        if (tab === "activity" && !q) {
            var log = store.log.slice(-100).reverse();
            listEl = log.length
                ? log.slice(0, shown).map(function (e, i) { return h(ActivityRow, { key: e.t + ":" + i, e: e, index: i }); })
                : h("div", { className: "as-empty" }, "Nada aprendido ainda. Ouça algumas músicas!");
        } else {
            listEl = list.length
                ? list.slice(0, shown).map(function (x, i) { return h(SongRow, { key: x.k, song: x.s, index: i, onChange: refresh }); })
                : h("div", { className: "as-empty" }, q ? "Nenhuma música encontrada." : "Nada por aqui ainda.");
        }

        var ratio = Math.exp(STRENGTH[settings.aggressiveness] * 0.8);
        var sec = 0;
        function section(title, body) {
            return h("div", { className: "as-sec", style: { "--i": String(sec++) } }, h("h3", { className: "as-sec-title" }, title), body);
        }

        return h("div", { className: "as-settings", ref: rootRef },
            section("Como ele embaralha", h("div", { className: "as-card" },
                h("div", { className: "as-srow" },
                    h("div", { className: "as-srow-text" },
                        h("div", { className: "as-srow-title" }, "Intensidade"),
                        h("div", { className: "as-srow-desc" },
                            "Uma favorita tem ~", h(AnimatedNumber, { value: Math.round(ratio), duration: 420 }), "× mais chance de vir antes que uma música neutra.")),
                    h(Segmented, {
                        options: [["leve", STRENGTH_LABEL.leve], ["normal", STRENGTH_LABEL.normal], ["intenso", STRENGTH_LABEL.intenso]],
                        value: settings.aggressiveness, onChange: function (v) { set("aggressiveness", v); },
                    })),
                h(SwitchRow, {
                    title: "Shuffle automático", on: settings.autoShuffle, onChange: function (v) { set("autoShuffle", v); },
                    desc: "Com o aleatório do Spotify ligado, o Adaptive Shuffle assume a ordem sozinho ao começar uma playlist, álbum ou Curtidas.",
                }),
                h(SwitchRow, {
                    title: "Evitar repetir o que tocou há pouco", on: settings.avoidRepeats, onChange: function (v) { set("avoidRepeats", v); },
                    desc: "Músicas ouvidas nas últimas 24 h ficam mais pro fim da fila.",
                }),
                h(SwitchRow, {
                    title: "Espalhar artistas", on: settings.spreadArtists, onChange: function (v) { set("spreadArtists", v); },
                    desc: "Evita o mesmo artista duas vezes seguidas.",
                }),
                h(SwitchRow, {
                    title: "Aprender com o que eu ouço", on: settings.learning, onChange: function (v) { set("learning", v); },
                    desc: "Desligado, ele continua embaralhando com o que já sabe, mas não aprende nada novo.",
                }))),

            section("Suas músicas", [
                h("div", { key: "stats", className: "as-stats" },
                    h("div", { className: "as-stat" }, h(AnimatedNumber, { tag: "b", value: scored.length, countUp: true, duration: 900 }), h("span", null, "músicas com histórico")),
                    h("div", { className: "as-stat" }, h(AnimatedNumber, { tag: "b", value: loved, countUp: true, duration: 900, className: "as-pos" }), h("span", null, "tocam mais")),
                    h("div", { className: "as-stat" }, h(AnimatedNumber, { tag: "b", value: avoided, countUp: true, duration: 900, className: "as-neg" }), h("span", null, "tocam menos"))),
                h("div", { key: "toolbar", className: "as-toolbar" },
                    h(Segmented, {
                        options: [["loved", "Mais amadas"], ["avoided", "Mais evitadas"], ["activity", "Atividade"]],
                        value: q ? null : tab, onChange: function (v) { setQuery(""); setTab(v); },
                    }),
                    h("div", { className: "as-searchbox" },
                        h("span", { className: "as-search-icon", dangerouslySetInnerHTML: { __html: svgIcon("search") } }),
                        h("input", { className: "as-search", placeholder: "Buscar música ou artista", value: query, onChange: function (e) { setQuery(e.target.value); } }),
                        query ? h("button", {
                            className: "as-search-clear", "aria-label": "Limpar busca",
                            onClick: function (e) { e.stopPropagation(); setQuery(""); },
                            dangerouslySetInnerHTML: { __html: svgIcon("x", 10) },
                        }) : null)),
                // a chave muda com a aba/busca: a lista remonta e a entrada escalonada roda de novo
                h("div", { key: "list:" + (tab === "activity" && !q ? "activity" : order.sig), className: "as-list" }, listEl),
            ]),

            section("Seus dados", [
                h("p", { key: "note", className: "as-note" },
                    "Tudo fica salvo só neste computador (" + likedCount + " das suas músicas com histórico estão nas Curtidas). Faça backup antes de reinstalar o Spotify."),
                h("div", { key: "btns", className: "as-btnrow" },
                    h("button", { className: "as-btn", onClick: exportBackup }, h("span", { dangerouslySetInnerHTML: { __html: svgIcon("download") } }), "Exportar backup"),
                    h("button", { className: "as-btn", onClick: function () { importBackup(reload); } }, "Importar backup"),
                    h("button", {
                        className: "as-btn as-danger" + (armed ? " as-armed" : ""),
                        onClick: function () {
                            clearTimeout(armTimer.current);
                            if (!armed) {
                                setArmed(true);
                                armTimer.current = setTimeout(function () { setArmed(false); }, 4000);
                                return;
                            }
                            wipeAll();
                            setArmed(false);
                            reload();
                        },
                    }, armed ? "Clique de novo pra apagar tudo" : "Apagar tudo")),
            ]),
            h("div", { className: "as-foot" }, "Adaptive Shuffle v" + VERSION));
    }

    // O PopupModal do Spicetify fecha seco. Pros nossos modais, o X, o clique fora e o Esc
    // passam por aqui: anima a saida e so entao fecha de verdade.
    function ourModal() {
        var c = document.querySelector(".as-modal");
        return c ? { box: c, overlay: c.closest(".as-overlay") } : null;
    }
    function closeModal() {
        var m = ourModal();
        if (!m) { Spicetify.PopupModal.hide(); return; }
        if (m.box.classList.contains("as-modal-closing")) return;
        m.box.classList.add("as-modal-closing");
        if (m.overlay) m.overlay.classList.add("as-modal-closing");
        setTimeout(function () {
            Spicetify.PopupModal.hide();
            m.box.classList.remove("as-modal-closing");
            if (m.overlay) m.overlay.classList.remove("as-modal-closing");
        }, reducedMotion() ? 0 : 230);
    }
    function interceptClose(e) {
        var m = ourModal();
        if (!m) return;
        var b = e.target && e.target.closest && e.target.closest("button");
        var isClose = (b && m.box.contains(b) && !b.closest(".as-settings,.as-welcome")) || e.target === m.overlay;
        if (!isClose) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "click") closeModal();
    }
    try {
        document.addEventListener("mousedown", interceptClose, true);
        document.addEventListener("click", interceptClose, true);
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && ourModal() && !document.getElementById("as-pop")) { e.preventDefault(); e.stopPropagation(); closeModal(); }
        }, true);
    } catch (e) {}

    function openSettings() {
        try {
            Spicetify.PopupModal.display({ title: "Adaptive Shuffle", content: h(SettingsView), isLarge: true });
        } catch (e) {
            console.error("[AS] openSettings", e);
            notify("Erro ao abrir as configurações", true);
        }
    }

    function exportBackup() {
        var data = JSON.stringify({ app: "adaptive-shuffle", version: VERSION, exportedAt: new Date(now()).toISOString(), settings: settings, store: store });
        try {
            var url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
            var a = document.createElement("a");
            a.href = url;
            a.download = "adaptive-shuffle-backup-" + new Date(now()).toISOString().slice(0, 10) + ".json";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
            notify("Backup salvo na pasta Downloads");
        } catch (e) {
            try { Spicetify.Platform.ClipboardAPI.copy(data); notify("Backup copiado para a área de transferência"); }
            catch (e2) { notify("Não consegui exportar o backup", true); }
        }
    }

    function importBackup(onDone) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = function () {
            var f = input.files && input.files[0];
            if (!f) return;
            f.text().then(function (txt) {
                var data = JSON.parse(txt);
                var st = data && (data.store || data);
                if (!st || st.v !== 2 || !st.songs || !st.uris) throw new Error("arquivo não é um backup do Adaptive Shuffle");
                if (!Array.isArray(st.log)) st.log = [];
                store = st;
                saveStore(true);
                if (onDone) onDone();
                notify("Backup importado: " + Object.keys(store.songs).length + " músicas");
            }).catch(function (e) { notify("Não consegui importar: " + ((e && e.message) || e), true); });
        };
        input.click();
    }

    function wipeAll() {
        store = emptyStore();
        saveStore(true);
        notify("Tudo apagado. Começando do zero.");
    }

    // ============================================================
    // UI: boas-vindas
    // ============================================================
    function WelcomeView() {
        var rootRef = Spicetify.React.useRef(null);
        useModalChrome(rootRef, false);
        function finish(thenSettings) {
            settings.seenWelcome = true;
            saveSettings();
            closeModal();
            if (thenSettings) setTimeout(openSettings, 250);
        }
        function step(n, title, text) {
            return h("div", { className: "as-step", style: { "--i": String(n - 1) } },
                h("div", { className: "as-step-n" }, n),
                h("div", null, h("b", null, title), h("span", null, text)));
        }
        return h("div", { className: "as-welcome", ref: rootRef },
            h("h2", null, "Seu shuffle, do seu jeito"),
            h("p", null, "O Adaptive Shuffle observa o que você ouve e monta a fila tocando mais o que você curte. Nada sai do seu computador."),
            h("div", { className: "as-steps" },
                step(1, "Aprende sozinho", "Ouvir até o fim, pôr na fila, escolher tocar e curtir (♥) contam a favor. Pular logo no começo conta contra, mas um pulo isolado quase não pesa, e tudo vai sendo esquecido devagar."),
                step(2, "Embaralha do seu jeito", "Clique no botão ✦ do lado direito da barra do player e escolha Embaralhar a fila agora. Ou ligue o Shuffle automático: com o aleatório do Spotify ligado, ele assume sozinho."),
                step(3, "Você tem a palavra final", "Turbine ou evite a música atual pelo mesmo botão, ou clicando com o botão direito em qualquer faixa → Adaptive Shuffle.")),
            h("div", { className: "as-btnrow" },
                h("button", { className: "as-btn as-primary", onClick: function () { finish(false); } }, "Bora!"),
                h("button", { className: "as-btn", onClick: function () { finish(true); } }, "Ver configurações")));
    }
    function openWelcome() {
        try { Spicetify.PopupModal.display({ title: "Adaptive Shuffle", content: h(WelcomeView), isLarge: true }); } catch (e) {}
    }

    // ============================================================
    // UI: menus de contexto
    // ============================================================
    new Spicetify.ContextMenu.Item(
        "Tocar com Adaptive Shuffle",
        function (uris) { playAdaptive(uris[0]); },
        function (uris) {
            return uris.length === 1 && (isPlaylistUri(uris[0]) || isAlbumUri(uris[0]) || isArtistUri(uris[0]) || isLikedSongsUri(uris[0]));
        },
        ICON_SVG
    ).register();

    async function trackMeta(uris) {
        var out = {};
        try {
            var res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.decorateContextTracks, { uris: uris });
            ((res && res.data && res.data.tracks) || []).forEach(function (t) { if (t && t.uri) out[t.uri] = { name: t.name, artist: firstArtist(t.artists) }; });
        } catch (e) { debug("trackMeta", e); }
        return out;
    }
    function onTracks(action) {
        return async function (uris) {
            var tracks = uris.filter(isTrackUri);
            var meta = await trackMeta(tracks);
            tracks.forEach(function (u) {
                var m = meta[u] || {};
                var s = songFor(u, m.name, m.artist);
                if (action === "reset") resetSong(s); else nudgeSong(s, action === "boost" ? 1 : -1);
            });
            var what = tracks.length === 1 ? ((meta[tracks[0]] && meta[tracks[0]].name) || "Faixa") : tracks.length + " faixas";
            notify(what + ": " + (action === "boost" ? "turbinada" : action === "avoid" ? "evitada" : "aprendizado apagado") + (tracks.length > 1 && action !== "reset" ? "s" : ""));
        };
    }
    var onlyTracks = function (uris) { return uris.length > 0 && uris.every(isTrackUri); };
    new Spicetify.ContextMenu.SubMenu("Adaptive Shuffle", [
        new Spicetify.ContextMenu.Item("Turbinar (tocar mais)", onTracks("boost"), onlyTracks, svgIcon("chart-up") ? "chart-up" : undefined),
        new Spicetify.ContextMenu.Item("Evitar (tocar menos)", onTracks("avoid"), onlyTracks, svgIcon("chart-down") ? "chart-down" : undefined),
        new Spicetify.ContextMenu.Item("Esquecer o que aprendi", onTracks("reset"), onlyTracks, svgIcon("x") ? "x" : undefined),
    ], onlyTracks, false, ICON_SVG).register();

    try {
        if (Spicetify.Menu && Spicetify.Menu.Item) new Spicetify.Menu.Item("Adaptive Shuffle", false, openSettings).register();
    } catch (e) {}

    // ============================================================
    // API PUBLICA & INIT
    // ============================================================
    window.AdaptiveShuffle = {
        version: VERSION,
        debug: false,
        get settings() { return settings; },
        get store() { return store; },
        MODEL: MODEL,
        identityKey: identityKey,
        peekSong: peekSong,
        keyOf: keyOf,
        songFor: songFor,
        scoreOf: scoreOfUri,
        preference: preference,
        learn: learn,
        nudge: nudge,
        resetSong: resetSong,
        weightedShuffle: weightedShuffle,
        spreadArtists: spreadArtists,
        reshuffle: reshuffle,
        playAdaptive: playAdaptive,
        openSettings: openSettings,
        openWelcome: openWelcome,
        backgroundMaintenance: backgroundMaintenance,
        flush: flushStore,
        _tick: tick,
        _current: function () { return cur; },
    };

    (function init() {
        startTracking(Spicetify.Player.data);
        knownQueued = {};
        queueState().queued.forEach(function (i) { if (i && i.uri) knownQueued[i.uri] = true; });
        expectedNext = peekNextUri();
        lastShuffleFlag = Spicetify.Player.data ? !!Spicetify.Player.data.shuffle : null;
        refreshButton();
        if (window.addEventListener) window.addEventListener("beforeunload", flushStore);
        setTimeout(backgroundMaintenance, 8000);
        if (!settings.seenWelcome) setTimeout(openWelcome, 1500);
    })();

    console.log("[Adaptive Shuffle v" + VERSION + "] carregado. " + Object.keys(store.songs).length + " músicas aprendidas.");
})();

// Testes do Adaptive Shuffle: modelo de score, tracker, identidade, migracao e fila.
// Carrega a extensao inteira num Spicetify mockado (tests/mock-spicetify.js).
// Usa o test runner nativo do Node (node:test) -- zero dependencias.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildMockSpicetify } = require("./mock-spicetify");

const CODE = fs.readFileSync(path.join(__dirname, "..", "adaptive-shuffle.js"), "utf8");
const DAY = 86400000;

function loadExtension(env) {
    const clock = env.clock;
    class FakeDate extends Date {
        constructor(...args) { if (args.length) super(...args); else super(clock.t); }
        static now() { return clock.t; }
    }
    const fakeNode = () => ({
        id: "", style: {}, className: "", textContent: "", classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, appendChild() {}, prepend() {}, remove() {}, addEventListener() {}, removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        contains: () => false, querySelector: () => null,
    });
    const docMock = {
        createElement: fakeNode, createTextNode: fakeNode,
        getElementById: () => null, querySelector: () => null,
        addEventListener() {}, removeEventListener() {},
        head: fakeNode(), body: fakeNode(),
    };
    const context = vm.createContext({
        window: {},
        console: { log() {}, warn() {}, error() {} },
        document: docMock,
        // Timers: setTimeout executa na hora (debounce/atrasos viram sincronos); intervalos sao inertes
        setTimeout: (cb) => { try { cb(); } catch (e) {} return 1; },
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        Date: FakeDate,
        Spicetify: env.Spicetify,
    });
    vm.runInContext(CODE, context);
    const api = context.window.AdaptiveShuffle;
    if (api) api.settings.seenWelcome = true;
    return api;
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const A = { uri: "spotify:track:aaa", name: "Nice To Each Other", artist: "Olivia Dean", duration: 200000, context: "spotify:playlist:p1" };
const B = { uri: "spotify:track:bbb", name: "Manchild", artist: "Sabrina Carpenter", duration: 200000, context: "spotify:playlist:p1" };
const C = { uri: "spotify:track:ccc", name: "Sports car", artist: "Tate McRae", duration: 200000, context: "spotify:playlist:p1" };
const D = { uri: "spotify:track:ddd", name: "Run Rabbit", artist: "Hajaj", duration: 200000, context: "spotify:playlist:p1" };

// Toca A por `ms`, com B como proxima esperada, e troca pra B
function listenThenNext(env, track, ms, next = B) {
    env.changeTrack(track);
    env.setQueue({ nextUp: [next] });
    env.play(ms);
    env.changeTrack(next);
}

// ============================================================
// SMOKE
// ============================================================

test("smoke: carrega sem erros e expoe a API", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    assert.ok(api);
    assert.strictEqual(api.version, "2.0.0");
    for (const fn of ["weightedShuffle", "learn", "nudge", "reshuffle", "playAdaptive", "scoreOf", "identityKey"]) {
        assert.strictEqual(typeof api[fn], "function", fn);
    }
    assert.ok(env.registeredMenus.some((m) => m.name === "Tocar com Adaptive Shuffle"));
    assert.ok(env.registeredMenus.some((m) => m.name === "Adaptive Shuffle" && m.items.length === 3), "submenu de faixa");
});

test("notify nao entra em recursao quando showNotification falha", () => {
    const env = buildMockSpicetify();
    env.Spicetify.showNotification = () => { throw new Error("quebrou"); };
    const api = loadExtension(env);
    return api.reshuffle(); // fila vazia -> tenta notificar; nao pode estourar a pilha
});

test("Spicetify troca o objeto Player depois do load: a extensao le sempre o atual", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    const old = env.Spicetify.Player;
    // como o Spicetify faz no fim do setup: Player: {...Spicetify.Player, get origin() {...}}
    const fresh = Object.assign(Object.create(Object.getPrototypeOf(old)), old);
    env.Spicetify.Player = fresh;
    old.data = null;
    fresh.data = {
        item: { uri: A.uri, name: A.name, artists: [{ name: A.artist }], duration: { milliseconds: 200000 }, metadata: {} },
        duration: 200000, isPaused: false, context: null,
    };
    api._tick();
    assert.ok(api._current(), "deveria ter comecado a acompanhar a faixa do Player novo");
    assert.strictEqual(api._current().uri, A.uri);
});

test("espera o Spicetify terminar o setup (Player.origin) antes de iniciar", () => {
    const env = buildMockSpicetify();
    delete env.Spicetify.Player.origin;
    const api = loadExtension(env);
    assert.strictEqual(api, undefined, "nao pode iniciar com o Player provisorio");
});

// ============================================================
// IDENTIDADE
// ============================================================

test("identidade: versoes da mesma musica viram a mesma chave", () => {
    const api = loadExtension(buildMockSpicetify());
    const k = api.identityKey;
    assert.strictEqual(k("Devil Woman - 2001 Remaster", "Cliff Richard"), k("Devil Woman", "Cliff Richard"));
    assert.strictEqual(k("Big in Japan - Single Version; 2019 Remaster", "Alphaville"), k("Big in Japan", "Alphaville"));
    assert.strictEqual(k("Them Bones (2022 Remaster)", "Alice In Chains"), k("Them Bones", "Alice In Chains"));
    assert.strictEqual(k("Rein Me In (with Olivia Dean)", "Sam Fender"), k("Rein Me In", "Sam Fender"));
    assert.strictEqual(k("Flower (feat. SZA)", "X"), k("Flower", "X"));
    assert.strictEqual(k("Coração", "Fulano"), k("Coracao", "fulano"));
});

test("identidade: musicas diferentes continuam diferentes", () => {
    const api = loadExtension(buildMockSpicetify());
    const k = api.identityKey;
    assert.notStrictEqual(k("Upside Down", "Diana Ross"), k("Upside Down", "Jack Johnson"));
    assert.notStrictEqual(k("RAGE (SLOWED)", "X"), k("RAGE", "X"));
    assert.notStrictEqual(k("Song - Live", "X"), k("Song", "X"));
    assert.strictEqual(k("Sem artista", ""), null, "sem artista nao da pra identificar");
});

test("identidade: aprendizado em URIs diferentes da mesma musica e compartilhado", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    api.learn("spotify:track:single", "Nice To Each Other", "Olivia Dean", "full");
    api.learn("spotify:track:album", "Nice To Each Other", "Olivia Dean", "full");
    assert.strictEqual(api.peekSong("spotify:track:single"), api.peekSong("spotify:track:album"));
    assert.strictEqual(api.peekSong("spotify:track:album").p, 2);
});

// ============================================================
// MODELO DE SCORE
// ============================================================

test("score: um pulo isolado quase nao pesa (nao enterra a musica)", () => {
    const api = loadExtension(buildMockSpicetify());
    api.learn(A.uri, A.name, A.artist, "heavySkip");
    const s = api.scoreOf(A.uri);
    assert.ok(s < 0 && s > -30, `um pulo deveria dar score levemente negativo (got ${s})`);
});

test("score: varias audicoes completas -> favorita; varios pulos -> evitada", () => {
    const api = loadExtension(buildMockSpicetify());
    for (let i = 0; i < 8; i++) api.learn(A.uri, A.name, A.artist, "full");
    for (let i = 0; i < 8; i++) api.learn(B.uri, B.name, B.artist, "heavySkip");
    assert.ok(api.scoreOf(A.uri) >= 60, `A deveria ser favorita (got ${api.scoreOf(A.uri)})`);
    assert.ok(api.scoreOf(B.uri) <= -60, `B deveria ser evitada (got ${api.scoreOf(B.uri)})`);
});

test("score: musica curtida resiste a pulos", () => {
    const api = loadExtension(buildMockSpicetify());
    const s = api.songFor(A.uri, A.name, A.artist);
    s.lk = 1;
    api.learn(A.uri, A.name, A.artist, "skip");
    api.learn(A.uri, A.name, A.artist, "skip");
    assert.ok(api.scoreOf(A.uri) > 0, `curtida com 2 pulos ainda deve ser positiva (got ${api.scoreOf(A.uri)})`);
});

test("score: evidencia decai com o tempo (meia-vida)", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    for (let i = 0; i < 5; i++) api.learn(B.uri, B.name, B.artist, "heavySkip");
    const antes = api.scoreOf(B.uri);
    env.wait(api.MODEL.halfLifeDays * DAY * 2);
    const depois = api.scoreOf(B.uri);
    assert.ok(depois > antes, `score negativo deve se recuperar com o tempo (${antes} -> ${depois})`);
});

test("turbinar/evitar: ajuste manual, clicar no oposto volta pro neutro, respeita limite", () => {
    const api = loadExtension(buildMockSpicetify());
    api.nudge(A.uri, A.name, A.artist, +1);
    assert.strictEqual(api.scoreOf(A.uri), 20);
    api.nudge(A.uri, A.name, A.artist, -1);
    assert.strictEqual(api.scoreOf(A.uri), 0, "oposto volta pro neutro");
    for (let i = 0; i < 10; i++) api.nudge(A.uri, A.name, A.artist, +1);
    assert.strictEqual(api.peekSong(A.uri).m, 5);
    assert.ok(api.scoreOf(A.uri) <= 100);
});

test("aprendizado desligado: nao aprende, mas turbinar ainda funciona", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    api.settings.learning = false;
    listenThenNext(env, A, 200000);
    assert.strictEqual(api.peekSong(A.uri), null);
    api.nudge(A.uri, A.name, A.artist, +1);
    assert.ok(api.scoreOf(A.uri) > 0);
});

// ============================================================
// TRACKER
// ============================================================

test("tracker: ouvir ate o fim conta como completa", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    listenThenNext(env, A, 199000);
    const s = api.peekSong(A.uri);
    assert.strictEqual(s.p, 1);
    assert.ok(api.scoreOf(A.uri) > 0);
});

test("tracker: pular no comeco conta como pulo (e cria entrada com nome e artista)", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    listenThenNext(env, A, 6000);
    const s = api.peekSong(A.uri);
    assert.strictEqual(s.sk, 1);
    assert.strictEqual(s.n, A.name);
    assert.strictEqual(s.a, A.artist);
    assert.ok(api.scoreOf(A.uri) < 0);
});

test("tracker: menos de 3s e navegacao, nao conta", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    listenThenNext(env, A, 2000);
    assert.strictEqual(api.peekSong(A.uri), null);
});

test("tracker: ouvir metade da credito parcial, sem contar como completa", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    listenThenNext(env, A, 100000);
    const s = api.peekSong(A.uri);
    assert.strictEqual(s.p, 0);
    assert.strictEqual(s.sk, 0);
    assert.ok(api.scoreOf(A.uri) > 0);
});

test("tracker: pular pra frente (seek) nao conta como ouvido", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(A);
    env.setQueue({ nextUp: [B] });
    env.play(10000);
    env.seek(150000);   // pulou pra 75% sem ouvir
    env.play(5000);
    env.changeTrack(B);
    const s = api.peekSong(A.uri);
    assert.strictEqual(s.p, 0, "nao pode virar audicao completa");
    assert.strictEqual(s.sk, 1, "15s ouvidos de 200s = pulo");
});

test("tracker: pausa longa nao vira tempo ouvido", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(A);
    env.setQueue({ nextUp: [B] });
    env.play(10000);
    env.pause();
    env.wait(30 * 60000);
    env.resume();
    env.play(5000);
    env.changeTrack(B);
    assert.strictEqual(api.peekSong(A.uri).p, 0);
    assert.strictEqual(api.peekSong(A.uri).sk, 1);
});

test("tracker: faixa retomada no meio (abriu o app) nao e penalizada ao pular", () => {
    const env = buildMockSpicetify();
    env.initTrack(A, 120000); // ja estava em 60% quando a extensao carregou
    const api = loadExtension(env);
    env.setQueue({ nextUp: [B] });
    env.play(5000);
    env.changeTrack(B);
    const s = api.peekSong(A.uri);
    assert.ok(!s || s.sk === 0, "nao deve contar pulo");
});

test("tracker: varios pulos seguidos pesam cada vez menos", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    listenThenNext(env, A, 5000, B);
    env.setQueue({ nextUp: [C] }); env.play(5000); env.changeTrack(C);
    env.setQueue({ nextUp: [D] }); env.play(5000); env.changeTrack(D);
    const dA = api.peekSong(A.uri).d, dB = api.peekSong(B.uri).d, dC = api.peekSong(C.uri).d;
    assert.ok(dA > dB && dB > dC, `penalidades devem diminuir: ${dA} > ${dB} > ${dC}`);
});

test("tracker: escolher outra musica (fora da ordem) da credito pra escolhida e pune menos a atual", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(A);
    env.setQueue({ nextUp: [B] });
    env.play(6000);
    env.changeTrack(C); // usuario clicou em C, nao era a proxima
    assert.strictEqual(api.peekSong(C.uri).pk, 1, "C foi escolhida");
    const envB = buildMockSpicetify();
    const apiB = loadExtension(envB);
    listenThenNext(envB, A, 6000);
    assert.ok(api.peekSong(A.uri).d < apiB.peekSong(A.uri).d, "trocar por escolha pune menos que apertar proxima");
});

test("tracker: troca causada pela propria extensao nao penaliza a faixa atual", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.addPlaylist("spotify:playlist:p2", [B, C, D]);
    env.changeTrack(A);
    env.play(5000);
    await api.playAdaptive("spotify:playlist:p2");
    assert.strictEqual(env.Spicetify.Player._nextCalls, 1);
    env.changeTrack(B);
    const s = api.peekSong(A.uri);
    assert.ok(!s || s.sk === 0, "A nao foi pulada pelo usuario");
});

test("tracker: repetir uma faixa so (repeat one) conta cada volta", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(A);
    env.play(199000);
    env.state.pos = 0; // deu a volta sem songchange
    env.play(1000);
    assert.strictEqual(api.peekSong(A.uri).p, 1);
});

test("tracker: curtir durante a musica marca como curtida e registra na atividade", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(Object.assign({ liked: false }, A));
    env.play(3000);
    env.setLiked(true);
    env.play(1000);
    assert.strictEqual(api.peekSong(A.uri).lk, 1);
    assert.strictEqual(api.store.log[api.store.log.length - 1].k, "like");
});

test("tracker: adicionar a fila conta a favor; adicionar album inteiro pesa menos por faixa", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(A);
    env.setQueue({ queued: [B] });
    env.changeTrack(C);
    assert.strictEqual(api.peekSong(B.uri).q, 1);
    const one = api.peekSong(B.uri).l;

    const env2 = buildMockSpicetify();
    const api2 = loadExtension(env2);
    env2.changeTrack(A);
    const album = [1, 2, 3, 4, 5].map((i) => ({ uri: "spotify:track:al" + i, name: "Faixa " + i, artist: "Banda" }));
    env2.setQueue({ queued: album });
    env2.changeTrack(C);
    assert.ok(api2.peekSong("spotify:track:al1").l < one);
});

// ============================================================
// SHUFFLE
// ============================================================

test("weightedShuffle: devolve todas as faixas, sem criar entradas pra desconhecidas", () => {
    const api = loadExtension(buildMockSpicetify());
    const uris = Array.from({ length: 50 }, (_, i) => "spotify:track:x" + i);
    const out = api.weightedShuffle(uris);
    assert.strictEqual(out.length, 50);
    assert.strictEqual(new Set(out).size, 50);
    assert.strictEqual(Object.keys(api.store.songs).length, 0, "embaralhar nao pode poluir o armazenamento");
});

test("weightedShuffle: favoritas tendem a vir antes, evitadas depois", () => {
    const api = loadExtension(buildMockSpicetify());
    for (let i = 0; i < 6; i++) api.learn("spotify:track:love", "Love", "X", "full");
    for (let i = 0; i < 6; i++) api.learn("spotify:track:hate", "Hate", "Y", "heavySkip");
    api.peekSong("spotify:track:love").lp = 0; // nao tocou recentemente (senao a anti-repeticao empurra pro fim)
    const uris = ["spotify:track:love", "spotify:track:hate"].concat(Array.from({ length: 18 }, (_, i) => "spotify:track:n" + i));
    let love = 0, hate = 0;
    for (let r = 0; r < 300; r++) {
        const out = api.weightedShuffle(uris);
        love += out.indexOf("spotify:track:love");
        hate += out.indexOf("spotify:track:hate");
    }
    assert.ok(love / 300 < 6, `favorita deveria ficar no comeco (media ${love / 300})`);
    assert.ok(hate / 300 > 13, `evitada deveria ficar no fim (media ${hate / 300})`);
});

test("weightedShuffle: o que tocou ha pouco vai mais pro fim (anti-repeticao)", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    api.learn("spotify:track:recent", "Recent", "X", "full");
    api.learn("spotify:track:old", "Old", "Y", "full");
    api.peekSong("spotify:track:old").lp = env.clock.t - 3 * DAY;
    const uris = ["spotify:track:recent", "spotify:track:old"].concat(Array.from({ length: 10 }, (_, i) => "spotify:track:n" + i));
    let recent = 0, old = 0;
    for (let r = 0; r < 300; r++) {
        const out = api.weightedShuffle(uris);
        recent += out.indexOf("spotify:track:recent");
        old += out.indexOf("spotify:track:old");
    }
    assert.ok(recent > old, `recente deveria vir depois (${recent / 300} vs ${old / 300})`);
});

test("spreadArtists: evita mesmo artista em sequencia quando possivel", () => {
    const api = loadExtension(buildMockSpicetify());
    const artist = { a1: "A", a2: "A", a3: "A", b1: "B", b2: "B", c1: "C" };
    const out = api.spreadArtists(["a1", "a2", "a3", "b1", "b2", "c1"], (u) => artist[u]);
    for (let i = 1; i < out.length; i++) {
        if (artist[out[i]] === artist[out[i - 1]]) assert.fail("artista repetido em sequencia: " + out.join(","));
    }
});

// ============================================================
// FILA
// ============================================================

test("reshuffle: busca a playlist inteira, mantem a fila manual na frente e termina com delimiter", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    const tracks = Array.from({ length: 30 }, (_, i) => ({ uri: "spotify:track:t" + i, name: "Song " + i, artist: "Artist " + (i % 7) }));
    env.addPlaylist("spotify:playlist:p1", tracks);
    env.changeTrack(Object.assign({}, tracks[0], { context: "spotify:playlist:p1" }));
    env.setQueue({ queued: [C], nextUp: tracks.slice(1, 6) });
    env.resetSetQueueCalls();

    assert.strictEqual(await api.reshuffle(), true);
    const call = env.setQueueCalls()[0];
    const uris = call.nextTracks.map((t) => t.contextTrack.uri);
    assert.strictEqual(uris[0], C.uri, "fila manual continua na frente");
    assert.strictEqual(call.nextTracks[0].provider, "queue");
    assert.strictEqual(uris[uris.length - 1], "spotify:delimiter");
    const body = uris.slice(1, -1);
    assert.strictEqual(body.length, 29, "playlist inteira menos a atual");
    assert.ok(!body.includes(tracks[0].uri), "atual nao repete");
    assert.strictEqual(new Set(body).size, 29);
    assert.strictEqual(Object.keys(api.store.songs).length, 0, "reshuffle nao cria entradas pra faixas sem historico");
});

test("reshuffle: liga versoes diferentes da playlist ao que ja foi aprendido", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    for (let i = 0; i < 5; i++) api.learn("spotify:track:single", "Nice To Each Other", "Olivia Dean", "full");
    env.addPlaylist("spotify:playlist:p1", [
        { uri: "spotify:track:album", name: "Nice To Each Other", artist: "Olivia Dean" },
        { uri: "spotify:track:other", name: "Outra", artist: "Alguem" },
    ]);
    env.changeTrack(Object.assign({}, D, { context: "spotify:playlist:p1" }));
    await api.reshuffle();
    assert.strictEqual(api.scoreOf("spotify:track:album"), api.scoreOf("spotify:track:single"));
    assert.ok(api.scoreOf("spotify:track:album") > 0);
});

test("reshuffle: faixas da playlist nas Curtidas ganham preferencia mesmo sem historico", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    const tracks = Array.from({ length: 20 }, (_, i) => ({ uri: "spotify:track:t" + i, name: "Song " + i, artist: "Artist " + i }));
    env.addPlaylist("spotify:playlist:p1", tracks);
    env.liked.add("spotify:track:t19");
    let pos = 0;
    const R = 200;
    for (let r = 0; r < R; r++) {
        env.changeTrack({ uri: "spotify:track:cur", name: "Cur", artist: "Z", context: "spotify:playlist:p1" });
        env.resetSetQueueCalls();
        await api.reshuffle({ silent: true });
        pos += env.setQueueCalls()[0].nextTracks.map((t) => t.contextTrack.uri).indexOf("spotify:track:t19");
    }
    // sem preferencia a media seria 9,5; com a Curtida fica ~6,3 (pior caso simulado: 7,9)
    assert.ok(pos / R < 8.5, `curtida deveria vir cedo (media ${pos / R})`);
});

test("reshuffle: contexto desconhecido (radio) reordena so o trecho do contexto e preserva o resto", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(Object.assign({}, A, { context: "spotify:station:xyz" }));
    const ctx = Array.from({ length: 6 }, (_, i) => ({ uri: "spotify:track:r" + i, name: "R" + i, artist: "Ar" + i }));
    const auto = { uri: "spotify:track:auto", name: "Auto", artist: "Q", provider: "autoplay" };
    env.setQueue({ queued: [B], nextUp: ctx.concat([auto]) });
    env.resetSetQueueCalls();
    assert.strictEqual(await api.reshuffle(), true);
    const nt = env.setQueueCalls()[0].nextTracks;
    assert.strictEqual(nt[0].contextTrack.uri, B.uri, "fila manual na frente");
    assert.strictEqual(nt[nt.length - 1].contextTrack.uri, auto.uri, "autoplay continua no fim");
    assert.strictEqual(nt[1].contextTrack.uid.indexOf("uid-"), 0, "mantem os objetos originais do Spotify");
    assert.strictEqual(nt.length, 8);
});

test("reshuffle: avisa quando nao ha o que embaralhar", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.changeTrack(Object.assign({}, A, { context: "spotify:station:xyz" }));
    assert.strictEqual(await api.reshuffle(), false);
    assert.ok(env.notifications.some((n) => /suficientes/.test(n)));
});

test("playAdaptive: toca a playlist na ordem adaptativa e atualiza o contexto", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.addPlaylist("spotify:playlist:p9", [A, B, C, D]);
    await api.playAdaptive("spotify:playlist:p9");
    const uris = env.setQueueCalls()[0].nextTracks.map((t) => t.contextTrack.uri);
    assert.strictEqual(uris.length, 5);
    assert.strictEqual(env.Spicetify.Platform.PlayerAPI._lastContext.uri, "spotify:playlist:p9");
});

test("shuffle automatico: com o aleatorio do Spotify ligado, assume ao comecar um contexto novo", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    api.settings.autoShuffle = true;
    env.addPlaylist("spotify:playlist:p1", [A, B, C, D]);
    env.resetSetQueueCalls();
    env.changeTrack(A, { shuffle: true });
    await settle();
    assert.strictEqual(env.setQueueCalls().length, 1);
});

test("shuffle automatico: desligado (ou aleatorio do Spotify desligado) nao mexe na fila", async () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    env.addPlaylist("spotify:playlist:p1", [A, B, C, D]);
    env.changeTrack(A, { shuffle: true });
    await settle();
    assert.strictEqual(env.setQueueCalls().length, 0, "autoShuffle desligado");
    api.settings.autoShuffle = true;
    env.changeTrack(B, { shuffle: false, context: { uri: "spotify:playlist:p1" } });
    await settle();
    assert.strictEqual(env.setQueueCalls().length, 0, "aleatorio do Spotify desligado");
});

// ============================================================
// PERSISTENCIA E MIGRACAO
// ============================================================

test("persistencia: score sobrevive a um reload", () => {
    const env = buildMockSpicetify();
    const api = loadExtension(env);
    for (let i = 0; i < 3; i++) api.learn(A.uri, A.name, A.artist, "full");
    api.flush();
    const antes = api.scoreOf(A.uri);
    const api2 = loadExtension(env);
    assert.strictEqual(api2.scoreOf(A.uri), antes);
});

test("migracao v1: converte contagens, ignora lixo e mantem o dado antigo como backup", () => {
    const env = buildMockSpicetify();
    const legacy = {
        "spotify:track:loved": { s: 35, p: 10, sk: 1, q: 3, pk: 0, t: env.clock.t, n: "Loved" },
        "spotify:track:oneskip": { s: -5, p: 0, sk: 1, q: 0, pk: 0, t: env.clock.t, n: "One Skip" },
        "spotify:track:zero": { s: 0, p: 0, sk: 0, q: 0, pk: 0, t: env.clock.t, n: "" },
        "spotify:delimiter": { s: 3, p: 0, sk: 0, q: 1, pk: 0, t: env.clock.t, n: "spotify:delimiter" },
        "": { s: 5, p: 0, sk: 0, q: 1, pk: 0, t: env.clock.t, n: "" },
    };
    env.storage.set("adaptiveShuffle:tracks", JSON.stringify(legacy));
    const api = loadExtension(env);
    assert.deepStrictEqual(Object.keys(api.store.songs).sort(), ["spotify:track:loved", "spotify:track:oneskip"]);
    assert.ok(api.scoreOf("spotify:track:loved") >= 60);
    assert.ok(api.scoreOf("spotify:track:oneskip") > -25, "um pulo antigo nao enterra mais a musica");
    assert.ok(env.storage.get("adaptiveShuffle:tracks"), "dado v1 continua la como backup");
});

test("migracao v1: manutencao em background descobre titulo/artista e junta duplicatas", async () => {
    const env = buildMockSpicetify();
    env.storage.set("adaptiveShuffle:tracks", JSON.stringify({
        "spotify:track:v1a": { s: 27, p: 4, sk: 1, q: 0, pk: 2, t: env.clock.t, n: "Nice To Each Other" },
        "spotify:track:v1b": { s: -10, p: 1, sk: 3, q: 0, pk: 0, t: env.clock.t, n: "Nice To Each Other" },
    }));
    env.catalog["spotify:track:v1a"] = { name: "Nice To Each Other", artist: "Olivia Dean" };
    env.catalog["spotify:track:v1b"] = { name: "Nice To Each Other", artist: "Olivia Dean" };
    env.liked.add("spotify:track:v1b");
    const api = loadExtension(env);
    await api.backgroundMaintenance();
    assert.strictEqual(api.peekSong("spotify:track:v1a"), api.peekSong("spotify:track:v1b"));
    const s = api.peekSong("spotify:track:v1a");
    assert.strictEqual(s.p, 5);
    assert.strictEqual(s.lk, 1, "status de Curtida atualizado");
    assert.ok(api.scoreOf("spotify:track:v1b") > 0);
});

test("configuracoes: descarta chaves antigas e mantem as escolhas do usuario", () => {
    const env = buildMockSpicetify();
    env.storage.set("adaptiveShuffle:settings", JSON.stringify({ aggressiveness: "intenso", clamp: 10, decay: 0.9, autoShuffle: true, learning: true }));
    const api = loadExtension(env);
    assert.strictEqual(api.settings.aggressiveness, "intenso");
    assert.strictEqual(api.settings.autoShuffle, true);
    assert.strictEqual(api.settings.clamp, undefined);
    assert.strictEqual(api.settings.decay, undefined);
});

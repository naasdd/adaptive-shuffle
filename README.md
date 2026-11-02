# Adaptive Shuffle

Extensão para o [Spicetify](https://spicetify.app) que cria um **shuffle inteligente** pro Spotify. Ela **aprende o seu gosto** enquanto você ouve e monta a fila tocando mais o que você curte:

- 🎧 **Ouviu até o fim, pôs na fila, escolheu tocar, curtiu (♥)** → a música passa a aparecer mais.
- ⏭️ **Pulou logo no começo várias vezes** → ela fica rara (nunca some de vez, seu gosto pode mudar).
- 🎚️ **Você tem a palavra final**: turbine ou evite qualquer faixa na hora.

Tudo fica salvo **só no seu computador** (LocalStorage do Spotify). Funciona no **Windows e no macOS/Linux**.

---

## Como usar

Na primeira vez, aparece uma tela de boas-vindas explicando tudo (dá pra rever em **Como funciona**).

1. **Use o Spotify normalmente.** A extensão aprende sozinha em background.
2. **Botão ✦ na barra do player** (lado direito, perto da letra/fila) abre o painel:
   - a música atual com capa, **score** e o porquê (“Favorita · 5× até o fim · 1 pulo”);
   - **Turbinar** / **Evitar**: ajuste manual que nunca é esquecido (clicar no oposto volta pro neutro);
   - **Embaralhar a fila agora**: reordena a playlist/álbum/Curtidas **inteira** pelo seu gosto, sem parar a música e mantendo a sua fila manual na frente;
   - **Shuffle automático** (liga/desliga direto no painel);
   - **Esquecer o que aprendi desta faixa**, **Configurações e estatísticas**, **Como funciona**.
3. **Botão direito numa playlist, álbum, artista ou Músicas Curtidas → `Tocar com Adaptive Shuffle`.**
4. **Botão direito em qualquer faixa (ou várias) → `Adaptive Shuffle` → Turbinar / Evitar / Esquecer.**

### Configurações e estatísticas

- **Intensidade** (Leve / Normal / Intenso): o quanto o gosto pesa no sorteio. A tela mostra quantas vezes mais uma favorita tende a vir antes de uma música neutra.
- **Shuffle automático**: com o aleatório do Spotify ligado, o Adaptive Shuffle assume a ordem ao começar uma playlist/álbum/Curtidas, quando você liga o aleatório e quando a fila está acabando.
- **Evitar repetir o que tocou há pouco**: o que você ouviu nas últimas 24 h vai mais pro fim da fila.
- **Espalhar artistas**: evita o mesmo artista duas vezes seguidas.
- **Aprender com o que eu ouço**: desligado, continua embaralhando com o que já sabe, sem aprender nada novo.
- **Suas músicas**: mais amadas, mais evitadas, busca por música/artista e a aba **Atividade**, que mostra o que ele aprendeu e quando (“Pulou no começo · Manchild · +46 → +38 · há 5 min”). Dá pra turbinar/evitar/esquecer direto na lista.
- **Seus dados**: exportar/importar backup (JSON) e apagar tudo (pede confirmação).

---

## Como o algoritmo funciona

### Score
Cada música acumula **evidência de que você gosta** (L) e **de que não gosta** (D):

| Evento | Evidência |
|---|---|
| Ouviu ≥ 80% (ou até o fim) | L + 1 |
| Ouviu entre 25% e 80% | L + até 0,5 (proporcional) |
| Escolheu tocar (clicou numa faixa fora da ordem, voltou pra anterior) | L + 0,7 |
| Pôs na fila manualmente | L + 1 (ou + 0,3 por faixa se adicionou 5+ de uma vez, ex.: álbum inteiro) |
| Pulou entre 10% e 25% | D + 0,6 |
| Pulou antes de 10% | D + 1 |
| Ouviu menos de 3 s | nada (você estava navegando) |

A preferência é **`(L − D) / (L + D + 3)`**, entre −1 e +1 (o score na tela é isso × 100). O `+3` funciona como "dúvida inicial": com poucas observações o score fica perto de zero, então **um pulo isolado quase não pesa**, e é preciso um padrão pra música subir ou cair muito.

Ajustes em cima disso:

- **Curtidas**: música nas suas Curtidas ganha L + 2,5 fixo, então resiste a pulos ocasionais.
- **Turbinar/Evitar**: cada clique soma ±20 pontos (±0,2) direto na preferência (até ±5 cliques) e não decai.
- **Esquecimento**: a evidência perde metade do peso a cada **120 dias** sem ser reforçada, então uma música evitada pode "voltar".
- **Pulos em sequência** (procurando alguma coisa) pesam cada vez menos: o 2º vale 2/3, o 3º vale metade…
- **Contexto do pulo**: trocar de faixa porque escolheu outra música ou outra playlist pune pela metade. Trocas feitas pela própria extensão não punem, e música que já estava no meio quando o app abriu também não.
- **O que conta é o tempo realmente ouvido**: arrastar a barra pra frente ou deixar pausado não vira "ouviu inteira". Repeat de uma faixa só conta cada volta.

### Mesma música, várias versões
O Spotify tem a mesma música em várias URIs (single, álbum, remaster, versão regional). A extensão identifica a música por **título + artista** normalizados (ignorando "Remaster", "feat.", "with", acentos…) e **junta o aprendizado** de todas as versões. "Slowed", "Live", "Acoustic" etc. continuam sendo músicas diferentes.

### Embaralhamento
O peso de cada faixa no sorteio é **`e^(força × preferência)`**, com força 1 / 2 / 3 (Leve / Normal / Intenso). No Normal, uma favorita (+80) tem ~5× mais chance de vir antes que uma neutra; no Intenso, ~11×. A ordem é sorteada sem reposição ([Efraimidis–Spirakis](https://en.wikipedia.org/wiki/Reservoir_sampling#Algorithm_A-Res)), então **ninguém é excluído**: só fica mais pro começo ou mais pro fim.

Extras: músicas sem histórico ganham um leve empurrão (pra serem descobertas), o que tocou nas últimas 24 h fica mais pro fim, e o mesmo artista não aparece duas vezes seguidas quando dá pra evitar.

---

## Instalação

Você precisa do Spicetify instalado: <https://spicetify.app/docs/getting-started>

### Opção A: Marketplace do Spicetify (mais fácil)

1. No Spotify, abra o **Marketplace** (ícone de carrinho no topo).
2. Na aba **Extensions**, busque **Adaptive Shuffle** (ou ordene por "atualizadas recentemente").
3. Clique em **Install** e recarregue o Spotify.

### Opção B: script automático

**macOS / Linux:**
```bash
./install-macos.sh
```

**Windows (PowerShell):**
```powershell
.\install-windows.ps1
```

O script copia a extensão pra pasta do Spicetify, habilita e aplica. Reinicie o Spotify depois.

### Opção C: manual

1. Copie `adaptive-shuffle.js` para a pasta de extensões do Spicetify:
   - **macOS/Linux:** `~/.config/spicetify/Extensions/`
   - **Windows:** `%appdata%\spicetify\Extensions\`
2. No terminal:
   ```bash
   spicetify config extensions adaptive-shuffle.js
   spicetify apply
   ```
3. Reinicie o Spotify.

### Atualizando da v1
Na primeira vez que a v2 abre, ela converte o que a v1 aprendeu (plays, pulos, fila) pro modelo novo e, em background, descobre título/artista de cada faixa pra juntar duplicatas e marcar as Curtidas. O score antigo é descartado (ele estava distorcido por bugs da v1), mas o histórico de plays e pulos é mantido. Os dados da v1 continuam intactos em `adaptiveShuffle:tracks` como backup.

---

## Desinstalação

**macOS / Linux:** `./uninstall-macos.sh`
**Windows:** `.\uninstall-windows.ps1`

Os dados aprendidos continuam no LocalStorage do Spotify. Pra apagar: botão ✦ → Configurações → **Apagar tudo**.

---

## Para desenvolvedores

```
teste-shuffle/
├── adaptive-shuffle.js          ← a extensão (autocontida, sem dependências)
├── tests/
│   ├── logic.test.js            ← testes (node:test)
│   └── mock-spicetify.js        ← Spicetify simulado: player com relógio, fila, APIs
├── package.json                 ← só o script de teste
├── manifest.json                ← p/ publicar no Marketplace do Spicetify
├── install-*/uninstall-*        ← scripts de instalação
└── README.md
```

### Testes
```bash
npm test
```
Carregam a extensão inteira num Spicetify simulado, com relógio controlável, e cobrem: modelo de score (pulo isolado, Curtidas, decaimento, turbinar), identidade/duplicatas, tracker (seek, pausa, retomada, repeat, pulos em sequência, escolha fora da ordem, trocas da própria extensão), fila (playlist inteira, fila manual preservada, rádio, Curtidas), shuffle automático, migração da v1 e persistência.

### Debug no Spotify
Abra o DevTools (`spicetify enable-devtools`) e use o objeto exposto:
```js
AdaptiveShuffle.debug = true                     // loga cada evento aprendido no console
AdaptiveShuffle.store                            // tudo que aprendeu (songs, uris, log)
AdaptiveShuffle.peekSong("spotify:track:ID")     // dados de uma faixa
AdaptiveShuffle.scoreOf("spotify:track:ID")      // score de -100 a +100
AdaptiveShuffle.reshuffle()                      // mesmo que "Embaralhar a fila agora"
AdaptiveShuffle.backgroundMaintenance()          // reidentifica faixas e atualiza Curtidas
```

### Compatibilidade
No Spotify 1.3.x o Spicetify (2.46) não encontra mais o container da barra do player. A extensão detecta isso e coloca o botão sozinha ao lado dos botões nativos.

---

## Privacidade

- Todos os dados ficam **no seu computador** (LocalStorage do Spotify).
- A extensão só conversa com o próprio Spotify (pra ler playlists, Curtidas e nomes de faixas). Nada é enviado pra terceiros.
- O armazenamento é limitado (6000 músicas) com limpeza automática das menos relevantes.

---

## Licença

MIT. Use, modifique e compartilhe à vontade.

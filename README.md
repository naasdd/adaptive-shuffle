# Adaptive Shuffle

Extensão para o [Spicetify](https://spicetify.app) que cria um **shuffle inteligente** pro Spotify. Ela **aprende seu comportamento** com cada música:

- 🎧 **Música que você ouve até o fim** → passa a tocar mais.
- 🙆 **Música que você sempre pula** → some (fica rara, nunca é excluída pra sempre).
- ⭐ **Música que você escolhe / manda pra fila** → ganha prioridade.

Tudo o que ele aprende fica salvo **localmente** no Spotify (LocalStorage do seu computador). Nada é enviado pra fora. Funciona no **Windows e no macOS/Linux**.

---

## Como usar no dia a dia

1. Use o Spotify normalmente. A extensão aprende sozinha em background.
2. Quando quiser o shuffle inteligente, faça uma das opções:
   - **Clique no botão ✨ `Adaptive Shuffle`** na barra do player → reordena a fila atual sem parar a música.
   - **Clique com o direito numa playlist/álbum/artista → `Tocar com Adaptive Shuffle`**.
3. Se ele errar o gosto numa música, **clique com o direito nela**:
   - `Adaptive Shuffle: Turbinar ⭐` — força ela a tocar mais.
   - `Adaptive Shuffle: Evitar 🙅` — força ela a sumir.
   - `Adaptive Shuffle: Resetar 🔄` — apaga o que ele aprendeu só dessa faixa.
4. **Menu do Spicetify (× no topo) → `Adaptive Shuffle`** abre as **configurações**:
   - Ligar/desligar o aprendizado.
   - Ajustar agressividade (Leve / Normal / Intenso).
   - Ver suas **mais amadas** e **mais evitadas** com a barrinha de score.
   - Apagar tudo e começar do zero.

> 💡 Quanto mais você usa, mais ele acerta. Nos primeiros dias ele ainda está aprendendo.

---

## Instalação

Você precisa do Spicetify instalado: <https://spicetify.app/docs/getting-started>

### Opção A — Script automático (recomendado)

**macOS / Linux:**
```bash
cd teste-shuffle
./install-macos.sh
```

**Windows (PowerShell):**
```powershell
cd teste-shuffle
.\install-windows.ps1
```

O script copia a extensão pra pasta do Spicetify, habilita e aplica. Reinicie o Spotify depois.

### Opção B — Manual (passo a passo)

1. Copie `adaptive-shuffle.js` para a pasta de extensões do Spicetify:
   - **macOS/Linux:** `~/.config/spicetify/Extensions/`
   - **Windows:** `%appdata%\spicetify\Extensions\`
2. No terminal:
   ```bash
   spicetify config extensions adaptive-shuffle.js
   spicetify apply
   ```
3. Reinicie o Spotify.

---

## Desinstalação

**macOS / Linux:** `./uninstall-macos.sh`
**Windows:** `.\uninstall-windows.ps1`

Ou manual:
```bash
spicetify config extensions adaptive-shuffle.js --disable   # ou edite o config e remova o nome
spicetify apply
```
e apague o arquivo da pasta `Extensions/`.

Os dados aprendidos ficam no LocalStorage do Spotify. Pra apagar: menu do Spicetify → Adaptive Shuffle → **"Começar do zero"**.

---

## Como o algoritmo funciona (resumo)

Cada faixa recebe um **score** entre −10 e +10, com **decaimento** (comportamento recente vale mais):

| Evento | Efeito (modo Normal) |
|---|---|
| Ouviu ≥80% da música | `+2` |
| Pulou antes de 25% | `−2` |
| Pulou antes de 10% (skip pesado) | `−3` |
| Adicionou à fila manualmente | `+3` |
| Clicou pra tocar a música | `+2` |

No shuffle adaptativo o **peso** de cada faixa é `2^(score/3)` — uma faixa amada (score +9) fica ~**8x** mais provável no topo; uma enjoada (score −9) fica ~**8x** mais rara, mas **nunca é excluída** (seu gosto pode mudar).

Você pode ajustar a **agressividade** (Leve/Normal/Intenso) nas configurações para os pesos serem mais ou menos forte.

---

## Para desenvolvedores

Os arquivos do projeto:

```
teste-shuffle/
├── adaptive-shuffle.js          ← a extensão (autocontida, sem dependências)
├── tests/
│   ├── logic.test.js            ← testes (node:test)
│   └── mock-spicetify.js        ← mock do Spicetify p/ teste de fumaça
├── package.json                 ← só o script de teste
├── manifest.json                ← p/ publicar no Marketplace do Spicetify
├── install-macos.sh / uninstall-macos.sh
├── install-windows.ps1 / uninstall-windows.ps1
└── README.md
```

### Rodar os testes
```bash
npm test        # ou: node --test tests/logic.test.js
```
Os testes carregam a extensão inteira num ambiente Spicetify mockado e validam: score, clamp, classificação de skip/play, shuffle ponderado, persistência, integração com a fila.

### Debug no Spotify
Abra o DevTools (Cmd+Option+I no macOS / Ctrl+Shift+I no Windows) e use o objeto exposed:
```js
AdaptiveShuffle.tracks               // tudo que aprendeu
AdaptiveShuffle.getTrack("spotify:track:ID")
AdaptiveShuffle.reshuffle()          // reordena a fila agora
AdaptiveShuffle.openSettings()
AdaptiveShuffle._resetTracking()     // re-sincroniza o tracker com a música atual
```

---

## Publicar no Marketplace do Spicetify (opcional)

A extensão já vem com `manifest.json` no formato exigido pelo Marketplace. Para publicar:

1. Crie um **repositório público no GitHub** com todo o conteúdo desta pasta.
2. Adicione o tópico do GitHub: **`spicetify-extensions`** (Settings → Topics).
3. Adicione uma imagem `preview.png` na raiz (print do botão/modal).
4. Envie um PR adicionando seu repositório em `spicetify/resources/data/extension.ts` do repo `spicetify/marketplace` (ou abra issue pedindo inclusão), conforme <https://github.com/spicetify/marketplace/wiki/Publishing-to-Marketplace>.

Depois sua extensão aparece instalável com 1 clique.

---

## Privacidade

- Todos os dados ficam **no seu computador** (LocalStorage do Spotify).
- Nenhuma requisicao externa e feita; nenhum dado e enviado para lugar nenhum.
- O armazenamento e limitado (~4000 faixas) com limpeza automatica (LRU).

---

## Licença

MIT. Use, modifique e compartilhe à vontade.
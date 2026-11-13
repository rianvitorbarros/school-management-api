# Editor de atividades (estilo Canva) — contrato da API

Base: `/api/school/activity-designs` (exige `verifyToken` + `verifySchoolAccess`).

## Conceito

- `ActivityDesign` guarda o documento editavel: paginas A4 com uma lista de elementos em JSON.
- A folha tem **cabecalho e rodape reservados** (`headerHeightPct`, padrao 13%; `footerHeightPct`, padrao 4%).
  As coordenadas dos elementos (`x`, `y`, `w`, `h`) sao **percentuais da area util** (entre cabecalho e rodape),
  entao nenhum elemento pode ser posicionado em cima do cabecalho.
- Publicar = o app envia um PNG/JPG A4 por pagina. A API cria/atualiza um `ActivityBook` com `sourceType: 'school'`,
  `visibility: 'restricted'`, `allowedSchoolIds: [escola]` e uma `ActivityPage` `sourceKind: 'image'` por pagina com
  `headerOverlay.heightPct = headerHeightPct`. A partir dai a atividade aparece na biblioteca da escola e usa o fluxo
  ja existente de impressao em lote (`/api/school/activity-library/:activityPageId/print`), com cabecalho, QR por aluno e
  correcao por criterios.
- Republicar reaproveita o mesmo caderno. Paginas removidas sao desativadas (nao apagadas), porque impressoes antigas
  referenciam o `activityPageId`.

## Permissoes

- Professor: ve e edita apenas as proprias atividades.
- Gestao (`admin`, `coordenador`, `gestor`, `secretaria`, `diretor`): acessa qualquer atividade da escola; `GET /?scope=school` lista todas.

## Endpoints

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/config` | Formato da pagina (A4 em pt, `headerHeightPct`, `footerHeightPct`) e limites |
| GET | `/` | Lista resumida (`page`, `limit`, `search`, `status`, `classId`, `scope=school`) |
| POST | `/` | Cria (`title`, `subject`, `segment`, `grade`, `description`, `tags`, `classId`, `pages?`). Comeca com 1 pagina em branco |
| GET | `/:designId` | Documento completo |
| PUT | `/:designId` | Salva metadados e/ou `pages`. Envie `revision` para concorrencia otimista (409 `DESIGN_REVISION_CONFLICT`) |
| POST | `/:designId/duplicate` | Copia como rascunho |
| DELETE | `/:designId` | Arquiva (e arquiva o caderno publicado) |
| POST | `/:designId/assets` | Upload de imagem (`multipart`, campo `file`; PNG/JPG/WEBP ate 8 MB) → `{ assetId }` |
| GET | `/:designId/assets/:assetId/content` | Bytes da imagem (passa pela API com o token, sem CORS) |
| POST | `/:designId/publish` | `multipart`: campo `pages` (1 arquivo por pagina, na ordem) + `revision` |

## Elemento

```json
{
  "id": "uuid",
  "type": "text | image | shape | line | answerBox | writingLines",
  "x": 10, "y": 5, "w": 80, "h": 8,
  "rotation": 0,
  "locked": false,
  "props": { "...": "propriedades visuais do tipo" }
}
```

`image` exige `props.assetId` de um asset ja enviado para o mesmo design.

Limites: 20 paginas, 200 elementos por pagina, 2 MB de JSON por design.

## Imagens do editor e acervo

| Metodo | Rota | Descricao |
|---|---|---|
| POST | `/:designId/assets` | Upload pelo editor: o arquivo vai para o acervo (`MediaAsset`, **privado** do professor) e a atividade guarda a referencia |
| POST | `/:designId/assets/from-library` | `{ mediaAssetId }`: coloca uma imagem do acervo na atividade sem reenviar o arquivo (idempotente) |
| POST | `/:designId/assets/from-icon` | `{ iconId }`: coloca um icone do pacote integrado na atividade (cria o `MediaAsset` global do icone no primeiro uso) |

# Pacote de icones — `/api/school/icons`

Biblioteca integrada e gratuita (nao consome a cota da Iara): **Fluent Emoji Flat** (Microsoft, licenca MIT),
1587 icones em 8 categorias, com nomes e palavras-chave em portugues do Unicode CLDR (Unicode License v3).
O catalogo fica em `assets/icon-packs/fluent-emoji-flat.json.gz` e e carregado em memoria.
A busca ignora acentos e maiusculas ("maca" encontra "maçã").

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/info` | Fonte, licenca, total e categorias com contagem |
| GET | `/` | Lista (`search`, `category`, `page`, `limit` ate 200) -> `{ items: [{ id, name, category, keywords }], page, limit, total }` |
| GET | `/:iconId/svg` | SVG do icone (`image/svg+xml`, cache de 7 dias) |

A partir do app 2.4.18 o pacote vem embutido no proprio app: o icone e um elemento `image` com
`props.iconId` (sem `assetId`), desenhado no computador do professor. A API so confere se o id existe
no pacote (`INVALID_DESIGN_ICON` caso contrario). O fluxo abaixo continua valendo para versoes anteriores.

Ao colocar um icone numa atividade (fluxo antigo), a API rasteriza o SVG em PNG 512px (miniatura 256px), envia para
`platform/icons/fluent-flat/<id>.png` no R2 e cria um `MediaAsset` global (`source: curated`,
`iconKey: fluent-flat:<id>`, indice unico). Os usos seguintes reaproveitam o mesmo registro.

# Acervo de imagens — `/api/school/media-assets`

Visibilidade:

- `global`: curadoria do AcademyHub, visivel para todas as escolas (upload em `POST /api/platform/media-assets`).
- `school`: todos os usuarios da escola. Padrao das imagens geradas pela Iara.
- `private`: quem enviou e a gestao. Padrao dos uploads (prints de sites/livros costumam ter direitos de terceiros).

Arquivar nao apaga o arquivo: atividades que ja usam a imagem continuam imprimindo.

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/` | Lista (`scope=all|school|mine|global`, `kind`, `source`, `search`, `page`, `limit`) |
| POST | `/` | Upload (`multipart` campo `file`; `title`, `tags`, `kind`, `visibility=private|school`) |
| GET | `/:assetId` | Detalhes |
| PATCH | `/:assetId` | `title`, `tags`, `kind`, `visibility` (dono ou gestao) |
| DELETE | `/:assetId` | Arquiva (dono ou gestao) |
| GET | `/:assetId/content` e `/:assetId/thumbnail` | Bytes da imagem/miniatura (passa pela API com o token) |
| GET | `/ai/quota` | Limite diario da escola e estilos disponiveis |
| POST | `/ai/generate` | `{ prompt (ate 4000), style: lineart|color|icon, count: 1-4, background?: transparent|scene }` |
| POST | `/ai/generate-from-reference` | multipart: `file` (PNG/JPG/WEBP ate 8 MB), `instructions?` (ate 300), `style`, `count`, `background?`, `keepText?` (`true` mantem o titulo/enunciado da referencia) |

Pedido longo (mais de 220 caracteres) ou com varias linhas e tratado como a descricao de uma folha inteira: o texto
do professor manda, o estilo so acrescenta as regras de desenho (texto permitido, em portugues), a imagem sai em pe
(2:3), o modelo de texto lista antes os textos que devem aparecer (titulo, legendas) e a geracao usa
`IARA_IMAGE_TEXT_MODELS` (padrao `gemini-3-pro-image,gemini-2.5-flash-image`), que escreve melhor e custa mais. O mesmo
modelo e usado em "manter o enunciado" da referencia. Desenhos simples continuam em `IARA_IMAGE_MODELS`.

Fundo das imagens geradas:

- `lineart` e `icon`: todo o branco vira transparente e as margens vazias sao recortadas.
- `color` + `background=transparent` (padrao): remove so o branco que encosta nas bordas (preserva o branco
  dentro do desenho, como olhos) e recorta.
- `color` + `background=scene`: cenario ate as bordas; se o modelo desenhar uma moldura/cartao branco em volta,
  ela sai e a imagem e recortada.
- `transparentBackground` (apps antigos) continua aceito.

Referencia: a imagem e reduzida (JPEG ate 1536 px) e enviada ao modelo com instrucoes fixas para recriar so a
ilustracao, sem titulos, textos, linhas de "Nome:", molduras, logotipos ou cabecalho (o AcademyHub coloca o
proprio). A referencia e sempre reconstruida (nao copiada): perspectiva, inclinacao e simetria corrigidas, tracos limpos,
sem duplicar linhas. Com `keepText=true`, o titulo e o enunciado da atividade sao mantidos (sai so linha de "Nome:", logotipo
e cabecalho); antes de gerar, o modelo de texto (`IARA_TEXT_MODEL`, padrao `gemini-2.5-flash`) transcreve o enunciado
e o texto exato vai no pedido da imagem, para as palavras sairem certas. Se o pedido do professor conflitar com essas regras, vale o pedido. Fotos da folha: a moldura escura
(mesa/borda do scanner) que o modelo copie e removida no processamento. A proporcao da imagem gerada segue a da referencia.
Respostas sem imagem por motivo que nao e seguranca (ex.: `IMAGE_OTHER`, parecida demais com a original) sao
repetidas automaticamente; se persistir, `IARA_IMAGE_TOO_SIMILAR` pede ao professor algumas mudancas. A referencia nao e guardada; as imagens geradas
entram no acervo da escola com `source: ai-from-reference` e contam no limite diario.

## Iara: geracao de imagens

- Modelo de imagem do Gemini via REST. Dois provedores (`IARA_IMAGE_PROVIDER`):
  - `gemini` (padrao): API do Google AI Studio (`generativelanguage.googleapis.com`) com a **`IARA_IMAGE_API_KEY`**,
    chave exclusiva para imagens (se vazia, usa a `GEMINI_API_KEY` da Iara de texto). Use um projeto com saldo:
    projetos no plano gratuito tem cota de imagem 0.
    Usa o saldo **pre-pago do AI Studio**; nao consome os creditos do Google Cloud.
  - `vertex`: Agent Platform / Vertex AI (`aiplatform.googleapis.com`) com `VERTEX_API_KEY`
    (opcionais `VERTEX_PROJECT_ID` e `VERTEX_LOCATION`, padrao `global`). Cobrado na **conta de faturamento do
    Google Cloud**, onde caem os creditos mensais do Google Developer Program. A chave precisa estar vinculada a uma
    conta de servico com o papel "Vertex AI User".
- `.env`: `IARA_IMAGE_MODELS` (padrao `gemini-2.5-flash-image`), `IARA_IMAGE_TIMEOUT_MS` (padrao 90000),
  `IARA_IMAGE_DAILY_LIMIT_PER_SCHOOL` (padrao 60 imagens/dia por escola).
- Estilos: `lineart` (para colorir: traco preto grosso, fundo branco, sem texto), `color` (cartoon simples colorido) e
  `icon` (objeto unico para exercicios de contagem). Os prompts ficam em `iara/iaraImage.client.js`.
- Para `lineart` e `icon` o fundo branco vira transparente por padrao, para o desenho poder ficar por cima de formas.
- As imagens geradas sao salvas no acervo da escola (`source: ai-generated`, com `prompt`, `style` e `model`) e ficam
  disponiveis para todos os professores.
- Erros: `429 IARA_IMAGE_DAILY_LIMIT`, `422 IARA_IMAGE_BLOCKED` (conteudo recusado), `503 IARA_IMAGE_NOT_CONFIGURED`/`IARA_IMAGE_BUSY`,
  `503 IARA_IMAGE_BILLING_REQUIRED` (plano gratuito sem cota de imagem ou creditos pre-pagos esgotados) e
  `503 IARA_IMAGE_NOT_AUTHORIZED` (chave sem permissao no modelo). Os dois ultimos param na primeira tentativa e
  explicam a causa no log do servidor.

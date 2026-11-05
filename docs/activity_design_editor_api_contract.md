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

# Andamento — Microsoft 365

Especificação: `docs/m365/ESPECIFICACAO.md`. Registro mantido pelo orquestrador
(dev e testador acrescentam suas seções da fase; o validador não edita).

Processo por fase: dev → testador → validador → (correções → revalidação, até 2 ciclos) → commit no branch da trilha.

Baseline de qualidade (2026-11-26, antes da trilha): `tsc` tem 10 erros pré-existentes em
`apps/web/src/lib/automation/email/inbound.test.ts` — não contam como regressão.
A suíte Vitest completa tem 15 falhas pré-existentes em 8 arquivos (AppShell, rbac-guards,
modules-smoke, TimesheetWeekView, consultores/actions.documents|experience, ConsultantDirectory,
auto-approval-run) — `next-auth` não resolve `next/server` (ESM); reproduz no checkout principal.
Também não contam como regressão.

| Fase | Status | Veredito |
|---|---|---|
| M1 | concluída (commit no branch) | APROVADO (após 2 ciclos de correção) |
| M2 | pendente | — |
| M3 | pendente | — |

## Fase M1 — dev

Data: 2026-11-26 · Branch `feat/m365` · sem commit (orquestrador commita).

### Arquivos
- **Schema/migrations (aditivas):** `packages/database/prisma/schema.prisma`
  (enum `MICROSOFT_365` em `IntegrationProviderKind`; `M365Connection`,
  `CalendarEvent`, `CalendarEventSighting`, `M365TimeSuggestion`; FK opcional
  `Checkpoint.calendarEventId` + unique `(calendarEventId, consultantId)`).
  `migrations/20261126130000_m365_provider_enum` (só o enum, transação própria) e
  `migrations/20261126130100_m365_conexao_agenda` (tabelas + código de matriz
  `INTEGRACOES_M365`, filho de `ADMIN_ACESSOS`, view ADMIN). Seed, `align-permission-catalog.mjs`
  e `SYSTEM_PERMISSION_CODES` (`M365_ADMIN_CODE`) atualizados.
- **Criptografia:** `packages/database/src/field-encryption.ts`: novos AAD
  `M365Connection.accessToken`, `M365Connection.refreshToken` e `M365OAuth.pkceCookie`.
  O util é o mesmo, nenhum novo foi criado.
- **Lib (`apps/web/src/lib/m365/`):** `config.ts` (flag, credenciais com fallback, tenant,
  redirect, domínios), `scopes.ts`, `oauth.ts` (PKCE S256, state HMAC, token endpoint),
  `connect-flow.ts` (início/callback testáveis), `tokens.ts` (refresh/rotação/REAUTH),
  `graph/{client,errors,types,fake}.ts`, `calendar/{normalize,detection,time-suggestions,prefill,time,sync}.ts`,
  `store.ts` (porta) + `lib/db/m365.ts` (Prisma), `runtime.ts`, `messages.ts`,
  `route-helpers.ts`, `testing/memory-store.ts` (somente testes).
- **Rotas:** `GET /api/integrations/m365/connect`, `GET /api/integrations/m365/callback`,
  `GET|POST /api/jobs/m365-calendar-sync` (CRON_SECRET).
- **UI:** `/app/conta/microsoft-365` (page + actions + `components/m365/M365ConnectionPanel.tsx`);
  `/app/admin/integracoes-m365` (N de M); ícone no Topbar (`AppShell`/`Topbar`/`layout`);
  painel de sugestões na tela de Horas (`screen.tsx` + `components/m365/M365TimeSuggestionsPanel.tsx`
  + `horas/m365-suggestion-actions.ts`); prefill em `/app/horas/lancamento?sugestao=&projeto=`
  (`NewTimeEntryScreen` ganhou `initialPrefill`).
- **Testes:** `lib/m365/{oauth,connect-flow,tokens}.test.ts`, `graph/client.test.ts`,
  `calendar/{sync,rules}.test.ts`, `app/api/jobs/m365-calendar-sync/route.test.ts`.
- `.env.example`: `M365_INTEGRATION_ENABLED`, `M365_CLIENT_ID/SECRET/TENANT_ID`, `AUTH_URL`,
  `M365_STATE_SECRET`, `M365_INTERNAL_DOMAINS`.

### Configuração (Azure / Railway)
- Redirect URI (plataforma "Web") no app do Entra: `${AUTH_URL}/api/integrations/m365/callback`.
- Permissões delegadas do app, só as da M1: `openid profile offline_access User.Read Calendars.Read`.
- `M365_TENANT_ID` tem que ser o **GUID** do tenant, porque o callback compara com o `tid` do token.
- Agendar no Railway `GET /api/jobs/m365-calendar-sync` com `Authorization: Bearer $CRON_SECRET`
  (sugestão: a cada 15 min). Isso é pendência de deploy (ADR17), fora do código. Sem agendador, o
  botão "Sincronizar agora" funciona.

### Decisões
- **Vínculo evento → Checkpoint:** FK opcional `Checkpoint.calendarEventId` (SetNull) com unique
  `(calendarEventId, consultantId)`. A idempotência fica garantida pelo banco (P2002 = já existe).
- **Evento cancelado:** rascunho `DRAFT` sem notas, transcrição ou áudio vira `ARCHIVED`, com update
  condicional e AuditEvent `CHECKPOINT_DRAFT_ARCHIVED_EVENT_CANCELLED`. Rascunho com conteúdo é
  preservado. Cancelamento = `isCancelled` no delta OU `@removed` na agenda do organizador.
- **Privacidade:** `sensitivity` private, confidential **e personal** são descartados. Se um evento
  já visto vira privado, o sighting é marcado como removido. O corpo do convite nunca é lido.
- **Janela:** −30/+60 dias. O cursor só é gravado ao fim da paginação. 410 recomeça a janela (uma vez
  por rodada). A janela também recomeça quando o cursor tem mais de 7 dias, para manter a cobertura.
- **Lease:** `updateMany` condicional (livre, vencido ou do mesmo dono), com TTL de 5 min. O mesmo
  lease vale para o job e para o "Sincronizar agora".
- **Erros:** `reauth` → `REAUTH_REQUIRED`; `config` → `ERROR`; throttled, prazo ou timeout =
  interrupção (sem `lastError`, cursor preservado); demais → `lastError` com código curto.
  IntegrationEvent só leva contadores e códigos, nunca e-mail, assunto ou token.
- **Sugestões de horas:** a regra pura (`planTimeSuggestion`) considera eventos encerrados nos
  últimos 7 dias, de 5 min a 12 h, não recusados. Os contatos são `Client.contactEmail` +
  `billingEmails` de projetos com alocação ACTIVE vigente. EMAIL exato > DOMAIN. Mais de um projeto
  = o consultor escolhe (um botão "Usar em <projeto>" por candidato). Internos = domínio da caixa +
  `M365_INTERNAL_DOMAINS`; a lista de públicos fica em `config.ts`. A sugestão é persistida em
  `M365TimeSuggestion` (PENDING/DISMISSED). "Já lançado" é derivado na leitura (existe TimeEntry no
  dia/projeto), então nada é gravado ao pré-preencher. "Usar" só aparece com a tela cheia
  `HORAS_LANCAMENTOS`.
- **Matriz:** `INTEGRACOES_M365` é filho de `ADMIN_ACESSOS`, módulo Administração. A visão admin
  **não** entrou em `adminNavigation`, porque a flag é server-only e `navigation.ts` também roda no
  cliente. O acesso é pelo botão "Visão administrativa" na tela do usuário (para quem tem view) ou
  pela URL.
- **`id_token`:** é lido sem verificar a assinatura (veio direto do token endpoint, por TLS e com
  client secret). A identidade final é conferida em `/me`.
- **Dependências:** nenhuma nova (fetch puro, `node:crypto`, Zod existente).

### Critérios atendidos (M1)
- Credenciais próprias com fallback e flag off por padrão. Com a flag off, a página e a visão admin
  dão 404, as rotas de integração dão 404, o job responde `skipped`, as actions ficam bloqueadas e
  o Topbar e as sugestões ficam ocultos.
- OAuth com PKCE S256, `state` HMAC (userId + nonce + exp), verifier em cookie httpOnly cifrado com
  path `/api/integrations/m365`. O callback confere state × sessão × cookie, `tid` × tenant e `/me`
  × e-mail do logado, e recusa `common/organizations/consumers`. A UI só recebe códigos.
- `buildAuthorizeUrl` recusa escopo proibido ou fora da fase, inclusive dentro de string com espaços.
- Tokens cifrados; refresh 5 min antes ou após 401; refresh rotacionado sempre persistido;
  `invalid_grant` → `REAUTH_REQUIRED`. Desconectar apaga tokens e cursor.
- Cliente Graph: fetch puro, erros tipados, retry 429/503/504 com Retry-After, teto e prazo, timeout,
  `Prefer: outlook.timezone="UTC"`, links só para graph.microsoft.com. Tudo passa por interface
  injetável, com fake.
- Delta da agenda, CalendarEvent único por iCalUId, Sighting por conexão, `joinUrl` só de host Teams.
- Detecção de checkpoint/1:1 (organizador = gestor em `CHECKPOINT_WRITE_ROLES`, exatamente um
  consultor no escopo via `canTargetConsultant`, regex ou categoria JumpFlow) → DRAFT/PRIVATE
  idempotente, com AuditEvent.
- Sugestões na tela de Horas que só pré-preenchem; ignorar = DISMISSED.
- Validação local: 110 testes M365/afins passando; `tsc` só com os 10 erros pré-existentes de
  `inbound.test.ts`; eslint limpo nos arquivos alterados; `prisma validate` e `db:generate` ok.
- A suíte completa tem 15 falhas **pré-existentes** neste worktree, confirmadas com `git stash` (mesmas
  falhas sem as mudanças). A causa é `next-auth` não resolver `next/server` no node_modules do
  worktree (AppShell, rbac-guards, modules-smoke, TimesheetWeekView, consultores, auto-approval-run).
  Não são regressão.

### Pendências de validação real (Azure)
- Consentimento real no tenant: o app precisa da Redirect URI e das permissões delegadas da M1.
  Conferir se o tenant exige consentimento de admin até para `Calendars.Read`.
- Formato real de `scope` no token response (com ou sem prefixo `https://graph.microsoft.com/`) e se
  traz `openid/profile/offline_access`. A checagem normaliza o prefixo, mas é preciso confirmar
  `hasCalendarScope`.
- Presença de `tid` no `id_token` e `mail` × `userPrincipalName` reais (contas com alias ou UPN
  diferente do e-mail do login).
- `calendarView/delta`: paginação real, `@removed`, comportamento de `isCancelled` para
  organizador × participante, e se occurrences trazem `iCalUId` distinto por ocorrência.
- Código real do 410 (`syncStateNotFound`/`resyncRequired`) e Retry-After em 429.
- Rotação de refresh token e `invalid_grant` após revogação (Entra: revoke sessions).

### Riscos
- `canTargetConsultant` é chamado por consultor candidato (N+1 pequeno, limitado aos participantes
  de eventos organizados pelo gestor na rodada).
- Janela de 50 s por rodada do job, com até 25 conexões. Com muitos usuários, a fila depende da
  frequência do agendador.
- Atendee com e-mail diferente do `Consultant.email`/`User.email` (alias) não é reconhecido como
  consultor, e o rascunho não nasce. É o lado conservador.
- O lease não tem heartbeat: uma rodada que passe de 5 min pode ter o lease retomado por outra
  instância. A rodada tem prazo de 50 s, então o risco é baixo.

## Fase M1 — testes

Data: 2026-11-26 · Branch `feat/m365` · nenhuma alteração em código de produção, sem banco e sem Graph
real (fetch e Prisma mockados, Graph fake e store em memória).

### Testes criados (227 casos novos em 10 arquivos, todos em `apps/web/src/`)
- `lib/m365/connect-flow.security.test.ts` (48): callback com state e cookie de outro usuário, cookie com
  nonce forjado, state assinado com outro segredo, cookie vencido, cookie adulterado ou com AAD de outro
  campo; `access_denied` sem nenhuma chamada; `tid` ausente, só no access token, do tenant `consumers`
  (GUID), maiúsculas; `/me` de outra pessoa, e-mail com prefixo parecido, outro domínio, sem mail/UPN;
  ausência de refresh token; escopo proibido escondido com tab, newline ou prefixo Graph; resultado só
  com o código; URL de autorização sem segredo/verifier; `common/organizations/consumers` via fallback
  do login; lista de escopos proibidos e de fases futuras.
- `lib/m365/tokens.qa.test.ts` (13): limite exato de 5 min, cadeia de rotação RT-OLD → RT-NEW → RT-NEWER
  persistida, 401 → refresh → repetição, `invalid_grant/interaction_required/consent_required/login_required`
  → REAUTH_REQUIRED, 401 persistente sem loop, refresh ilegível, 503 transitório sem REAUTH; tokens
  ausentes de console, IntegrationEvent e `lastError`.
- `lib/m365/calendar/sync.qa.test.ts` (63, 2 `it.fails`): 410 via cliente HTTP real (janela −30/+60
  recalculada), 410 duplo sem loop, cursor parcial não gravado, delta sem links, erro de config → ERROR;
  lease concorrente job × "Sincronizar agora" (uma só chamada ao Graph), lease no limite, release só do
  dono, estados não ACTIVE; detecção (escopo, gestor-consultor, alias, recurso, externo, 2 consultores,
  sinais e tipos, categorias parecidas, 1:1 organizado pelo consultor, agenda do consultor, gestor
  convidado, idempotência após 410); cancelamento (DRAFT vazio × notas/transcrição/áudio/RECORDED,
  consultor apagando o convite não cancela); privacidade (private/confidential/personal, series master,
  evento que vira privado, corpo/anexos/local nunca chegam ao store, logs só com contadores); sugestões
  (e-mail exato > domínio, ambíguos, contato interno/público, domínio interno extra, organizador externo,
  recusado, data em São Paulo, gestor sem vínculo, PENDING atualiza e DISMISSED preservada).
- `lib/m365/calendar/rules.qa.test.ts` (37, 1 `it.fails`): campos permitidos da normalização, caixa de
  sensitivity/seriesMaster, `joinUrl`/`webLink` maliciosos, limites de duração (5/720 min) e da janela de
  7 dias, domínios públicos com e-mail exato, subdomínio, `M365_INTERNAL_DOMAINS`, prefill (meia-noite,
  200 caracteres, projeto fora dos candidatos).
- `lib/db/m365.test.ts` (19, Prisma mockado): `where` do lease, release por dono, DRAFT/PRIVATE + auditoria
  sem assunto, P2002 → exists, arquivamento condicional, upsert sem corpo, DISMISSED preservada, nunca
  toca TimeEntry, escopo do dono em dismiss e leitura, desconectar apaga tokens/cursor/lease, troca de
  conta zera o cursor, IntegrationEvent truncado e falha de log sem payload.
- `app/api/integrations/m365/routes.test.ts` (17): flag desligada (`""`, `false`, `TRUE`, `yes`) → 404 sem
  sessão nem fetch; connect sem sessão → /login; cookie httpOnly com path restrito; tenant multi-locatário
  e produção sem AUTH_URL → not_configured; callback feliz (tokens só cifrados, URL só com `status`,
  cookie limpo), sessão trocada, sem cookie, cookie forjado, conta de outro, `tid` errado,
  `error_description` não refletida.
- `app/app/conta/microsoft-365/actions.test.ts` (10): flag off → todas as actions inertes (nem sessão),
  escopo do próprio usuário, mapeamento do "Sincronizar agora" sem código técnico, validação do id.
- `lib/m365/runtime.test.ts` (5): ordem do gate, job × lease do usuário (busy), prazo esgotado, refresh
  pelo endpoint do tenant.
- `app/api/jobs/m365-calendar-sync/route.qa.test.ts` (11): produção sem CRON_SECRET → 401, cabeçalhos
  inválidos, 401 antes da flag, gate `no_database/forbidden_tenant`, 500 genérico.
- `components/m365/M365TimeSuggestionsPanel.test.tsx` (4): "Usar em <projeto>" por candidato, sem tela
  cheia só "Ignorar", ignorar chama a action.

### Resultado
- Vitest M365: 17 arquivos, **310 passando + 3 `it.fails`** (achados), 0 falhas.
- Suíte completa: **3538 passando, 3 `it.fails`, 1 skipped, 15 falhando em 8 arquivos**. É exatamente o
  baseline pré-existente (`next-auth`/`next/server`), sem regressão.
- `tsc -p tsconfig.test.json`: só os 10 erros pré-existentes de `inbound.test.ts`.
- `eslint` nos arquivos da fase e nos testes novos: 0 erros e 0 warnings nos arquivos M365. O único
  warning é pré-existente, em `ThemeToggle.tsx`.

### Bugs encontrados
- **Bloqueante:** nenhum.
- **Importante:**
  1. O rascunho não acompanha a remarcação do evento (`lib/db/m365.ts:290`,
     `ensureCheckpointDraft` devolve `exists` sem atualizar nada). Cenário: o 1:1 é criado para 27/11 e
     o gestor o move para 03/12. Esperado: `occurredAt` (e título) do rascunho ainda DRAFT = novo início.
     Obtido: continua 27/11. Isso impacta a M2, que procura a ata a partir do início do evento.
     Coberto por `it.fails` em `sync.qa.test.ts`.
- **Menores:**
  2. A regex de assunto não tem fronteira de palavra (`calendar/detection.ts:17`, igual à spec). Cenário:
     "Daily 11:15" com um consultor no escopo. Esperado: sem rascunho. Obtido: rascunho `ONE_ON_ONE`.
     Coberto por `it.fails` em `rules.qa.test.ts`. Sugestão: `(^|\W)1:1(\W|$)`. A decisão é de produto.
  3. A conexão é lida antes do claim do lease (`calendar/sync.ts:253` × `:258`). Se outra rodada
     rotacionar o refresh token nesse intervalo, esta rodada renova com o token antigo, o que pode gerar
     um `invalid_grant` falso e REAUTH_REQUIRED. Esperado: reler a conexão após o claim. Coberto por
     `it.fails` em `sync.qa.test.ts`.
  4. `isDisposableDraft` considera `notes: ""` ou só espaços como vazias, mas o `updateMany` condicional
     exige `notes: null` (`lib/db/m365.ts:338`). Um rascunho com nota vazia nunca é arquivado. É o lado
     conservador, mas a regra pura e o banco divergem.
  5. Em produção sem AUTH_URL, a URL de retorno de erro usa a origem da requisição (Host)
     (`connect/route.ts:33`, `callback/route.ts:33`). O `redirect_uri` OAuth não é afetado.
  6. Observações, sem teste vermelho:
     - escopos concedidos fora da fase são aceitos no callback;
     - `isForbiddenScope` não marca `ChatMessage.*` (`scopes.ts:57`);
     - `CalendarEvent` é compartilhado por `iCalUId`, então `categories` (que é por caixa) e `isCancelled`
       ficam com o valor da última conexão sincronizada (`lib/db/m365.ts:175-177`).

### Cobertura dos critérios M1
| Critério | Cobertura |
|---|---|
| Flag off = tudo inerte (rotas, job, actions, painel) | coberto |
| OAuth PKCE S256 + state HMAC + cookie cifrado/path | coberto |
| Callback: state × cookie × sessão, `tid`, `/me` × logado, issuers multi-locatário | coberto |
| Escopo proibido (inclusive escondido em string) | coberto |
| Tokens cifrados, nunca em log/IntegrationEvent/lastError | coberto |
| Refresh 5 min / 401 / `invalid_grant` → REAUTH / rotação persistida | coberto (risco no achado 3) |
| Cliente Graph (429/503/Retry-After, timeout, host) | coberto (dev + QA) |
| Delta, cursor, 410 → recomeço da janela | coberto |
| Lease no banco, job × "Sincronizar agora" | coberto (memória + `where` do Prisma) |
| Detecção de checkpoint (organizador, 1 consultor no escopo, regex/categoria, tipo) | coberto (achado 2) |
| Idempotência evento+consultor; cancelado → ARCHIVED só DRAFT vazio | coberto (achados 1 e 4) |
| Private/confidential/personal/series master descartados; corpo nunca persistido | coberto |
| Sugestões de horas (público/interno, e-mail > domínio, ambíguo, nunca TimeEntry) | coberto |
| Job exige CRON_SECRET | coberto |
| Visão admin N de M / tela de conta (render) | não coberto por teste de página (páginas importam `next-auth`, que esbarra no problema do baseline); gate por flag e `requirePermission` verificados por leitura |

## Fase M1 — correções

Data: 2026-11-26. São os achados de "## Fase M1 — testes"; os 3 `it.fails` viraram `it` e passam.

1. **Remarcação (importante):** `ensureCheckpointDraft` atualiza um rascunho existente por meio da
   regra pura `draftRescheduleChange` (`calendar/detection.ts`):
   - só enquanto o checkpoint é DRAFT;
   - `occurredAt` acompanha **sempre** o início do evento;
   - `title` acompanha o assunto **só enquanto o rascunho não tem conteúdo** (notas, transcrição
     ou áudio). Com conteúdo, o título é do gestor.

   O update é condicional (`status: DRAFT`) e gera AuditEvent `CHECKPOINT_DRAFT_SYNCED_FROM_CALENDAR`,
   só com datas e o flag `titleUpdated`, sem título.
2. **Regex com fronteiras:** 1:1 = `(?<![\d:])1:1(?![\d:])|\b1-on-1\b|\bone on one\b|\b1on1\b`;
   checkpoint = essa regra ou `\bcheckpoint\b|\bcheck-in\b`. "Daily 11:15", "1:10" e "Checkpoints"
   não casam. A spec §3/M1 foi atualizada com a regra exata.
3. **Lease:** a conexão é relida **depois** do claim; tokens e cursor usados são os atuais. Se a
   conexão some ou sai de ACTIVE entre a leitura e o claim, o lease é liberado.
4. **Arquivamento:** o `updateMany` usa concorrência otimista com os valores exatos avaliados pela
   regra pura (`notes`/`transcription` como lidos, `audioStorageKey: null`). Notas vazias ou só com
   espaços contam como sem conteúdo nos dois lados.
5. **Redirect de erro:** connect e callback usam a mesma base do `redirect_uri` (AUTH_URL; fora de
   produção, a origem). Em produção sem base, a resposta falha fechado com `303` e `Location`
   **relativo** (`/app/conta/microsoft-365?erro=not_configured`), sem ecoar o Host recebido.
6. **Escopos:**
   - o callback já recusava (`forbidden_scope`) qualquer escopo proibido concedido, antes de gravar
     tokens;
   - escopos além da M1 que são permitidos são gravados, e a contagem vai para o IntegrationEvent
     (`extraScopes`);
   - `isForbiddenScope` agora pega qualquer `Chat*` (ChatMessage.*, ChatMember.*).
7. **Visão por caixa:**
   - `categories` e `isCancelled` saíram do `CalendarEvent` (só `isCancelled` agregado ficou) e foram
     para o `CalendarEventSighting`. A detecção usa a categoria da caixa do gestor organizador.
   - O `CalendarEvent.isCancelled` só é definido ou revertido pela **visão do organizador**
     (`isCancelled`, ou `@removed` na agenda dele).
   - Fora disso, o evento só é cancelado quando nenhum sighting ativo resta (não removido e não
     cancelado na própria caixa).
   - As sugestões ignoram sightings cancelados na caixa do consultor.
   - A migration `20261126130100_m365_conexao_agenda`, ainda não aplicada, foi regenerada pelo
     `migrate diff` e continua aditiva.

**Testes:** novos casos em `calendar/rules.test.ts` (fronteiras da regex e regra de remarcação) e
`calendar/sync.test.ts` (remarcação, cancelamento por visão, órfão sem organizador e categoria por
caixa). Três testes do testador foram ajustados ao comportamento corrigido:
- `connect-flow.security.test.ts`: ChatMessage agora é proibido;
- `routes.test.ts`: Location relativo;
- `db/m365.test.ts`: categories no sighting, visão de participante e notas com espaços.

**Validação:**
- M365: 30 arquivos e 437 testes passando, incluindo auth e a fronteira cliente/servidor.
- Suíte completa: 3557 passando; as 15 falhas são as mesmas do baseline (`next-auth`/`next/server`
  no worktree).
- `tsc` só com os 10 erros pré-existentes; eslint limpo; `prisma validate` e `db:generate` ok.

## Fase M1 — correções 2

Data: 2026-11-26. Ressalvas do validador.

1. **Escopos no refresh:**
   - O refresh pede **sempre** `M1_SCOPES` (com `offline_access`), nunca os escopos gravados.
   - `scopes` guarda só o que foi concedido **dentro da fase** (`phaseGrantedScopes`, aplicado em
     `encryptTokenSet`, que vale tanto para o callback quanto para o refresh).
   - Extras permitidos são apenas contados no IntegrationEvent (`extraScopes`, via
     `countExtraScopes` sobre o retorno bruto do token endpoint).
2. **Corrida desconectar/pausar × sync:**
   - `saveTokens`, `setStatus`, `saveCalendarCursor` e `recordSyncOutcome` viraram `updateMany`
     condicionados (`guardedWhere`). Com lease, exigem `{ id, syncLeaseOwner: owner, status: ACTIVE }`;
     sem lease, exigem `status notIn [DISCONNECTED, PAUSED]`.
   - `count === 0` faz a rodada encerrar com `ConnectionChangedError` e resultado
     `skipped/connection_changed`, sem gravar mais nada na conexão. O token provider recebe o
     `leaseOwner` da rodada.
   - Desconectar limpa o lease e pausar muda o status, então nenhuma rodada em curso ressuscita
     tokens nem desfaz a ação. Isso também resolve "Pausar não para a rodada em curso".
3. **Redirect para `/login`** em connect e callback: usa a mesma base do `redirect_uri`
   (`resolveAppBaseUrl`). Sem base, `Location` relativo (`redirectToPath`), nunca o Host da
   requisição.
4. **Evento que vira private/confidential/personal na visão do ORGANIZADOR** (`redactCalendarEvent`):
   - sem Checkpoint vinculado, o evento é apagado, com sightings e sugestões em cascata;
   - com Checkpoint, ficam nulos `subject`, `attendees`, `organizerName`, `joinUrl` e
     `onlineMeetingId`, e são limpos `categories` e `webLink` dos sightings. O rascunho do gestor
     continua.
   - Na visão de um participante, só o sighting dele é removido.
5. **Texto de consentimento:** "Guardar reuniões marcadas como particulares".

**Testes novos:**
- `sync.test.ts`: disconnect e pause no meio da rodada (tokens nulos, DISCONNECTED/PAUSED mantidos,
  sem cursor nem `lastSyncAt`); privado do organizador com e sem vínculo; privado visto por
  participante.
- `tokens.test.ts`: escopos da fase no refresh e disconnect durante o refresh.
- `db/m365.test.ts`: `guardedWhere` e `redactCalendarEvent`.

**Testes do testador ajustados ao novo comportamento:**
- `tokens.qa`: o refresh pede o escopo da fase;
- `sync.qa`: evento que vira privado na visão do organizador é apagado;
- `rules.test`: o skip privado traz `organizerEmail`.

**Validação:**
- vitest M365 e afins: 30 arquivos, 445 testes passando.
- `tsc` só com os 10 erros pré-existentes; eslint limpo; `prisma validate` ok. Não houve mudança de
  schema nesta rodada.

## Fase M1 — veredito do validador

1º ciclo: APROVADO COM RESSALVAS (3 importantes: escopo no refresh, corrida desconectar×sync, Host no redirect /login).
Revalidação após "correções 2": **APROVADO**. Menores remanescentes, a tratar no início da M2:
1. Escritas de evento/rascunho/sugestão sem guarda de lease — checar lease antes da fase de efeitos.
2. Participante pode reescrever dados de evento redigido pelo organizador (confirmar propagação de sensibilidade no Azure real; idealmente só a visão do organizador atualiza assunto/participantes após redação).
3. Evento privado visto pela primeira vez pelo organizador não redige registro criado por participante.

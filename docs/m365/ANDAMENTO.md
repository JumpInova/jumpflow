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
| M2 | concluída (commit no branch) | APROVADO COM RESSALVAS (após REPROVADO por ReDoS e 2 ciclos de correção) |
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

## Fase M2 — dev

Data: 2026-11-26 · Branch `feat/m365` (sobre `b7bff42`) · sem commit (orquestrador commita).

### Menores remanescentes da M1 (tratados primeiro)
1. **Lease antes dos efeitos:** novo `renewSyncLease` (heartbeat condicional: dono + ACTIVE). O sync o chama
   antes de gravar cada página do delta, antes de arquivar/rascunhos e antes das sugestões. Lease perdido =
   `ConnectionChangedError` → `skipped/connection_changed`, nada mais gravado. Também reduz o risco de
   "lease sem heartbeat" listado na M1.
2. **Evento redigido:** coluna nova `CalendarEvent.redactedAt`. Com ela preenchida, a visão de um
   participante não reescreve nada do evento (só o próprio sighting); só a visão do organizador volta a
   gravar e limpa `redactedAt`.
3. **Privado na 1ª visão do organizador:** o skip `private` agora traz `iCalUId`; sem sighting do
   organizador, o evento é localizado por `iCalUId` (`findCalendarEventIdByICalUId`) e redigido (apagado se
   não houver Checkpoint).

### Arquivos
- **Schema/migrations (aditivas):** `schema.prisma` — `NotificationEvent` + `CHECKPOINT_MINUTES_READY`
  e `CHECKPOINT_MINUTES_CHOICE`; `CalendarEvent.redactedAt`; `CheckpointEmailMinutes` (1:1 com Checkpoint,
  `internetMessageId` **único**, webLink, recebido em, contadores, status
  `SEARCHING|AMBIGUOUS|DONE|FAILED`); `CheckpointActionItem` (`PENDING|ACCEPTED|DONE|DISMISSED`,
  `sourceQuote`, decidedBy SetNull). `migrations/20261126140000_m365_atas_enum` (só enum, transação própria)
  e `20261126140100_m365_atas_email` (gerada por `migrate diff`).
- **Lib M2 (`apps/web/src/lib/m365/minutes/`):** `select.ts` (regra pura de candidata), `body.ts`
  (corpo → texto sem citação/assinatura), `pii.ts` (máscara), `docx.ts`, `pdf.ts`, `attachments.ts`,
  `generate.ts` (prompt, Zod, ata formatada, cards, corte 70/30), `store.ts` (porta), `run.ts`
  (orquestração com Graph/IA/extração injetáveis); `testing/memory-minutes-store.ts`.
- **Graph:** `graph/client.ts` (`findMessages`, `getMessage`, `getMessageBody`, `listAttachments`,
  `getAttachment`), `graph/types.ts`, `graph/fake.ts` (caixa em memória + `calls.mail`).
- **Consentimento:** `scopes.ts` (`M2_SCOPES`, `consentedPhase`, `hasMailScope`), `oauth.ts`/`connect-flow.ts`
  (fase no cookie cifrado), `tokens.ts` (refresh pela fase consentida), rotas connect (`?fase=M2`) e
  callback, `messages.ts`, `route-helpers.ts`.
- **Persistência:** `lib/db/m365-minutes.ts` (Prisma da porta + leitura para a tela), `lib/db/m365.ts`
  (M1: lease/redação).
- **Extração:** `lib/checkpoint/run-extraction.ts` — núcleo da F4 extraído da action (mesmo comportamento);
  `extractCheckpointInsights` agora o chama.
- **Job/rotas/actions:** `GET|POST /api/jobs/m365-meeting-minutes` (CRON_SECRET), `runtime.ts`
  (`runMeetingMinutesJob`, busca/lista/escolha manuais), `app/app/checkpoints/m365-actions.ts`.
- **UI:** `components/checkpoints/CheckpointM365Panel.tsx` (estado da ata, "Buscar ata no e-mail", escolha
  no empate, cards de Ação), ligado em `CheckpointCard`/`CheckpointsView`/`checkpoints/page.tsx`;
  `lib/checkpoint/action-items.ts` (tipos/rótulos/transições puros); seção "Atas por e-mail" com
  "Ativar atas por e-mail" e consentimento em `M365ConnectionPanel.tsx` + `conta/microsoft-365/page.tsx`.
- **Notificações:** os 2 eventos novos entram no `template-registry` como "Sem e-mail" (só sino, grupo
  "Pessoas"); envio via `createInAppNotifications`.
- **Testes novos:** `minutes/{run,rules,attachments}.test.ts`, `m2-consent.test.ts`,
  `calendar/sync.m1-leftovers.test.ts`, `db/m365-minutes.test.ts`, `checkpoints/m365-actions.test.ts`,
  `CheckpointM365Panel.test.tsx`, `integrations/m365/routes.m2.test.ts`, `jobs/m365-meeting-minutes/route.test.ts`.
  Ajustados ao novo comportamento: `tokens.test.ts` (conexão M1 sem Mail.Read), `rules.test.ts` (skip traz
  iCalUId), `db/m365.test.ts` (mock `findUnique`), `sync.qa.test.ts` (stubs com os métodos de e-mail).
- `.env.example`: nenhuma env nova; documentados `Mail.Read` no app do Entra e o agendamento do job.

### Decisões
- **Consentimento incremental:** "Ativar atas por e-mail" → `/connect?fase=M2` (só `CHECKPOINT_WRITE_ROLES`;
  consultor recebe `mail_not_allowed` sem ir à Microsoft). A fase vai no cookie cifrado; o callback troca o
  code com os escopos da fase e grava só o concedido dentro dela. `Mail.Read` negado → a agenda conecta e a
  tela avisa `mail_scope_missing`. Reconectar mantém a fase (link com `?fase=M2` se já tinha `Mail.Read`).
- **Refresh:** pede `PHASE_SCOPES[consentedPhase(scopes gravados)]` — M1, ou M1+`Mail.Read` — nunca além.
  `consent_required`/`invalid_scope` na M2 recua **uma vez** para M1 (agenda continua; `scopes` sem e-mail).
- **Ingestão estreita:** só `findMessages` por categoria (`$filter categories/any + receivedDateTime`) e
  por assunto (`$search "subject:…"`, $search não combina com $filter; janela/participantes reaplicados na
  regra pura), `$top=25`, `$select` sem corpo. Corpo/anexos só da mensagem escolhida.
- **Seleção (pura, `select.ts`):** categoria `JumpFlow` (desde o início do evento) **e** consultor em
  from/to/cc ou assunto; ou assunto do evento (sem RE:/ENC:/FW:, palavras inteiras) na janela início→+7 d
  **e** consultor ou gestor em from/to/cc. Pontos: categoria 4, assunto 2, consultor 1; empate no topo =
  AMBIGUOUS. **Categoria sozinha não basta** (senão a ata do 1:1 de um consultor alimentaria o de outro do
  mesmo gestor). Descarta convites/respostas (`eventMessage*`, "Aceito:/Accepted:…"), rascunhos, ids já
  usados e duplicatas por `internetMessageId` (cópia em Enviados).
- **Empate:** só o estado AMBIGUOUS é gravado; a tela busca as candidatas **ao vivo** (action do gestor) e
  nada delas é persistido. A escolha é revalidada pela mesma regra (id arbitrário → `not_candidate`).
- **Só a conta do gestor:** o job agrupa por `managerUserId` e usa apenas a conexão desse usuário (ACTIVE,
  com `Mail.Read`, papel de quem registra, e que não seja o próprio consultor). Busca/escolha manuais só
  para o gestor do checkpoint — nem ADMIN/PEOPLE disparam a leitura da caixa de outra pessoa.
- **Concorrência:** o job e o manual usam o **mesmo lease da conexão** do gestor (claim + heartbeat por
  checkpoint); `saveMinutes` é uma transação com `internetMessageId` único (P2002 = `duplicate`) e update
  condicional do rascunho (DRAFT + notas/transcrição como lidas; edição concorrente do gestor = nada
  sobrescrito). Checkpoint reconsultado no máximo a cada 30 min (`MINUTES_RECHECK_MS`).
- **IA:** texto-fonte cortado (60 k, 70/30) → mascarado (`maskPii`) → `getAiTextProvider().complete`
  (`json: true`) → Zod. A ata guardada **continua mascarada** (nada é desmascarado). Falha/`null`/schema
  inválido degrada: grava o texto-fonte mascarado + nota de origem ("sem resumo da IA"), RECORDED, sem cards
  e sem extração. Com resumo, dispara `runCheckpointExtraction` (respeita `NEXT_PUBLIC_CHECKPOINT_AI`).
- **Anexos:** PDF/DOCX, arquivo não inline, ≤10 MB, até 3. DOCX via `jszip` (já instalado). PDF por leitor
  mínimo próprio com `node:zlib` (FlateDecode, ToUnicode/bfchar/bfrange, Type0/Identity-H, object streams,
  Resources herdados); escaneado → não suportado (contado). **Nenhuma dependência nova.**
- **Cards de Ação:** visíveis só a quem vê o cru (mesmo gate dos insights; consultor nunca, nem em SHARED).
  Decisão: CHECKPOINT.edit + checkpoint no escopo + `canManageCheckpoint`; fora disso NOT_FOUND. Transições
  PENDING→ACCEPTED|DONE|DISMISSED, ACCEPTED→DONE|DISMISSED, update condicional + AuditEvent só com status.
- **Notificação:** in-app ao gestor ("ata pronta" e, uma vez, "escolha o e-mail"), sem nome/e-mail.
- **Logs:** IntegrationEvent `minutes.mail`/`minutes.select`/`minutes.ingest` só com contadores e códigos;
  AuditEvent `CHECKPOINT_MINUTES_FROM_EMAIL` só com contagens/tamanhos.

### Critérios atendidos (M2)
- Consentimento incremental de `Mail.Read`; refresh pela fase consentida; proibidos recusados (inclusive
  escondidos em string) — `m2-consent.test.ts`, `routes.m2.test.ts`.
- Busca estreita só na caixa do gestor; seleção, empate, janela, ids usados — `rules.test.ts`, `run.test.ts`.
- Corpo sem citação/assinatura; anexos PDF/DOCX ≤10 MB; escaneado não suportado — `rules/attachments.test.ts`.
- Máscara antes da IA (prompt e system sem o dado) e saída validada por Zod — `run.test.ts`.
- `notes` = ata, `transcription` = fonte mascarada, RECORDED, metadados de origem; e-mail bruto não guardado.
- Idempotência por `internetMessageId` (seleção + guard do banco) — `run.test.ts`, `db/m365-minutes.test.ts`.
- Extração existente disparada; cards de Ação PENDING validados pelo gestor; PRIVATE respeitado —
  `m365-actions.test.ts`, `CheckpointM365Panel.test.tsx`.
- Aviso in-app; job com CRON_SECRET e lease no banco; botão manual — `route.test.ts`, `run.test.ts`.
- Flag off: rotas 404, job `skipped`, actions FORBIDDEN, painel e seção de conta não carregam.
- Validação: 33 arquivos/549 testes M365+Checkpoint passando; suíte completa = baseline (8 arquivos, 15
  falhas `next-auth`/`next/server`); `tsc` só com os 10 erros de `inbound.test.ts`; eslint limpo;
  `prisma validate` e `db:generate` ok.

### Pendências de validação real (Azure)
- Permissão delegada `Mail.Read` no app do Entra e consentimento incremental real (se o tenant exige admin).
- `$filter=categories/any(c:c eq 'JumpFlow') and receivedDateTime ge …` em `/me/messages` (pode exigir
  ajuste por "InefficientFilter"); `$search="subject:…"` (tokenização do Exchange, aspas, acentos, ordem e
  limite de resultados).
- Presença de `@odata.type` (`eventMessage*`) na coleção e de `isDraft`; `uniqueBody` com
  `Prefer: outlook.body-content-type="text"`; `webLink` real de mensagem (host aceito por `sanitizeOutlookLink`).
- `contentBytes` de anexos grandes (tempo de download perto de 10 MB) e PDFs reais (Word/Google Docs/
  "Imprimir para PDF") com o leitor mínimo.
- Erro real do refresh após retirar só `Mail.Read` (código esperado `consent_required`/`invalid_scope`).
- Escopo devolvido pelo token endpoint com `Mail.Read` (prefixo/ordem).

### Riscos
- Leitor de PDF próprio: cobre o comum, mas fontes sem ToUnicode com encodings custom, LZW/ASCII85 e
  streams criptografados ficam sem texto (contados como não suportados). Alternativa, se faltar cobertura
  real: avaliar `unpdf`/`pdfjs-dist` (dependência nova, decidir com o orquestrador).
- `$search` pode trazer mensagens fora da janela e cortar em 25; uma ata antiga muito "parecida" pode
  ocupar o lugar. Mitigação: janela/participantes reaplicados localmente e reconsulta a cada 30 min por 7 dias.
- Ata e cards ficam com marcadores (`[EMAIL_1]`…) — decisão de privacidade; o gestor ajusta à mão.
- A ata nasce do e-mail mais bem pontuado: o assunto genérico do evento (ex.: "1:1") casa com e-mails de
  outros 1:1 do mesmo gestor; o filtro por consultor/gestor em from/to/cc e o empate mitigam.
- `NEXT_PUBLIC_CHECKPOINT_AI` desligada: a ata é gerada, mas Oportunidades/Cases/Skills não (comportamento
  da F4).

## Fase M2 — testes

Data: 2026-11-26 · Branch `feat/m365` (sobre `b7bff42`, M2 não commitada) · sem commit. Nenhum código de produção
alterado; sem banco, sem Graph real, sem IA real (Graph fake/fetch mockado, provider mockado).

### Testes criados (97 casos, 6 arquivos)
- `lib/m365/minutes/run.qa.test.ts` (36) — só a caixa do gestor (PEOPLE/ADMIN/consultor → `forbidden` sem lease nem
  chamada a nenhuma caixa; conexão de outro usuário devolvida pelo store é recusada; PAUSED/REAUTH/ERROR não lidos;
  checkpoint sem gestor); seleção (dois 1:1 do mesmo gestor nunca cruzam; categoria sozinha não casa; empate sem ler
  corpo/anexo e sem persistir nada das candidatas; AMBIGUOUS não reprocessado); escolha manual revalidada (ata de outro
  consultor, id usado → `duplicate`, convite/resposta/rascunho/fora da janela/id adulterado → `not_candidate`, checkpoint
  já com ata → `not_eligible`); idempotência (e-mail para 2 consultores, internetMessageId com caixa diferente, rerun após
  DONE); corrida (edição/arquivamento durante a IA: nada gravado, sem aviso/extração); máscara antes da IA com HTML+DOCX+PDF
  (prompt, system, notas, transcrição); IA JSON inválido/vazio/schema ruim → `saved_without_ai` sem cards; provider que
  lança; extração que lança; e-mail bruto não persistido (só `internetMessageId/webLink/receivedAt`); webLink hostil →
  null; 8 anexos → 3 baixados; PDF malformado não derruba; tamanho mentiroso.
- `lib/m365/minutes/hostile-input.qa.test.ts` (16) — PDF lixo/truncado/sem endstream, Flate corrompido, ciclos em
  Kids/Parent, ObjStm autorreferente, ID sem EI, cifrado, zip bomb num stream (corte de 40 MB); DOCX bomb com tamanho
  honesto e FORJADO (jszip aborta), docx sem document.xml/entidades estranhas; limites (10 MB exato, 0 byte, inline,
  item/reference, tipos não suportados, máx. 3).
- `lib/m365/m2-consent.qa.test.ts` (17) — refresh pede exatamente M1 ou M2 (resíduo de M3 ignorado; extras/proibidos fora
  de `scopes`); escopo com prefixo/caixa gravado canônico (`has: "Mail.Read"` do job); `invalid_grant` → REAUTH sem
  recuo; recuo só uma vez (sem laço); após recuo o próximo refresh pede só M1; tokens nunca em console/logs/campos em
  claro; pedido M2 sem escopo futuro; Mail.ReadWrite/Chat.*/`.All` → `forbidden_scope`; cookie de fase não forjável.
- `lib/m365/graph/client-mail.qa.test.ts` (9) — `/me/messages` com `$select` sem corpo, `$top 25`, `$filter` com aspa
  escapada, `$search` KQL neutralizado, corte em 25, 429/Retry-After em busca e anexo, `Prefer` de corpo texto + corte
  512 KB, base64 de anexo, ids com `/ ? # %` não saem de `/me/messages/{id}`.
- `app/app/checkpoints/m365-actions.qa.test.ts` (11) — matriz completa de transições dos cards; estados finais não
  voltam; consultor em SHARED → NOT_FOUND; inexistente = fora de escopo (anti-enumeração); auditoria só com status;
  actor do cliente ignorado; messageId > 512 → INVALID_INPUT; flag off inerte.
- `app/api/jobs/m365-meeting-minutes/route.qa.test.ts` (8) — produção sem CRON_SECRET → 401; segredo na query/esquema
  errado → 401; flag `false/0/off/no` inerte; flag on sem banco/credenciais → skipped.
- Achados ficam como `it.fails` (passam enquanto o bug existir; viram falha quando corrigidos → trocar por `it`).

### Resultado
- Vitest (suíte inteira): **3754 passed | 15 failed | 9 expected fail | 1 skipped** (317 arquivos; 8 falhando). As 15
  falhas/8 arquivos são exatamente o baseline `next-auth`→`next/server`; nenhuma nova.
- `tsc -p tsconfig.test.json --noEmit`: só os 10 erros pré-existentes de `inbound.test.ts`.
- `eslint` nos 6 arquivos novos: limpo.

### Bugs encontrados
**Bloqueante**
1. **Leitor de PDF — DoS de CPU síncrona (trava o event loop do processo web)**, com anexo pequeno de um e-mail que
   qualquer remetente pode mandar ao gestor com o assunto do evento (gestor em `to` basta para a regra de assunto):
   - `pdf.ts:42` `/(\d+)\s+(\d+)\s+obj\b/g` (e `refsIn`, `pdf.ts:139`) é quadrático em sequência de dígitos: 40 k
     dígitos ≈ 0,6 s, 100 k ≈ 3,8 s; 10 MB ≈ horas. Esperado < 1 s.
   - `parseToUnicode` (`pdf.ts:224`): teto só por faixa (65 536), não global; 1000 `bfrange` (~20 KB) ≈ 2,6 s, e
     é reprocessado por página (`fontDecoders` por página). Esperado < 1 s.
   - Sem teto AGREGADO de descompressão nem cache por objeto (`decodeStream`, `pdf.ts:79`): o mesmo stream de ~39 MB
     (40 KB comprimidos) referenciado por N páginas é inflado N vezes (até 5000 páginas); 20 páginas ≈ 9,4 s.
   Sugestão: teto global de bytes inflados e de iterações do CMap por documento, cache por objeto, regex sem
   backtracking (âncora em `\b`/limite de dígitos `\d{1,10}`) e prazo de CPU por anexo.
   Testes: `hostile-input.qa.test.ts` (3 `it.fails`).

**Importante**
2. **Recuo de `consent_required` não acontece com o Entra real** — `oauth.ts:261` usa só `json.error`; o Entra devolve
   consentimento retirado como `{"error":"invalid_grant","suberror":"consent_required"}` (AADSTS65001). Resultado:
   REAUTH_REQUIRED da conexão inteira (agenda para) em vez de recuar para M1. Esperado: considerar `suberror`.
   Teste: `m2-consent.qa.test.ts` (`it.fails`).
3. **Ata encaminhada perde o conteúdo** — `body.ts:121` (`cleanEmailBody`) corta tudo a partir de
   "De:/Enviado:"/"Forwarded message"; a regra de assunto aceita ENC:/FW:, mas o conteúdo encaminhado (a ata) some e só
   "Segue a ata." vai para a IA/transcrição (grava RECORDED com ata vazia). Teste: `run.qa.test.ts` (`it.fails`).

**Menor**
4. Corte 70/30 antes da máscara (`run.ts:252-254`): dado pessoal que cruza o corte vaza fragmento ("joao.pereir") para
   a IA e para `transcription`. Mascarar antes de cortar (ou cortar em fronteira de espaço). `run.qa.test.ts`.
5. `pii.ts:34` — CPF com espaços (`123 456 789 09`) ou só pontos (`123.456.789.09`) não é mascarado. `run.qa.test.ts`.
6. Anexo que dá 404 entre listar e baixar (`run.ts:241`) derruba a ata inteira (manual → `unavailable`; job →
   `failed` + retry), embora o corpo tenha a ata. Esperado: pular o anexo e contar como não suportado. `run.qa.test.ts`.
7. `client.ts` (`getMessage`/`getMessageBody`/anexos): `encodeURIComponent` não escapa `.`; messageId `..` vira segmento
   de ponto e a URL normaliza para `/me/` (fica no `/me` do próprio gestor e cai em `not_candidate`). Validar o charset
   do id na action/cliente. `client-mail.qa.test.ts`.
8. (observação, sem teste falhando) `empty_source` grava FAILED terminal: o job não volta a procurar (`listDueCheckpoints`
   só pega null/SEARCHING), mesmo que uma ata válida chegue depois; só a busca manual recupera.

### Cobertura dos critérios (M2)
| Critério | Cobertura |
|---|---|
| Só a caixa do gestor; consultor nunca; ADMIN/PEOPLE não disparam | ok — run.test + run.qa (job, manual, lista, escolha, store adulterado) |
| Categoria sozinha não casa; empate → AMBIGUOUS sem persistir | ok — rules.test + run.qa |
| Escolha manual revalidada (id adulterado/de outro checkpoint) | ok — run.qa |
| Idempotência por internetMessageId; corrida com edição | ok — run.test, db/m365-minutes.test, run.qa |
| Máscara antes da IA; IA null/JSON inválido sem cards | ok, com achados 4 e 5 |
| E-mail bruto nunca persistido; só metadados | ok — run.qa |
| Anexos: limites, tipos, PDF malformado; leitor contra entrada hostil | parcial — limites/malformado ok; **DoS (achado 1)**; anexo 404 (achado 6) |
| Cards de Ação: PRIVATE, transições, auditoria | ok — m365-actions(.qa).test, CheckpointM365Panel.test |
| Refresh pela fase consentida; recuo de consent_required | ok no fake; **formato real do Entra falha (achado 2)** |
| Job com CRON_SECRET; flag desligada inerte | ok — route(.qa).test, m365-actions.test |
| Corpo sem citação/assinatura | ok, exceto encaminhamento (achado 3) |

## Fase M2 — correções

Data: 2026-11-26. São os achados de "## Fase M2 — testes" e a decisão do orquestrador sobre o desmascaramento.
Os 9 `it.fails` viraram `it` e passam. Não houve mudança de schema.

**Bloqueante**
1. **Leitor de PDF reescrito** (`minutes/pdf.ts`), sem dependência nova.
   - Parsing linear: os cabeçalhos `N G obj` são achados com `indexOf("obj")` e conferidos para trás (≤10 dígitos
     e ≤32 espaços).
   - Os objetos, dicionários e referências passam por um tokenizador e parser próprios. A referência `n g R` é
     lida com lookahead de dois tokens. Nenhuma regex com backtracking roda sobre a entrada.
   - O CMap é processado com `indexOf` e tokens hex/array.
   - Dentro do content stream, `<<`, `(` e `<` sem fechamento consomem até o fim, sem reescanear.
   - Tetos **globais** por documento:
     - 64 MB inflados no total e 40 MB por stream;
     - 20 000 objetos e 500 páginas;
     - 200 000 entradas de CMap e 65 536 por faixa;
     - 32 MB de content stream interpretado;
     - 200 000 caracteres de texto;
     - profundidade 32 e 100 000 itens por parse.
   - Cache por objeto: stream decodificado, decodificador de fonte (o ToUnicode é lido uma vez por fonte, não por
     página) e texto do content stream.
   - `PdfBudget`: orçamento de **2 s de parede** por anexo, checado entre as operações. Ao estourar, o anexo vira
     `unsupported/time_budget` (contado como não suportado) e a ata segue com o corpo.
   - Testes hostis medidos (cada um < 1 s): sequência de dígitos = 0 ms; 1000 bfrange = 12 ms; o mesmo stream de
     39 MB em 6 páginas custa o mesmo que em 1 (cache). Casos novos: muitos `obj`, dígitos antes de `obj`, `<<`
     aninhados abertos, referências gigantes, strings/hex sem fechamento, content stream hostil e o relógio
     estourado.

**Importantes**
2. **`invalid_grant` + `suberror: consent_required`** (também `error_codes:[65001]` ou `AADSTS65001` na
   descrição) agora vira o código `consent_required` (`oauth.ts`, `tokenErrorCode`). O efeito é recuar uma vez
   para M1, e a agenda continua. Um `invalid_grant` puro continua indo para REAUTH. A descrição só é inspecionada,
   nunca logada.
3. **Ata encaminhada e texto curto.**
   - `cleanEmailBody(text, { keepQuoted })` preserva o primeiro bloco citado ou encaminhado. Saem os separadores,
     "Em … escreveu:", os campos De/Enviado/Para/Cc/Assunto e o prefixo `>`. O bloco vai até o próximo
     cabeçalho, então o histórico mais antigo é descartado.
   - `messageBodyToText` liga essa preservação quando o assunto é ENC/FW/Fwd/TR/RV/WG, ou quando o texto próprio
     somado aos anexos fica abaixo de `MIN_SOURCE_CHARS` (24 caracteres sem espaço). Nesses casos usa o maior
     entre `uniqueBody` e `body`.
   - Se o texto-fonte final continuar abaixo do mínimo, o checkpoint **não** vira RECORDED: fica FAILED
     `source_too_short` (ou `empty_source`), que é recuperável.

**Decisão: desmascaramento**
4. O texto-fonte é mascarado com um mapa em memória. A IA só vê texto mascarado.
   - A saída validada é desmascarada com `unmaskDeep` e o mapa da mesma execução. Por isso `notes` e os cards de
     Ação (título, responsável, prazo e `sourceQuote`) são gravados com os dados reais.
   - `transcription` continua **mascarado**. O mapa nunca é persistido.
   - A extração (`runCheckpointExtraction`) recebe a ata e a fonte **mascaradas** junto com o mapa
     (`MaskedExtractionInput`), e desmascara Oportunidades, Cases e Skills (título, descrição, trechos) antes de
     gravar.
   - Sem `masked` (por exemplo, "Reprocessar" manual), a própria extração mascara notas e transcrição com um mapa
     de prefixo próprio (`[EMAIL_X1]`) e desmascara a saída. Isso fecha também o envio de PII cru da extração
     manual, que já existia antes da M2.
   - **Continua mascarado:** `transcription`. Também continuam como estão os marcadores que vierem de outra
     execução, como um `[EMAIL_1]` antigo dentro da transcrição, porque o mapa daquela execução não existe mais.

**Menores**
5. O corte 70/30 agora acontece **depois** da máscara. Assim um dado pessoal nunca é partido ao meio.
6. O CPF passa a ser mascarado também com espaços, só pontos ou hífen (`123 456 789 09`, `123.456.789.09`).
   Continuam sem máscara, por teste: números longos, protocolos, valores, datas e versões.
7. Erro de anexo (404 ou http na listagem ou no download) não derruba a ata: o anexo é ignorado e contado como não
   suportado. Erros de conexão (reauth, config, throttling, prazo) continuam subindo.
8. O id de mensagem passa por uma allowlist `[A-Za-z0-9_\-=+/]` com pelo menos um alfanumérico, tanto na action
   (Zod) quanto no `chooseMinutesMessage` (que recusa sem chamar o Graph). No cliente, `pathSegment` neutraliza
   `.` e `..` (`%252E`), e o id nunca sai de `/me/messages/{id}`.
9. FAILED (`empty_source` ou `source_too_short`) deixa de ser terminal: `listDueCheckpoints` reconsulta
   SEARCHING **e** FAILED a cada 30 min até o fim da janela de 7 dias.

**Testes**
- Novos: `minutes/corrections.test.ts` (20 casos) e `checkpoint/run-extraction.test.ts` (2 casos).
- Ajustados ao comportamento novo:
  - `run.test.ts`: a ata desmascarada e a extração recebendo o texto mascarado mais o mapa;
  - `run.qa.test.ts`: no caso "corpo citado não persistido", o texto próprio agora tem tamanho suficiente,
    porque com texto próprio curto o bloco citado passa a ser preservado de propósito.

**Validação**
- 86 arquivos de M365, Checkpoint, rotas e templates: 1145 testes passando.
- Suíte completa: 3785 passando, e as 15 falhas em 8 arquivos são exatamente o baseline `next-auth`/`next/server`.
- `tsc` só com os 10 erros de `inbound.test.ts`; eslint limpo; `prisma validate` ok.

**Riscos remanescentes**
- O leitor de PDF continua mínimo (sem LZW/ASCII85, sem encodings custom sem ToUnicode). O orçamento de 2 s pode
  descartar um PDF legítimo muito grande, que conta como não suportado, e a ata segue com o corpo.
- O mínimo de 24 caracteres é heurístico.
- Ata e cards desmascarados ficam com dados pessoais reais. Eles herdam a visibilidade do checkpoint (PRIVATE, só
  o gestor).

## Fase M2 — correções 2

Data: 2026-11-26. Corrige a reprovação do validador: CPU síncrona quadrática disparável por um remetente externo.

**Bloqueantes**
- **B1 — DOCX** (`minutes/docx.ts`): a regex `<w:t(?:\s[^>]*)?>…` foi trocada por um **varredor com `indexOf`**:
  - o nome da tag tem no máximo 16 caracteres;
  - `<w:t>` sem fechamento ou `<` sem `>` encerram a varredura;
  - orçamento de **2 s de parede** (`DOCX_TIME_BUDGET_MS`); ao estourar, lança e o anexo vira `skipped/error`.

  As entidades XML agora têm quantificadores limitados.
- **B2 — `maskPii`:** a nova `EMAIL_RE` usa lookbehind (só começa no início de um bloco de caracteres de e-mail) e
  quantificadores limitados (`{1,64}@{1,63}(\.{1,63}){0,7}\.[A-Za-z]{2,24}` + lookahead). PHONE/CPF/CNPJ foram
  revistas (tabela abaixo).
- **B3:** `.replace(/[ \t]+\n/g, …)` saiu de `body.ts` e `docx.ts`. Entrou `tidyText` (`minutes/text-safe.ts`):
  `split("\n")`, corte manual de espaços no fim de cada linha e colapso de linhas vazias.
- **Teto antes de qualquer regex (defesa em profundidade):**
  - corpo cortado em 300 000 caracteres na entrada de `cleanEmailBody` e em 120 000 no texto-fonte;
  - cada anexo cortado em 60 000 no texto-fonte (o extrator já cortava em 200 000);
  - assunto cortado em 1 000 antes das regexes de assunto e da busca;
  - linhas com mais de 500 caracteres não são testadas como cabeçalho ou assinatura (`testShortLine`);
  - o corte (`truncateAtSpace`) recua até um espaço, então nunca parte um dado ao meio.

**Varredura de regex sobre texto não confiável** (`lib/m365/**`, `lib/checkpoint/**`):

| Local | Regex / operação | Veredito |
|---|---|---|
| docx.ts `docxXmlToText` | `<w:t(?:\s[^>]*)?>([^<]*)</w:t>…` | **reescrita**: varredor `indexOf` + orçamento de 2 s |
| docx.ts `decodeXml` | `&(#x[0-9a-f]+\|#\d+\|…);` | **reescrita** com `{1,8}`/`{1,10}` |
| docx.ts / body.ts `tidyLines` | `/[ \t]+\n/g`, `/\n{3,}/g` | **reescrita**: `tidyText` (split + loop) |
| pii.ts `EMAIL_RE` | `[…]+@[…]+\.[A-Za-z]{2,}` | **reescrita**: lookbehind + quantificadores limitados |
| pii.ts `CPF_RE` | `(?<![\d.])\d{3}[. ]?\d{3}[. ]?\d{3}[-. ]?\d{2}(?!\d)` | linear: lookbehind fixa o início do bloco, comprimento ≤14 |
| pii.ts `CNPJ_RE` | `(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)` | linear: idem, comprimento ≤18 |
| pii.ts `PHONE_RE` | `(?<![\d\w])(\+?55…)?(\(?\d{2}\)?…)?(9…\|\d{4})…\d{4}(?![\d\w])` | linear: só quantificadores `?`/fixos, comprimento ≤20 por início |
| pii.ts `TOKEN_RE` (unmask) | `\[(EMAIL\|…)_[A-Z]{0,3}\d{1,6}\]` | linear: começa num literal `[`, limitada |
| pii.ts `digits`, `isPlausiblePhone` | `\D`, `^(\d)\1+$`, `[\s.-]` | linear: sobre o trecho já casado (≤20 caracteres) |
| body.ts `decodeEntities` | `&(#x[0-9a-f]+\|#\d+\|[a-z]+\d*);` | **reescrita** com `{1,8}`/`{1,10}`/`{1,32}\d{0,4}` (antes `[a-z]+\d*` era quadrático) |
| body.ts `QUOTE_HEADER_RES` / `SIGNATURE_RES` / `HEADER_FIELD_RE` / "De:" / "Enviado:" | ancoradas `^…` | linear: ancoradas; `.{3,200}` limitado; aplicadas só a linhas ≤500 (`testShortLine`) |
| body.ts `isForwardSubject` | `^\s*((re\|…)\s*:\s*)*(enc\|…)\s*:` | linear: cada repetição começa por um literal; assunto ≤300 |
| body.ts `unquote` | `^[ \t]*(?:>[ \t]?)+` | linear: ancorada; o grupo começa por `>` (sem sobreposição) |
| body.ts `\r\n?`, `\u0000` | char único | linear |
| body.ts `htmlToText` nome da tag | `^<\/?\s*([a-zA-Z0-9]+)` sobre fatia de 40 caracteres | linear |
| select.ts `REPLY_PREFIX_RE` | `\s*(?:\[\d+\])?\s*:` | **reescrita**: `\s*(?:\[\d{1,4}\]\s*)?:` (dois `\s*` adjacentes eram quadráticos); assunto ≤1000 |
| select.ts `MEETING_RESPONSE_RE` | `^\s*(alternativas)\s*:` | linear: ancorada; assunto ≤1000 |
| select.ts `normalizeSubject` | `[̀-ͯ]`, `[^\p{L}\p{N}]+` | linear: casamento sempre bem-sucedido ao iniciar (avança) |
| generate.ts / checkpoint/extraction.ts `stripToJson` | `^```(json)?\s*`, `\s*```$` | **reescrita**: `stripCodeFence` sem regex (`\s*```$` sem âncora era quadrático) |
| generate.ts `parseIsoDate` | `^(\d{4})-(\d{2})-(\d{2})$` | linear: fixa |
| pdf.ts `tidy` | `[ \t]+`, ` ?\n ?`, `\n{3,}`, `\s` | linear: substituição global de bloco que sempre casa ao iniciar; o resto é limitado |
| pdf.ts parser | — | sem regex (correções 1) |
| graph/client.ts `subjectSearchTerm` | `[^\p{L}\p{N}\s]`, `\s+` | linear; assunto ≤1000 |
| graph/client.ts `pathSegment`, `odataString` | `^\.{1,2}$`, `\.`, `'` | linear |
| calendar/detection.ts assunto 1:1/checkpoint | alternativas com `\b`/lookbehind, sem quantificador | linear |
| calendar/normalize.ts datas | `(\.\d{3})\d+`, `[zZ]\|[+-]\d{2}:?\d{2}$` | linear: entrada do Graph (dateTime) curta |
| checkpoint/extraction.ts `norm` | `[̀-ͯ]` | linear |
| run.ts `isValidMessageId` | `^[…]{1,512}$` | linear: ancorada e limitada |
| run.ts / pdf.ts contagem | `.replace(/\s/g, "")` | linear |

**Testes obrigatórios** (`minutes/linear-regex.test.ts`, 22 casos, cada um < 1 s):
- DOCX: `"<w:t x".repeat(40000)` zipado, `<w:tab/>` repetido, `<w:t>` sem fechamento, orçamento estourado.
- `maskPii`: 200k letras, `a@` + 200k letras e mais 9 padrões de dígitos, pontos e DDD.
- `cleanEmailBody`: 200k espaços/tabs, `\n` e `>` repetidos.
- Um caso por regex reescrita: entidades, `htmlToText`, prefixos de assunto, resposta de convite, busca,
  `stripCodeFence`/`parseMinutes`/`parseExtraction`.

**Menores**
1. `generate.ts`: o rodapé "Dados pessoais mascarados." aparece só no fallback (texto-fonte). A ata desmascarada não
   o leva.
2. Texto de consentimento (`M365ConnectionPanel.tsx`): "A ata é gravada no checkpoint com a mesma visibilidade dele
   e guarda os dados reais; o texto original do e-mail fica guardado mascarado."
3. Comentário do schema de `CheckpointActionItem`: o texto agora é desmascarado. A mudança é só no `///`, sem
   mudança de banco nem migration nova; `prisma validate` ok.
4. `ESPECIFICACAO.md` §3/M2 registra como decisão que a categoria `JumpFlow` exige o consultor em from/to/cc ou o
   assunto do evento.

**Validação**
- 87 arquivos de M365, Checkpoint, rotas e templates: 1167 testes passando.
- Suíte completa: 3807 passando, e as 15 falhas em 8 arquivos são o baseline `next-auth`/`next/server`.
- `tsc`: só os 10 erros de `inbound.test.ts`. eslint limpo.

## Fase M2 — veredito do validador

1ª validação: REPROVADO — CPU síncrona quadrática disparável por remetente externo (DOCX, maskPii, limpeza de espaços), mesma classe já corrigida no PDF.
Revalidação após "correções 2": **APROVADO COM RESSALVAS** — 107 casos hostis medidos pelo validador, todos < 30 ms; auditoria independente de regex sem quadrática remanescente.
Menor remanescente, a tratar no início da M3:
1. `truncateAtSpace` (text-safe.ts:49) corta no meio de um dado pessoal quando não há espaço nos 200 caracteres anteriores ao teto (roda antes da máscara) → fragmento de CPF/telefone pode ir cru à IA. Recuar enquanto o caractere for de "dado" ou descartar o último bloco sem espaço.

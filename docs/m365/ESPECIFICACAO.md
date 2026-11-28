# Microsoft 365 (Agenda, E-mail de atas, Teams) — Especificação

Integração com o Microsoft Graph para:

1. Ler a **agenda** e transformar reuniões em **checkpoints/1:1 em rascunho** e em
   **sugestões de horas**.
2. Capturar **atas** (por e-mail e pela transcrição do Teams) dessas reuniões, gerando
   a ata do Checkpoint e os **cards** extraídos.

Os cards são:
- Oportunidades;
- Cases;
- sugestões de Skills;
- Ações/próximos passos.

Todos nascem PENDING e passam por validação humana.

Referência de origem: integração Outlook do Jump PM (`/Volumes/KINGSTON/Code/jump-pm`):
- `docs/outlook/ESPECIFICACAO.md`;
- `src/lib/graph/*`;
- `src/lib/calendar/*`;
- `src/lib/outlook/minutes/*`.

Reaproveitar o desenho, que é bom, mas lembrar que **ele nunca rodou contra o Graph
real**. Progresso e vereditos: `docs/m365/ANDAMENTO.md`.

## 1. Decisões de produto (fechadas)

1. **Permissão delegada, por usuário, com opt-in.** Nada de permissão de aplicação
   nem de leitura da organização inteira.
2. Consentimento **incremental** e **separado do login**. O login (Auth.js +
   Microsoft Entra ID, `apps/web/src/auth.config.ts`) continua só com identidade.
3. **Escopos por fase.** Nunca pedir escopo de fase futura.
   - **M1:** `openid profile offline_access User.Read Calendars.Read`
   - **M2:** `+ Mail.Read`
   - **M3:** `+ OnlineMeetings.Read OnlineMeetingTranscript.Read.All`
     (`OnlineMeetingTranscript.Read.All` exige consentimento de admin)
   - **Proibidos sempre:** `Mail.Send`, `Mail.ReadWrite`, `Chat.*`, `*.ReadWrite.All`
     e qualquer `.All` de aplicação.
4. E-mail **não** é triagem de caixa de entrada. A ingestão é estreita, só para atas
   de checkpoint/1:1 (seção M2). Mensagem que não casa com as regras não é
   armazenada.
5. 1:1 é o conteúdo mais sensível da plataforma:
   - para atas, **só a conta do gestor** (quem registra o checkpoint) é usada;
   - a agenda e a caixa do consultor **nunca** alimentam atas.
6. IA: DeepSeek com fallback Gemini via `getAiTextProvider()`. **Mascarar** e-mail,
   telefone, CPF e CNPJ antes de qualquer chamada. Toda saída é sugestão; ninguém
   grava entidade final sem clique humano.

## 2. Arquitetura base (M1)

### Credenciais do app Entra
- Env próprias `M365_CLIENT_ID`, `M365_CLIENT_SECRET`, `M365_TENANT_ID`, com
  **fallback** para `AUTH_MICROSOFT_ENTRA_ID_*` quando ausentes.
- Redirect URI: `${AUTH_URL}/api/integrations/m365/callback`. Documentar no
  `.env.example` e no `docs/m365/`.
- Feature flag `M365_INTEGRATION_ENABLED` (desligada por padrão). Desligada, nenhuma
  tela, job ou rota da integração funciona.

### OAuth
- Authorization code + **PKCE S256**.
- `state` assinado com HMAC (userId + nonce + expiração); `code_verifier` em cookie
  httpOnly cifrado com path restrito.
- No callback, conferir:
  - state × sessão;
  - `tid` do token × `M365_TENANT_ID`;
  - `/me` (`mail`/`userPrincipalName`) × e-mail do usuário logado. **Só é possível
    conectar a própria conta.**
- Recusar issuers `common`, `organizations` e `consumers`.
- Erros para a UI são só códigos mapeados.

### Tokens
- Tabela própria (por exemplo `M365Connection`):
  - userId único;
  - access/refresh **cifrados** — reusar o util de criptografia de campo já existente
    no projeto (`field-encryption`), sem criar outro;
  - `expiresAt`, `scopes`, `graphUserId`, `mailbox`;
  - `status` (`ACTIVE | PAUSED | REAUTH_REQUIRED | ERROR | DISCONNECTED`);
  - cursores delta;
  - lease de sync e `lastError`.
- Refresh 5 min antes de expirar ou após um 401, com o refresh rotacionado sempre
  persistido. `invalid_grant` → `REAUTH_REQUIRED`.

### Cliente Graph
- `fetch` puro, sem SDK.
- Erros tipados (`reauth | config | throttled | resync | not_found | forbidden | http`).
- Retry em 429/503/504 respeitando `Retry-After`, com teto e prazo da rodada.
- Timeout por chamada.
- `Prefer: outlook.timezone="UTC"`.

### Jobs
- Route Handlers cron-friendly em `/api/jobs/m365-*`, mesmo contrato `CRON_SECRET`
  de `/api/jobs/*` (ADR08/ADR15).
- Leases no banco: **nenhuma trava em memória** (Railway pode ter várias instâncias).
- Botão "Sincronizar agora" na tela de conexão, para funcionar sem agendador. O
  agendamento no Railway é pendência de deploy (ADR17), **fora** do código.

### Tela "Microsoft 365"
Fica na área de conta/configurações do usuário (escolher o lugar coerente com a
navegação atual). Mostra:
- conectar / pausar / desconectar;
- escopos concedidos;
- último sync e último erro;
- texto de consentimento claro: o que é lido, o que nunca é feito (enviar e-mail,
  ler chats), o que é guardado.

Desconectar apaga os tokens.

Admin: visão "N de M usuários conectados" (gated pela matriz; código novo
`INTEGRACOES_M365` filho de configurações/admin, migration aditiva no padrão do
commit `c5ff0d8`).

### Logs
Usar `IntegrationEvent` (provider novo no enum) para operações e falhas, sem
conteúdo pessoal.

## 3. Fases

### M1 — Conexão + Agenda
- **Sync** de `/me/calendarView/delta`:
  - janela −30 / +60 dias;
  - cursor por conexão;
  - 410/resync recomeça a janela.
- **Armazenar:**
  - `CalendarEvent`, único por `iCalUId`: assunto, início/fim, organizador,
    participantes (JSON), `joinUrl` só de host Teams permitido, cancelado,
    `onlineMeetingId?`;
  - `CalendarEventSighting` por conexão: `graphEventId`, `webLink`,
    `responseStatus`, `lastSeenAt`.
- **Nunca armazenar** o corpo do convite. Eventos privados/confidenciais e
  series master são descartados.
- **Detecção de checkpoint/1:1**, para a conta de um usuário com papel em
  `CHECKPOINT_WRITE_ROLES` (`lib/checkpoint/visibility.ts`). O evento precisa:
  - ser organizado por esse gestor;
  - ter exatamente **um** consultor participante, que esteja no escopo do gestor
    (`canTargetConsultant` ou equivalente no servidor);
  - ter assunto que casa com `/(1:1|1-on-1|one on one|1on1|checkpoint|check-in)/i`
    **ou** ter a categoria `JumpFlow`.

  Tipo: `ONE_ON_ONE` se o assunto indicar 1:1, senão `CHECKPOINT`.
- **Rascunho de Checkpoint:**
  - criado `DRAFT` / `PRIVATE`, com consultor, gestor, `occurredAt` = início do
    evento e título = assunto;
  - vínculo com o evento: FK opcional nova ou tabela de link — decidir com o
    data modeler, migration aditiva;
  - idempotente: um rascunho por evento por consultor;
  - evento cancelado → rascunho ainda DRAFT e sem conteúdo é marcado/removido (definir
    e testar).
- **Sugestões de horas**, na conta de qualquer usuário conectado que seja consultor:
  - o evento passado da semana com participante externo cujo e-mail ou domínio casa
    com um contato/cliente de um projeto em que o consultor está **alocado** vira
    sugestão de lançamento (projeto, data, duração) na tela de Horas;
  - o consultor aceita (pré-preenche o formulário de lançamento existente), ajusta ou
    ignora;
  - **nunca** lança sozinho;
  - domínios públicos (gmail, outlook, hotmail...) e o domínio interno não contam;
  - regra de vínculo e prioridade em código puro testado; mais de um projeto possível →
    o consultor escolhe.

### M2 — E-mail de atas → ata do Checkpoint → cards
- Consentimento incremental de `Mail.Read` (botão "Ativar atas por e-mail").
- **Ingestão estreita, orientada a consulta.** Nada de sync da caixa inteira. Para
  cada Checkpoint em rascunho com evento já encerrado há menos de 7 dias e sem ata, o
  job consulta a caixa **do gestor**:
  - mensagens com categoria `JumpFlow` recebidas desde o início do evento;
  - mensagens recebidas entre o início do evento e +7 dias cujo assunto contenha o
    assunto do evento (normalizado, sem RE:/ENC:/FW:) **e** que tenham o consultor ou
    o gestor em from/to/cc.

  Só a melhor candidata é usada. Em empate, nada é escolhido sozinho: o gestor escolhe
  na tela.
- **Conteúdo:**
  - corpo convertido para texto (sem citações/assinaturas);
  - anexos PDF/DOCX ≤ 10 MB com texto extraído — verificar libs já instaladas antes de
    adicionar;
  - PDF escaneado não é suportado.
- **Geração da ata:**
  - texto mascarado → `getAiTextProvider()` (JSON, validado por Zod);
  - resultado: resumo, decisões, pontos de atenção, ações (título, responsável, prazo);
  - grava no Checkpoint: `notes` = ata formatada; `transcription` = texto-fonte
    **mascarado**; status `RECORDED`;
  - o e-mail bruto **não** é guardado, só os metadados de origem (`internetMessageId`,
    `webLink`, recebido em).
- **Cards:**
  - disparar o pipeline de extração já existente (`lib/checkpoint/extraction.ts`):
    Oportunidades, Cases e sugestões de Skills em PENDING;
  - criar o novo card **Ação/próximo passo** (modelo novo, por exemplo
    `CheckpointActionItem`: título, responsável, prazo, status
    `PENDING|ACCEPTED|DONE|DISMISSED`, `sourceQuote`);
  - o gestor valida na tela do Checkpoint.
- Notificar o gestor (infra de notificações existente) quando a ata ficar pronta.
- Idempotência: um e-mail (`internetMessageId`) alimenta no máximo um Checkpoint.

### M3 — Transcrição do Teams
- Consentimento incremental de `OnlineMeetings.Read` +
  `OnlineMeetingTranscript.Read.All`.
- Para Checkpoint em rascunho cujo evento é reunião Teams **organizada pelo gestor
  conectado**, entre 10 min e 48 h após o fim:
  - `GET /me/onlineMeetings?$filter=JoinWebUrl eq '<url>'`;
  - `/transcripts`;
  - `/content?$format=text/vtt`.
- Backoff 15 → 30 → 60 → 120 min, até 6 h após o fim. Um 403 marca acesso negado
  (sem novo retry por 24 h).
- Sem transcrição → notificar o gestor para colar notas ou aguardar a ata por e-mail.
- Precedência: a transcrição do Teams vence o e-mail. Se já houver ata por e-mail, a
  transcrição só complementa, mediante ação do gestor.
- VTT só em memória → "Nome: fala" → truncar (70% início / 30% fim, com marcador) →
  mascarar → mesma geração de ata e cards da M2.
- Máquina de estados persistida e testada:
  `PENDING → WAITING_TRANSCRIPT → GENERATING → DONE | NO_TRANSCRIPT | FAILED`.

### M4 — (próxima rodada, fora desta execução)
- Notificações e aprovação via Teams.
- Ausências escritas na agenda.
- Webhooks do Graph.

## 4. Privacidade / LGPD

- Visibilidade: ata e cards herdam a do Checkpoint (`resolveCheckpointReadScope`).
  PRIVATE = o consultor não vê.
- Guardado:
  - metadados do evento;
  - ata gerada;
  - texto-fonte mascarado;
  - metadados de origem do e-mail.
- Nunca guardado:
  - corpo do convite;
  - e-mail bruto;
  - VTT bruto;
  - tokens em claro.
- Desconectar apaga os tokens; os dados já gerados ficam como registro da empresa
  (informado no consentimento).
- A remoção LGPD por pessoa fica como pendência registrada para M4.

## 5. Qualidade

- Graph real **não** está disponível no ambiente de dev. Todo acesso passa por
  interface injetável, com um fake para testes, como o `src/lib/graph/fake.ts` do
  Jump PM.
- O fluxo inteiro precisa ser coberto por testes com o fake:
  - OAuth (state, PKCE, mismatch);
  - refresh;
  - delta/410;
  - detecção de checkpoint;
  - vínculo de sugestão de horas;
  - seleção de e-mail;
  - máquina de estados da transcrição;
  - idempotência;
  - mascaramento antes da IA.
- Pendências de validação real (Azure, consentimento de admin, encoding de
  `JoinWebUrl`) devem ficar listadas no ANDAMENTO.

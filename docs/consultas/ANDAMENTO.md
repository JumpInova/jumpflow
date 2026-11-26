# Andamento — Consultas

Especificação: `docs/consultas/ESPECIFICACAO.md`. Registro mantido pelo orquestrador
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
| C1 | concluída (commit no branch) | APROVADO COM RESSALVAS — menores 1, 2 e 4 entram no início da C2 |
| C2 | concluída (commit no branch) | APROVADO COM RESSALVAS — menores 1–4 entram no início da C3 |
| C3 | concluída (commit no branch) | APROVADO COM RESSALVAS (2 revalidações; ressalvas finais corrigidas) |

## Fase C1 — dev

### Arquivos
Criados:
- `packages/database/prisma/migrations/20261127100000_consultas_fundacao/migration.sql` — 16 códigos da matriz (módulo "Gestão", só `canView`, ON CONFLICT DO NOTHING) + views `consulta_horas`, `consulta_alocacoes`, `consulta_consultores` (CREATE OR REPLACE VIEW).
- `apps/web/src/lib/consultas/`: `types.ts`, `catalog.ts` (fonte única), `spec.ts` (Zod + limites + operadores por tipo), `access.ts` (entidade/coluna, catálogo visível), `validate.ts` (semântica), `compile.ts` (spec → `Prisma.sql`), `dates.ts` (datas relativas em America/Sao_Paulo), `result.ts` (paginação/normalização), `format.ts`, `csv.ts`, `builder.ts`, `page-access.ts`.
- `apps/web/src/lib/db/consultas.ts` — contexto (matriz + `resolveReportScope` + Dados Sensíveis), execução em `$transaction` com `SET LOCAL statement_timeout = '15s'`, exportação e auditoria.
- `apps/web/src/app/app/consultas/{page.tsx,actions.ts}`, `apps/web/src/app/app/consultas/catalogo/page.tsx`, `apps/web/src/app/api/consultas/exportar/route.ts`.
- `apps/web/src/components/consultas/{ConsultaBuilder,FilterEditor,ConsultaResultView,CatalogBrowser}.tsx`.
- Testes: `lib/consultas/{compile,validate,catalog,csv,dates,result}.test.ts`, `lib/db/consultas.test.ts`, `components/consultas/ConsultaBuilder.test.tsx` (90 testes).

Alterados: `lib/auth/permission-codes.ts` (`CONSULTAS_CODES` + `SYSTEM_PERMISSION_CODES`), `packages/database/prisma/seed.mjs`, `packages/database/prisma/align-permission-catalog.mjs`, `lib/navigation.ts` (item "Consultas" no grupo Relatórios & Análises), `lib/auth/route-permissions.ts` (`/app/consultas` → `ALL`; o gate é a matriz `CONSULTAS` via layout).

### Decisões
- **Rota:** `access: "ALL"` no mapa de rotas + `permissionCode: "CONSULTAS"` no item de menu (o layout redireciona para `/access-denied`). Público muda pela Matriz, sem código.
- **Construtor exige `CONSULTAS_CRIAR`**; sem ele a tela mostra estado vazio (visões compartilhadas chegam no C2). Catálogo exige só `CONSULTAS`. Exportação exige `CONSULTAS_EXPORTAR`.
- **Escopo de linha:** reusa `resolveReportScope` integralmente (amplo / PM por `project_manager_id[s]` / próprio consultor / sem universo → `FALSE`), sempre o 1º termo do WHERE, com os filtros do usuário entre parênteses. O recorte do Financeiro (horas só APPROVED/CLOSED) também é aplicado em `consulta_horas`.
- **Colunas:** `financeiro` = `includeFinancials` dos Relatórios (FINANCIAL_ROLES); `custo_sensivel` = `canAccessSensitiveCost`. Campo oculto some do catálogo enviado ao cliente; se vier na spec, FORBIDDEN (403).
- **Valor-hora de venda** na view replica `resolveBillingRate`/`resolveSaleRate` (faixa `startsAt::date ≤ data < endsAt::date`; alocação → consultor → projeto → `Project.billingHourlyRate` → `Client.defaultHourlyRate`; empate = início mais recente). **Validado** em Postgres embutido (PGlite, só no scratchpad, nada contra `DATABASE_URL`): 84 lançamentos com bordas de vigência e horários quebrados, paridade 100% com a função TS; todas as specs de exemplo e operadores executaram nos 5 tipos de escopo.
- **Valor-hora de custo NÃO entrou**: `ConsultantProjectRate`, `ConsultantAllocationCostRate`, `ConsultantCompensation` e `Consultant.hourlyCost` são cifrados na aplicação (AES-256-GCM) — o Postgres não consegue ler, e agregar custo/margem em Node viola §4.4/§9. Métricas "Custo"/"Margem" constam no catálogo como indisponíveis.
- Métricas: Receita = horas × venda vigente só para faturável + APPROVED/CLOSED; "Valor (horas × valor-hora)" = bruto em qualquer situação (igual ao `billedAmount` da linha dos Relatórios); Horas aprovadas incluem CLOSED.
- Ordenação estável com desempate por `id` (lista) ou posição do grupo; `neq` usa `IS DISTINCT FROM` (inclui vazios); `contains` = `ILIKE` com `%`/`_`/`\` escapados.
- Auditoria: `CONSULTA_EXECUTADA_SENSIVEL` (execução com campo financeiro/custo) e `CONSULTA_EXPORTADA` (toda exportação), `entityType: "Consulta"`, com a spec e contagens.
- Nenhuma dependência nova no projeto (Zod, ExcelJS, lucide já existiam). PGlite foi instalado apenas no scratchpad da sessão para validar o SQL.

### Critérios de aceite (C1)
- [x] Matriz com os 16 códigos (migration aditiva + seed + align + constantes; testes de alinhamento passam).
- [x] Rota `/app/consultas`, navegação e guard (matriz `CONSULTAS` no layout + checagens no servidor).
- [x] Catálogo único + views de Horas, Alocações e Consultores, com colunas técnicas de escopo; teste confere cada coluna do catálogo contra o SQL da migration.
- [x] Compilador seguro (`Prisma.sql`, identificadores só do catálogo + allow-list, valores parametrizados, agregação no Postgres) e executor com `statement_timeout` 15s.
- [x] Escopo de linha e coluna no servidor; campo sem permissão rejeitado (403).
- [x] Construtor visual (entidade, filtros E/OU, colunas, agrupar ≤2 com granularidade, medidas, ordenação), tabela paginada (100/página, 1000 navegáveis), totais, estados vazio/erro/carregando, link "Abrir consultor" por linha.
- [x] Catálogo `/app/consultas/catalogo`: busca, descrição, origem, tipo, badge de sensibilidade, métricas, exemplos, "Usar na consulta".
- [x] Exportação XLSX (`lib/export/xlsx.ts`, aba de Totais) e CSV (`;`, BOM, escape de fórmula) no servidor, até 50.000 linhas, gated por `CONSULTAS_EXPORTAR`.
- [x] Testes: compilador (inclui injeção), permissões de entidade/coluna, escopo de linha, operadores por tipo, CSV com fórmula.

Validação local: `vitest` (arquivos da fase) 90/90; `tsc -p tsconfig.test.json` só os 10 erros pré-existentes de `inbound.test.ts`; `eslint` limpo; `prisma validate` ok. Suíte completa: 15 falhas em 8 arquivos idênticas ao baseline sem as mudanças (módulo `next/server` não resolvido no worktree, entre outras) — nenhuma regressão.

### Pendências e riscos
- **Custo/margem** dependem de decisão de arquitetura (custo cifrado). Opções: projeção decifrada restrita a Dados Sensíveis, ou agregação dedicada no servidor só para custo. Precisa de ADR.
- **Gestor de Área:** a spec pede "a própria área", mas `resolveReportScope` trata AREA_MANAGER como escopo amplo e `Consultant.area` é texto livre (sem vínculo gestor↔área). Mantido igual aos Relatórios; a view já expõe `area` para quando existir o vínculo.
- PEOPLE só tem escopo amplo se tiver `RELATORIOS_CONSULTORES` (padrão: sim); sem ele, cai no "próprio consultor" — comportamento herdado dos Relatórios.
- Desempenho: filtros de data passam por `::date` sobre a view (sem uso do índice de `TimeEntry.date`); `consulta_alocacoes` soma horas por alocação via LATERAL. Aceitável no volume atual; o timeout de 15s protege. Observar em produção.
- `semana` usa `date_trunc('week')` (segunda-feira), igual a `inicio_semana`.
- A migration precisa rodar no deploy (views + células da matriz); bancos já em uso recebem nome/módulo pelo `align-permission-catalog.mjs`.

## Fase C1 — testes

### Testes criados (510 novos, todos passando)
- `apps/web/src/lib/consultas/security.test.ts` (466) — varredura gerada do catálogo:
  - injeção: toda entidade × campo × operador permitido, com valor malicioso. Valores só como parâmetro; todo identificador entre aspas no SQL pertence ao catálogo/aliases fixos. Também cobre agrupamento + todas as medidas.
  - escopo de linha: toda entidade × {PM, consultor, sem universo, Financeiro}, com filtro OU "sempre verdadeiro" (`not_null OR is_null OR contains "' OR 1=1"`). Em rows/count/totals (plano e agrupado): `WHERE (<escopo>) AND ((…))`, um único WHERE e o parâmetro do escopo em `$1`. PM sem `User.id` → FALSE. Financeiro filtrando DRAFT continua preso a APPROVED/CLOSED.
  - coluna: todo campo não público como coluna, filtro, `is_null`, medida, `count`, agrupamento e ordenação → FORBIDDEN sem permissão e válido com permissão. O catálogo visível não cita esses campos.
  - entidade/módulo: o code de outra entidade não libera; `canCreate`/`canEdit` sem `canView` não liberam; CRIAR/EXPORTAR sem `CONSULTAS` não valem.
  - 41 specs malformadas → INVALID (chaves de protótipo, objeto/array aninhado, tipo errado, data inválida, opção de lista fora da lista, limites, `__proto__` vindo de JSON).
  - datas relativas nas bordas de SP: domingo 22h, virada de mês e virada de ano.
- `apps/web/src/lib/consultas/views.test.ts` (14) — SQL da migration × `resolveSaleRate`: precedência, vigência (início inclusivo, fim exclusivo, por dia), desempate, `allocationId`/`consultantId` nulos por nível, receita/valor bruto/horas aprovadas. Também confere: nenhuma tabela de custo cifrado; Custo/Margem marcados "não disponível" e sem campo; métricas oficiais e "% de ocupação" presentes.
- `apps/web/src/app/api/consultas/exportar/route.test.ts` (18) — rota real + `exportConsulta` real, com Prisma/matriz mockados.
  - 403: sem EXPORTAR; com EXPORTAR sem CRIAR; sem a entidade; campo financeiro; matriz ilegível.
  - 400: JSON quebrado, formato inventado, SQL na spec, coluna injetada. 503 sem banco; 500 genérico sem SQL; 504 em timeout.
  - SQL com escopo em `$1` e teto de 50.000 (ou o `limit` da spec).
  - CSV byte a byte: BOM, `;`, CRLF, `'=`/`'@`/`'+`, aspas duplicadas e negativo `-1,5` sem prefixo.
  - XLSX: fórmula fica texto e há aba Totais. Auditoria `CONSULTA_EXPORTADA` completa.
- `apps/web/src/app/app/consultas/actions.test.ts` (12) — `executarConsulta` sobre o `runConsulta` real:
  - erros: NO_DATABASE; FORBIDDEN sem CRIAR; INVALID; FAILED sem detalhes do banco.
  - escopo e paginação: sem universo → `WHERE (FALSE)`; página 999 → página 10/OFFSET 900; página inválida → 1.
  - saída: `_href` com `encodeURIComponent`; nenhum alias SQL exposto.

Validação extra (fora do repo, só no scratchpad; nenhum acesso a `DATABASE_URL`):
- PGlite com tabelas-stub e a migration real: paridade de `valor_hora_venda` com `resolveSaleRate` em 3 sementes × 1.500 lançamentos, com horários quebrados. **0 divergências**, cobrindo as 5 origens e o nulo.
- 6.055 SQLs gerados pelo compilador (todas as entidades × campos × operadores × 5 escopos, mais agrupamentos em todas as granularidades) **executaram sem erro**. Nenhum `WHERE (FALSE)` retornou linhas.

### Resultado
- Vitest completo: 3830 passaram, 15 falharam, 1 pulado (3846 testes; 287 arquivos passaram, 8 falharam). As 15 falhas em 8 arquivos são exatamente o baseline (`next-auth`/`next/server`); nenhuma regressão.
- Arquivos da fase: 598/598 (88 do dev + 510 novos).
- `tsc -p tsconfig.test.json --noEmit`: só os 10 erros pré-existentes de `inbound.test.ts`.
- `eslint` nos arquivos da fase: limpo.

### Bugs encontrados
- **Bloqueante:** nenhum.
- **Importante:** a view `consulta_alocacoes` não aplica o recorte de horas do Financeiro (`migration.sql:173` e `:184-190`).
  - Cenário: FINANCE (`financeHoursLimited`) consulta Alocações.
  - Esperado: `horas_lancadas` só com APPROVED/CLOSED, como nos Relatórios e em `consulta_horas`.
  - Obtido: soma DRAFT/SUBMITTED/REJECTED. A entidade não tem `financeStatusColumn`, e o recorte é por linha de horas, não por alocação.
  - Correção sugerida: o Financeiro passa a usar só `horas_aprovadas`, ou `horas_lancadas` fica oculta para esse escopo.
- **Menor:** o desempate de faixas com o mesmo `startsAt::date` no mesmo nível difere.
  - SQL: `startsAt DESC, id DESC`, determinístico.
  - TS: `sort` estável sobre a ordem do Prisma, sem `orderBy`.
  - Só diverge com faixas sobrepostas, que `findOverlappingSaleRate` bloqueia na escrita. Pode ocorrer com dados legados.
- **Menor (para o C2):** `exportConsulta` também exige `CONSULTAS_CRIAR`. Quem tiver só `CONSULTAS` + `EXPORTAR` não conseguirá exportar visões compartilhadas sem ajuste.

### Cobertura dos critérios (C1)
- Matriz/rota/navegação: testes de alinhamento do dev + gates de módulo/CRIAR/EXPORTAR (novos).
- Catálogo + views: colunas × migration (dev), regra de venda (novo + PGlite), custo/margem indisponíveis (novo).
- Compilador seguro: injeção exaustiva por catálogo; identificadores só do catálogo; parâmetros; `statement_timeout` (dev + rota).
- Escopo de linha: todas as entidades × escopos × consultas geradas; OU não escapa.
- Coluna sem permissão → 403 em toda posição; catálogo filtrado.
- Operadores por tipo: tabela (dev) + todos os pares válidos compilam/executam + pares inválidos → INVALID.
- Exportação XLSX/CSV, escape de fórmula, limite 50.000, auditoria: rota ponta a ponta.
- Construtor visual/tela: só o teste de componente do dev (2 casos). Catálogo `/app/consultas/catalogo` e estados de carregamento sem teste automatizado.

## Fase C1 — correções

1. **Custo e margem fora (decisão 6).** A métrica "Custo e margem" saiu do catálogo; não há mais nenhuma menção. Nenhuma view lê tabelas de custo: `views.test.ts` checa isso, e o teste do testador foi ajustado para exigir que não exista métrica nem campo de custo/margem. O nível `custo_sensivel` continua no tipo e na checagem de coluna (§4.3), sem nenhum campo usando.
2. **Gestor de Área (decisão 7).** O escopo dos Relatórios fica como está. O código não citava "própria área"; a pendência registrada em "C1 — dev" está resolvida pela decisão.
3. **Recorte do Financeiro em `consulta_alocacoes`.**
   - O problema: o recorte é por lançamento, mas a linha da view é a alocação.
   - Decisão: novo atributo de campo `financeRestricted`.
   - `horas_lancadas` (Alocações) fica oculto para quem tem `financeHoursLimited`: some do catálogo e é recusado com FORBIDDEN, tanto pelo nome quanto em agregação.
   - O Financeiro usa `horas_aprovadas` (APPROVED/CLOSED), que já segue o mesmo critério de `consulta_horas`/Relatórios.
   - `ConsultaAccess.financeHoursLimited` vem de `resolveReportScope`. No modo demo, sem banco, usa o mesmo critério por papel.
   - A view não mudou; a regra fica no catálogo e no servidor, então não há como contorná-la pela spec.
4. **Desempate de valor-hora determinístico.**
   - SQL: `ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC` nas 6 subconsultas.
   - TS (`newestFirst` em `lib/projects/rates.ts`): mesmo dia de início → maior `id` em ordem de code unit (equivale a `COLLATE "C"`).
   - Para dados válidos, sem faixas sobrepostas, o comportamento é o mesmo de antes; no empate o resultado deixa de depender da ordem do Prisma.
   - Cobertura: teste novo em `rates.test.ts`, inclusive maiúsculas antes de minúsculas, e a checagem do `ORDER BY` em `views.test.ts`. Conferido também no PGlite (scratchpad): empate com horários diferentes no mesmo dia → mesma faixa nos dois lados.
5. **`exportConsulta` sem CRIAR obrigatório.**
   - Nova assinatura: `exportConsulta(user, spec, format, origin)`, com `origin: "adhoc" | "saved_view"`.
   - `CONSULTAS_CRIAR` só é exigido em `adhoc`. Entidade, campos, escopo e `CONSULTAS_EXPORTAR` valem sempre.
   - A rota `/api/consultas/exportar` (spec vinda do construtor) passa `"adhoc"`. A C2 deve carregar a spec da visão no servidor e chamar com `"saved_view"`, nunca aceitando a origem vinda do cliente.
   - A auditoria registra `origin`.

Arquivos alterados nesta rodada: `lib/consultas/{catalog,types,access,page-access}.ts`, `lib/db/consultas.ts`, `app/api/consultas/exportar/route.ts`, `lib/projects/rates.ts`, a migration (só o `ORDER BY` e o comentário). Testes: `lib/db/consultas.test.ts`, `lib/consultas/views.test.ts`, `lib/projects/rates.test.ts`.

Validação:
- **vitest:** arquivos da fase + `lib/projects`, alinhamento da matriz e `reports.test.ts`: 689/689 (19 arquivos, incluindo os 510 do testador).
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.
- **`prisma validate`:** ok. Precisa de `DATABASE_URL`/`DIRECT_URL` fictícias no ambiente; nenhuma conexão é aberta.

## Fase C1 — veredito do validador

APROVADO COM RESSALVAS (2026-11-26). Nenhum bloqueante/importante. Menores a tratar no início da C2:
1. `metrics` do catálogo (ex.: Receita) não são filtradas por sensibilidade em `visibleCatalog` — precisa antes da IA (C3).
2. Campo "Atividade" (lista) recusa valores legados de `TimeEntry.activityType` em eq/in.
3. (resolvido pelo orquestrador) decisões 5 e 6 incluídas na §1 da especificação.
4. Horas aprovadas em Alocações só somam lançamentos com `allocationId` — explicitar na descrição.
5. Observar desempenho de `::date` sobre as views em produção.

## Fase C2 — dev

### Ressalvas da C1 tratadas primeiro
1. **Métricas por sensibilidade.** `ConsultaMetric.sensitivity` é obrigatório. `visibleCatalog` filtra as métricas pela mesma régua dos campos (`canSeeSensitivity`), então "Receita", "Receita faturada" e "Consumo do orçamento" somem do catálogo sem finanças, inclusive para a IA da C3.
2. **Atividade legada.** As opções agora são o catálogo atual mais `DEPRECATED_ACTIVITY_LABELS`, com o rótulo "(legado)". O campo tem `openOptions: true`: aceita, em eq/in, um código fora da lista desde que tenha forma de código (`^[A-Z][A-Z0-9_]{0,63}$`). As demais listas continuam fechadas.
3. **Horas aprovadas em Alocações.** A descrição e a origem agora dizem que só entram os lançamentos vinculados à alocação (`TimeEntry.allocationId`). Para o total do projeto, a orientação é usar Horas agrupado por projeto.

### Arquivos
Criados:
- `packages/database/prisma/migrations/20261128100000_consultas_abrangencia_visoes/migration.sql`:
  - enums `ConsultaVisualization` e `ConsultaSharing`;
  - tabelas `ConsultaView` e `ConsultaPanel` (geradas por `prisma migrate diff`);
  - 8 views: `consulta_projetos`, `consulta_aprovacoes`, `consulta_despesas`, `consulta_faturamento`, `consulta_pagamentos`, `consulta_skills`, `consulta_certificados` e `consulta_ausencias`.
- `apps/web/src/lib/consultas/saved.ts`: regras puras (Zod de visão/painel, `canOpenShared`, `canOpenView`, `specUsableBy`, `sharingAllowed`, `parsePanelItems`).
- `apps/web/src/lib/consultas/chart.ts`: dados de gráfico puros (disponibilidade, categorias × séries, pizza com "Outros", `niceMax`, `pieArcs`).
- `apps/web/src/lib/db/consultas-saved.ts`: CRUD, listagem, execução e exportação de visões; painéis; auditoria.
- `apps/web/src/app/app/consultas/visoes/actions.ts`: `executarVisao`, `salvarVisao`, `atualizarVisao`, `excluirVisao`, `salvarPainel`, `atualizarPainel`, `excluirPainel`.
- Páginas:
  - `app/app/consultas/visoes/page.tsx`;
  - `app/app/consultas/visoes/[id]/page.tsx`;
  - `app/app/consultas/paineis/page.tsx`;
  - `app/app/consultas/paineis/novo/page.tsx`;
  - `app/app/consultas/paineis/[id]/page.tsx`;
  - `app/app/consultas/paineis/[id]/editar/page.tsx`;
  - `app/app/consultas/paineis/view-options.ts`.
- `apps/web/src/app/api/consultas/visoes/[id]/exportar/route.ts` (GET `?formato=xlsx|csv`) e `app/api/consultas/export-file.ts` (arquivo XLSX/CSV comum às duas rotas).
- Componentes em `components/consultas/`: `ConsultaChart`, `SavedViewRunner`, `SaveViewDialog`, `ViewForm`, `SharingFields`, `ViewOwnerPanel`, `PanelForm`, `SavedItemList`, `ConsultasNav`.
- Testes:
  - `lib/consultas/saved.test.ts`;
  - `lib/consultas/chart.test.ts`;
  - `lib/consultas/c2.test.ts`;
  - `lib/db/consultas-saved.test.ts`;
  - `app/api/consultas/visoes/[id]/exportar/route.test.ts`;
  - `components/consultas/SavedViewRunner.test.tsx`.

Alterados:
- `schema.prisma`: modelos, enums e relações em `User`.
- `lib/consultas/`: `types.ts`, `catalog.ts` (8 entidades novas), `access.ts` (`share`, filtro de métricas), `compile.ts` (escopos `projeto`/`amplo` e `SCOPE_COLUMNS`), `validate.ts` (`openOptions`), `errors.ts` (`NOT_FOUND` → 404).
- `lib/db/consultas.ts`: `runConsulta` e `exportConsulta` recebem `origin`, `meta.viewId` e contexto já carregado.
- `app/api/consultas/exportar/route.ts`: usa `export-file.ts`.
- Páginas `consultas/page.tsx` (abas; sem CRIAR redireciona para Visões; `?visao=` edita a própria visão) e `catalogo/page.tsx` (abas).
- `ConsultaBuilder.tsx`: botão "Salvar como visão".
- Testes ajustados:
  - `catalog.test.ts`: colunas de escopo vêm de `SCOPE_COLUMNS`;
  - `security.test.ts`: escopos `projeto`/`amplo` fecham em FALSE quando devem; entidades irmãs dividem o mesmo code;
  - `ConsultaBuilder.test.tsx`: mock das actions de visões e teste de "Salvar como visão".

### Decisões
- **Escopo de linha por entidade.** Reusa integralmente `resolveReportScope`; cada entidade declara como o escopo se aplica:
  - `pessoa_projeto`: Aprovações e Despesas. Despesas segue o mesmo recorte de `buildExpensesWhere` dos Relatórios.
  - `pessoa_projetos`: Skills, Certificados e Ausências. O PM vê as pessoas alocadas nos seus projetos, com a mesma regra de `consulta_consultores`.
  - `projeto`: Projetos e Faturamento. O PM vê os próprios projetos; "próprio consultor" → FALSE.
  - `amplo`: Pagamentos. A tela de origem é só de FINANCIAL_ROLES/People; fora do escopo amplo → FALSE.
- **Projetos.** `horas_lancadas` é `financeRestricted`, como em Alocações. `horas_orcadas`, `consumo_orcamento` e `valor_hora_padrao` são `financeiro` (FINANCIAL_ROLES protege "budget" e valor-hora).
- **Faturamento** (pré-fatura/receita = `RevenueClosing`): só valores de venda (bruto, ajuste, total), marcados `financeiro`, mais a NFS-e mais recente (emitida tem prioridade). Sem custo nem margem.
- **Pagamentos** (decisão conservadora):
  - entram só PJ e CLT FLEX, igual à tela; a linha é o pagamento do mês;
  - entram etapa, datas do fluxo, `totalAmount` e `invoiceAmount` (não cifrados e visíveis ao Financeiro na tela), como `financeiro`;
  - ficaram de fora: `ConsultantPaymentLine` (valor/hora = custo, só Dados Sensíveis), `cltNetAmount`, `pjAmount`, `benefitAmount`, os valores acordados e as remunerações pontuais (cifrados).
- **Aprovações.** Uma linha por decisão (`Approval`), resolvendo consultor e projeto dos 5 tipos. O comentário de decisão de ausência é omitido, porque pode citar saúde.
- **Ausências e Despesas.** Ficam fora `note`, `decisionComment` e os endereços de milhagem.
- **Skills/Certificados.** São duas entidades sob o mesmo código `CONSULTAS_SKILLS`.
- **Visões salvas.**
  - Visualização gravada em enum EN (`TABLE/BAR/LINE/PIE/INDICATOR`), com rótulos PT na UI.
  - `entity` é duplicada da spec para filtrar a listagem.
  - A spec é gravada normalizada, depois de validada com a permissão do dono.
  - Criar exige CRIAR; ROLES/ALL exige COMPARTILHAR (tornar privada não exige).
  - Alterar e excluir são só do dono. Não há override por papel global: nem ADMIN abre visão privada alheia.
  - Abrir exige compartilhamento + `CONSULTAS` + entidade + spec válida para quem vê. Fora disso, NOT_FOUND, sem distinguir de "não existe".
  - O dono vê a própria visão como "indisponível" quando perde um campo, para poder excluí-la. Se perder a entidade, ela some.
- **Execução e exportação.** `runSavedView`/`exportSavedView` leem a spec do banco e chamam `runConsulta`/`exportConsulta(..., "saved_view")` com o contexto de quem vê. O cliente só manda o id. A auditoria sensível e a de exportação levam `origin` e `viewId`.
- **Painéis.**
  - `items` = `[{ viewId, size: normal|largo }]`, até 24, sem repetição.
  - Ao renderizar, cada visão é revalidada para quem vê; as inacessíveis entram só em `hiddenCount` (sem nome nem id).
  - Criar e editar exigem que toda visão nova esteja aberta para o dono. Itens já gravados são preservados.
  - Cada cartão executa a própria visão via server action, com estados de carregando/erro próprios.
- **Auditoria** (`entityType` `ConsultaView`/`ConsultaPanel`):
  - `CONSULTA_VISAO_CRIADA/ATUALIZADA/COMPARTILHADA/EXCLUIDA`;
  - `CONSULTA_PAINEL_CRIADO/ATUALIZADO/COMPARTILHADO/EXCLUIDO`;
  - o compartilhamento registra o antes e o depois.
- **Gráficos.**
  - Não há lib de gráficos instalada: SVG puro, no padrão de `RadarChart`/`AvailabilityHeatmap`. Nenhuma dependência nova.
  - Barras: até 30 grupos e 3 séries, com suporte a negativos. Linhas: data em ordem cronológica. Pizza: rosca com 8 fatias + "Outros". Indicador: cartões de KPI, com borda/sombra só nesse elemento de alto valor.
  - Cores de preenchimento vêm dos acentos do design system; texto com tons AA.
  - Cada gráfico tem tabela `sr-only` equivalente e `<title>` por marca. Sem animação.
  - Gráfico indisponível explica o motivo (ex.: consulta sem agrupamento).
- **PGlite (só no scratchpad, nada contra `DATABASE_URL`).**
  - Montagem: schema completo via `prisma migrate diff --from-empty`, views da C1 e da C2, e seed cobrindo todas as tabelas.
  - Execução: **2.982 SQLs gerados pelo compilador** (todas as entidades × campos × operadores × 5 escopos, agrupamentos com até 12 medidas e todos os exemplos), **0 falhas**; nenhum `WHERE (FALSE)` trouxe linhas.
  - Valores conferidos:
    - NF emitida prevalece sobre a que falhou;
    - CLT fora de Pagamentos;
    - comentário de ausência nulo;
    - `consumo_orcamento` correto;
    - `project_manager_ids` preenchido.

### Critérios de aceite (C2)
- [x] Entidades Projetos, Aprovações, Despesas, Faturamento (sem custo/margem), Pagamentos (sem custo cifrado), Skills, Certificados e Ausências, cada uma com o seu código da matriz e escopo de linha.
- [x] Visões salvas (modelo próprio com dono, nome, descrição, spec, visualização, compartilhamento PRIVATE/ROLES/ALL, papéis, timestamps); compartilhar exige `CONSULTAS_COMPARTILHAR`; sempre roda com a permissão de quem vê; entidade sem acesso → não aparece.
- [x] Exportação de visão salva por `exportConsulta(..., "saved_view")` com a spec carregada no servidor; exige EXPORTAR, não CRIAR.
- [x] Painéis (≤ 24) com revalidação por visão para quem vê; visão privada/inacessível não aparece nem com nome.
- [x] Gráficos (barras, linhas, pizza, indicador) conforme o design system, sem lib nova.
- [x] Auditoria de criar/compartilhar/excluir (e alterar) visões e painéis.
- [x] Ressalvas 1, 2 e 4 da C1.

### Validação local
- **vitest** (arquivos da fase + alinhamento da matriz): 1.614/1.614, em 19 arquivos.
- **Suíte completa:** 15 falhas em 8 arquivos, idênticas ao baseline.
- **tsc:** só os 10 erros pré-existentes de `inbound.test.ts`.
- **eslint:** limpo.
- **Prisma:** `prisma validate` ok; `npm run db:generate` ok.

### Pendências e riscos
- **Migration:** precisa rodar no deploy (tabelas + 8 views).
- **Desempenho:**
  - `consulta_projetos` soma horas por LATERAL por projeto;
  - `consulta_aprovacoes` faz 5 LEFT JOINs polimórficos (usam as PKs);
  - o timeout de 15s protege; observar em produção.
- **Painel com muitos cartões:** as server actions do Next são enfileiradas por cliente, então 24 cartões carregam em sequência. Se ficar lento, a alternativa é um endpoint de lote.
- **Exportação de visão:** usa link GET com `download`. Um erro (403/404) abre a resposta em texto; o link só aparece quando há EXPORTAR e a visão está disponível.
- **Itens órfãos:** visão excluída continua referenciada nos painéis alheios e entra na contagem de itens indisponíveis. A limpeza fica para o dono ao editar.
- **Faturamento por cliente:** fechamento sem projeto (`projectId` nulo) não aparece para o PM (`project_manager_id` nulo). É coerente com o escopo, mas vale registrar.
- **Pagamentos:** se o Financeiro decidir que o total mensal também é custo sensível, basta mudar `valor_total`/`valor_nf` para `custo_sensivel` no catálogo; a view não muda.

## Fase C2 — testes

### Testes criados (133 casos, 5 arquivos; nenhum código de produção alterado)
- `apps/web/src/lib/consultas/c2-security.test.ts` (59):
  - escopo de linha das 8 entidades novas (PM, próprio consultor, sem universo, amplo, PM+consultor);
  - filtro OU com valor malicioso nunca escapa: `WHERE (escopo) AND ((a) OR (b))` em linhas, contagem e totais;
  - colunas técnicas de escopo não são filtráveis;
  - sem custo cifrado nem dado pessoal: Pagamentos (sem valor-hora, cltNet, pjAmount, benefícios, acordado, banco), Ausências (sem comentário/observação/motivo), Despesas (sem endereços);
  - métricas por sensibilidade;
  - Atividade legada: aceita código e o parametriza; recusa 12 formas de lixo; limite de 64; só `horas.atividade` é lista aberta;
  - regras puras: `canOpenShared`, `canOpenView`, `specUsableBy` (campo financeiro só no filtro), `sharingAllowed`, schemas `.strict()`, ≤ 24, `parsePanelItems`.
- `apps/web/src/lib/db/consultas-saved.security.test.ts` (39):
  - 404 com o mesmo código e a mesma mensagem de "não existe", em 6 cenários: privada alheia, ROLES de outro papel, ALL com campo financeiro (em coluna ou só no filtro), entidade sem acesso, spec adulterada. Em todos, sem executar e sem auditar;
  - ADMIN não abre, não exporta, não altera e não exclui visão privada alheia;
  - não-dono recebe NOT_FOUND, não FORBIDDEN;
  - `userId` nulo nunca é dono;
  - visão do Financeiro aberta pelo PM:
    - campo financeiro → NOT_FOUND;
    - sem campo financeiro → roda com `project_manager_id = db-pm`;
    - Pagamentos com o code → `FALSE`;
  - exportação:
    - exige EXPORTAR e não exige CRIAR;
    - sem permissão, não roda consulta nem audita;
    - auditoria com `origin: saved_view` e o `viewId` do banco;
  - ao criar/editar:
    - entidade e dono nunca vêm do cliente;
    - sem COMPARTILHAR, ROLES e ALL são recusados;
    - papel inexistente é recusado;
    - injeção na spec ao criar é recusada;
    - dono sem CRIAR não troca a spec;
    - auditoria do antes e do depois do compartilhamento;
  - painéis:
    - painel ROLES de outro papel e painel sem módulo não abrem;
    - listagem sem painel privado alheio;
    - a mesma visão aparece para o Financeiro e fica oculta para o PM;
    - visão do próprio dono que ficou indisponível entra só na contagem;
    - JSON com 40 itens consulta só 24;
    - criar exige CRIAR, e compartilhar exige COMPARTILHAR;
    - painel com exatamente 24 itens é aceito;
    - id adivinhado → INVALID, sem citar o nome;
    - ao editar: não-dono recebe NOT_FOUND, item novo inacessível → INVALID, item antigo é preservado;
    - exclusão auditada.
- `apps/web/src/app/app/consultas/visoes/actions.test.ts` (24):
  - `executarVisao` ignora spec e origem extras;
  - 9 ids inválidos são barrados antes da camada de dados, em todas as actions com id;
  - erro inesperado → FAILED, sem detalhe.
- `apps/web/src/components/consultas/ConsultaChart.test.tsx` (8): tabela `sr-only` equivalente.
  - Barras, linhas e pizza: figura nomeada, SVG `aria-hidden` e todos os valores na tabela.
  - Pizza: "Outros" com a soma do restante.
  - Barras com mais de 30 grupos: aviso de grupos omitidos.
  - Indicador em `dl`/`dt`/`dd`.
  - Indisponibilidade explicada em texto.
- `apps/web/src/app/api/consultas/visoes/[id]/exportar/route.origin.test.ts` (3):
  - `origin`, `spec`, `entity` e `viewId` na query não chegam a `exportSavedView`;
  - formato fora do enum → 400;
  - 404 sem nome e sem anexo.

### Resultado
- **Vitest (suíte inteira):** 4.976 passaram, 15 falharam, 1 skip (4.992 em 307 arquivos). As 15 falhas em 8 arquivos são exatamente as do baseline (`next-auth` → `next/server`). Os arquivos novos passam 133/133.
- **tsc (`tsconfig.test.json`):** só os 10 erros pré-existentes de `inbound.test.ts`.
- **eslint:** limpo nos testes novos e nos arquivos da fase.

### Bugs encontrados
- **Bloqueante:** nenhum.
- **Importante:** nenhum.
- **Menor:**
  1. **`lib/db/consultas-saved.ts:577`.** `ownerItems` devolve ao dono do painel (tela `paineis/[id]/editar` → `PanelForm`, no cliente) os ids de TODOS os itens gravados, inclusive de visões que hoje ele não pode abrir (por exemplo, visão de outro dono que virou PRIVATE). Vaza só o id, que o dono já conhecia; nome e spec não saem.
     - Esperado pelo critério: nenhum id de visão inacessível.
     - Obtido: o id chega ao cliente.
  2. **`lib/db/consultas-saved.ts:433` e `:501`.** `updateSavedView`/`deleteSavedView` checam só `isOwner`. O dono que perdeu a ENTIDADE (a visão some da lista dele) ainda consegue, pelo id, renomear a visão e recompartilhá-la como ALL. Não há vazamento de dados: quem abre roda com a própria permissão. Mas contraria "entidade sem acesso → não aparece".
     - Esperado: NOT_FOUND.
     - Obtido: a alteração é gravada.
  3. **Painéis, `:667`.** `updatePanel` não exige CONSULTAS_CRIAR, e `createPanel` exige. A visão segue a mesma linha (metadados sem CRIAR). Falta confirmar se é intencional.
- **Observação (não é bug):**
  - `ConsultaChart.tsx:333`: no cartão compacto do painel, o aviso "veja a tabela" não tem tabela visível no cartão. A tabela `sr-only` cobre só os 30 grupos desenhados.
  - `despesas.valor` é `publico` por decisão; a entidade é ADMIN/FINANCE.

### Cobertura dos critérios C2
- [x] As 8 entidades com code e escopo, inclusive escape por OU; sem custo cifrado nem dado pessoal.
- [x] Visões:
  - PRIVATE / ROLES / ALL;
  - 404 indistinguível, até para ADMIN;
  - COMPARTILHAR;
  - só o dono altera (ressalva no menor 2);
  - spec só do banco;
  - permissão e escopo de quem vê.
- [x] Exportação de visão: EXPORTAR sem CRIAR, `saved_view` fora do controle do cliente, auditoria com `viewId`.
- [x] Painéis:
  - ≤ 24;
  - revalidação por visão e por quem vê;
  - sem nome nem id para quem vê (ressalva no menor 1, só para o dono);
  - auditoria.
- [x] Gráficos com tabela acessível equivalente.
- [x] Ressalvas 1 e 2 da C1 (métricas por sensibilidade; Atividade legada aceita código e recusa lixo).

## Fase C2 — correções

1. **Painel em edição não envia ids de visões inacessíveis** (`getPanelForViewer` e `updatePanel`).
   - `ownerItems` agora traz só as visões que o dono abre hoje. As demais (excluídas, privadas alheias, de entidade ou campo sem acesso) chegam ao cliente apenas como contagem (`hiddenCount`).
   - O `PanelForm` mostra "N visões deste painel não estão disponíveis para você" e oferece a caixa "Remover as N visões indisponíveis".
   - **Decisão: o padrão é manter.** As indisponíveis vão para o fim do painel, e o dono pode removê-las em bloco (`keepUnavailable: false`). Motivo: a indisponibilidade pode ser só para o dono, e outros que veem o painel ainda podem abri-las.
   - O servidor calcula as indisponíveis por conta própria. Todo item enviado pelo cliente precisa estar aberto para o dono; reenviar o id de uma indisponível → INVALID.
   - O teto de 24 conta também as mantidas.
   - A auditoria registra `unavailableKept` e `unavailableRemoved`.
2. **Alterar ou recompartilhar visão exige acesso atual do dono.** `updateSavedView` usa a mesma regra de abertura: `CONSULTAS`, entidade liberada e spec válida para o dono. Sem isso, devolve o mesmo NOT_FOUND de "não existe". **Excluir** continua liberado ao dono sem esse acesso, para limpeza.
3. **Editar painel exige `CONSULTAS_CRIAR`**, como criar (FORBIDDEN sem ele).
4. **Aviso de grupos omitidos no gráfico.**
   - No cartão compacto do painel, que não tem tabela visível, o aviso agora diz "abra a visão para ver todos ou exporte".
   - Na página da visão, onde há tabela logo abaixo, diz "veja a tabela abaixo ou exporte".

Arquivos:
- `lib/db/consultas-saved.ts`: helper `unavailableItems`, `checkPanelItems` sem a exceção `keep`, `SavePanelInput.keepUnavailable`.
- `app/app/consultas/visoes/actions.ts`: `PainelForm.keepUnavailable`.
- `components/consultas/PanelForm.tsx` e `app/app/consultas/paineis/[id]/editar/page.tsx` (`unavailableCount`).
- `components/consultas/ConsultaChart.tsx`.

Testes:
- `consultas-saved.security.test.ts`:
  - ajustado o caso "item já gravado é preservado" para a nova regra (manter no fim ou remover em bloco; reenviar id inacessível → INVALID);
  - novos casos: editar painel sem CRIAR → FORBIDDEN; `ownerItems` sem ids nem nomes inacessíveis; dono sem a entidade ou com spec inválida → 404 ao alterar, mas exclui.
- `ConsultaChart.test.tsx`: aviso do modo compacto vs. página.

Validação:
- **vitest** (fase + alinhamento da matriz): 1.751/1.751, em 24 arquivos.
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.

## Fase C2 — veredito do validador

APROVADO COM RESSALVAS (2026-11-26). Nenhum bloqueante/importante. Menores a tratar no início da C3:
1. Datas de timestamps convertidas em UTC (`::date`) em vez de São Paulo: C2 migration :110, :147, :307 e C1 migration :237 — corrigir nas próprias migrations (ainda não aplicadas).
2. Regra única de edição: painel exige CRIAR, visão não — unificar e esconder/bloquear edição na UI sem CRIAR.
3. `LIST_LIMIT` aplicado antes do filtro por entidade — filtrar `entity IN (liberadas)` no where.
4. `horas_ate_decisao` pode ser negativo — GREATEST(...,0) ou null.
5. Observar desempenho de consulta_projetos / consulta_aprovacoes em produção.

## Fase C3 — dev

### Ressalvas da C2 tratadas primeiro
1. **Fuso nas views** (migrations C1/C2 editadas no lugar, continuam aditivas): `c."createdAt"` (C1 `consulta_consultores.cadastrado_em`), `p."createdAt"` (`consulta_projetos.cadastrado_em`), `cs."createdAt"` (`consulta_aprovacoes.data_referencia`) e `cs."updatedAt"` (`consulta_skills.atualizado_em`) agora são `((x AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date`. Datas de calendário (`date`, `startDate`, `issuedAt`, `lastUsedAt`...) continuam `::date`. Conferido no PGlite: `createdAt = 2026-11-27T01:30Z` → `2026-11-26`.
2. **Regra única de edição:** alterar visão agora exige `CONSULTAS_CRIAR`, como painel; excluir continua liberado ao dono (limpeza). UI: sem CRIAR, a página da visão troca os "Ajustes" por `OwnerDeleteControl` (só excluir); no painel o link vira "Gerenciar painel" e a página de edição mostra só a exclusão.
3. **`LIST_LIMIT` depois do filtro de entidade:** `listSavedViews` filtra `entity IN (liberadas)` no `where` do banco.
4. **`horas_ate_decisao`:** `CASE WHEN decisão >= envio THEN ... END` → NULL quando o registro foi reenviado depois da decisão (nunca negativo).

### Arquivos
Criados:
- `packages/database/prisma/migrations/20261129100000_consultas_ia_agendamento/migration.sql` (gerada por `prisma migrate diff` + CHECK visão XOR painel): enums `ConsultaScheduleFrequency`/`ConsultaScheduleRunStatus`, tabelas `ConsultaSchedule`, `ConsultaScheduleRun` (UNIQUE `scheduleId, windowKey`) e `ConsultaAiUsage` (UNIQUE `userId, windowStart`).
- `apps/web/src/lib/consultas/ai.ts` (puro: catálogo do prompt, instruções, parse/validação da saída, orquestração 1+1, explicação determinística), `schedule.ts` (puro: Zod, fuso via Intl, ocorrências/janelas, status), `xlsx-sheets.ts` (abas comuns à exportação e ao envio; `safeFilename` movido para cá).
- `apps/web/src/lib/db/consultas-ai.ts` (permissão, rate limit persistido, auditoria), `lib/db/consultas-schedules.ts` (cadastro + job).
- `apps/web/src/app/api/jobs/consultas-agendadas/route.ts`; `app/app/consultas/agendamentos/{page.tsx,actions.ts,novo/page.tsx,[id]/page.tsx}`.
- Componentes: `ConsultaAssistant.tsx`, `ScheduleForm.tsx`, `OwnerDeleteControl.tsx`.
- Testes: `lib/consultas/{ai,schedule,c3}.test.ts`, `lib/db/{consultas-ai,consultas-schedules}.test.ts`, `app/api/jobs/consultas-agendadas/route.test.ts`, `components/consultas/ConsultaAssistant.test.tsx`.

Alterados: `schema.prisma` (3 modelos, 2 enums, relações em User/ConsultaView/ConsultaPanel); `lib/consultas/access.ts` (`schedule`, `ai` — `ai` exige também CRIAR); `lib/db/consultas.ts` (`buildConsultaContext(user, matrix)` para jobs sem sessão; `meta.scheduleId` na auditoria); `lib/db/reports.ts` (`resolveReportScope(user, matrix?)` — sem a matriz segue lendo a da sessão, comportamento idêntico); `lib/db/consultas-saved.ts`; `lib/automation/email/templates.ts` (`buildConsultaAgendadaEmail`); `app/api/consultas/export-file.ts`; `ConsultaBuilder.tsx` (prop `assistant`), `ConsultasNav.tsx` (aba Agendamentos), páginas de visão/painel (link "Agendar envio"), `consultas/page.tsx`; testes da C2 ajustados à regra nova (`c2.test.ts`, `consultas-saved*.test.ts`) e `jobs-route-contract.test.ts`.

### Decisões
- **Assistente:** só aparece com `CONSULTAS_IA` + `CONSULTAS_CRIAR` (a spec é ad hoc). O prompt recebe `buildPromptCatalog(visibleCatalog(access))`: key, rótulo, tipo, descrição, opções, agregações, métricas visíveis e até 2 exemplos por entidade (já podados). Nunca view/coluna/origem/código de permissão, nunca dados. `json: true` + "JSON" no system. A saída passa por Zod (mensagem do 1º issue para a retentativa) + `validateConsulta` com o acesso do usuário. FORBIDDEN vira aviso genérico na retentativa (não revela o campo oculto). Uma retentativa com o erro; depois "Não consegui montar…". `{"error": …}` = fora do catálogo, sem insistir. A explicação é gerada por `explainSpec` a partir da spec validada. Nada roda sem "Confirmar e rodar" (ou "Ajustar no construtor"); a execução vai pelo `executarConsulta` normal, que revalida tudo.
- **Rate limit (persistido):** tabela `ConsultaAiUsage`, contador por usuário por minuto via `INSERT … ON CONFLICT DO UPDATE … RETURNING` (atômico entre instâncias); 5/min e 40/hora (soma da última hora, checada antes de incrementar); 1 unidade por pedido (não por tentativa); limpeza oportunista de >24h do próprio usuário. Provider não configurado → "indisponível" sem consumir cota.
- **Log de uso:** `AuditEvent` `CONSULTA_IA_USADA` (`entityType: Consulta`) com desfecho, tentativas, entidade e modelo — **sem o texto** do usuário (nem trecho).
- **Agendamento:** visão OU painel; diário/semanal/mensal (dia 29–31 → último dia em meses curtos), hora cheia em São Paulo (via `Intl`). Destinatários = ids de usuários ATIVOS (≤ 50), nunca e-mail livre. Criar/alterar exigem `CONSULTAS_AGENDAR` e que o alvo esteja aberto para quem agenda; só o dono altera/exclui (sem override por papel); excluir não exige AGENDAR. `activeSince` reinicia ao criar, reativar ou mudar horário: ocorrência anterior nunca é enviada. Auditoria `CONSULTA_AGENDAMENTO_CRIADO/ATUALIZADO/EXCLUIDO` (antes/depois).
- **Job:** janela = dia (diário/semanal) ou mês (mensal); só a ocorrência mais recente já vencida. Claim = `create` do run (UNIQUE) ou `updateMany` condicional que assume RUNNING com lease vencido (10 min) ou FAILED com tentativas < 3. Progresso salvo por destinatário; retentativa não reenvia a quem já recebeu. Lote de 20 execuções por chamada.
- **Permissão por destinatário:** para cada um, matriz dele (`loadPermissionMatrixForUser`) + `resolveReportScope(user, matrix)` + Dados Sensíveis pelos papéis dele → `buildConsultaContext`. O job não lê a matriz da sessão (teste garante). É preciso: `CONSULTAS`, **`CONSULTAS_EXPORTAR`** (receber planilha é exportar — decisão conservadora), abrir a visão (compartilhamento + entidade) e todos os campos da spec. Senão, `SKIPPED` com motivo (`sem_permissao_exportar`, `sem_acesso_visao`, `campo_sem_permissao`, `sem_acesso_painel`, `nenhuma_visao_acessivel`, `usuario_inativo`…), registrado no run e no `AuditEvent` `CONSULTA_AGENDAMENTO_EXECUTADO`. Do criador só se exige autoridade (ativo + `CONSULTAS` + `CONSULTAS_AGENDAR`); sem ela o envio fica suspenso. Visão privada do criador só chega ao próprio criador.
- **Arquivo:** um e-mail por destinatário (o conteúdo difere por permissão), XLSX em base64 pelo `getEmailTransport()` existente. Painel: uma aba por visão acessível + aba "Totais" (Visão/Medida/Total); visões ocultas só entram como contagem no e-mail. Exportação auditada como `CONSULTA_EXPORTADA` com o destinatário como ator, `origin: saved_view`, `viewId` e `scheduleId`. Template novo `buildConsultaAgendadaEmail` no padrão de `templates.ts` (sem novo tipo de evento/template editável).
- Nenhuma dependência nova no projeto (PGlite só no scratchpad).

### Critérios de aceite (C3)
- [x] Assistente (`CONSULTAS_IA`): linguagem natural → spec via `getAiTextProvider()`, catálogo filtrado (campos E métricas), mesma validação Zod + permissão, 1 retentativa, desistência amigável, explicação determinística, confirmação antes de rodar, oculto sem CRIAR, "indisponível" sem provider.
- [x] Rate limit por usuário persistido no banco (atômico, multi-instância); uso logado sem o texto.
- [x] Envio agendado (`CONSULTAS_AGENDAR`) de visão/painel com XLSX anexo, diário/semanal/mensal em hora de SP, destinatários = usuários.
- [x] Job `/api/jobs/consultas-agendadas` com contrato `CRON_SECRET` (GET = POST), idempotente por janela (UNIQUE) com lease/claim no banco.
- [x] Execução com a permissão de cada destinatário; sem acesso → pulado e registrado; nunca a permissão do criador.
- [x] Auditoria de criar/alterar/excluir agendamento (e de cada execução).
- [x] Ressalvas 1–4 da C2.

### Validação local
- **vitest** (fase + jobs + auth + e-mail + IA): 2.107/2.107 em 57 arquivos (novos C3: 64 casos).
- **tsc:** só os 10 erros pré-existentes de `inbound.test.ts`.
- **eslint:** limpo nos diretórios/arquivos da fase.
- **Prisma:** `prisma validate` ok; `npm run db:generate` ok.
- **PGlite (scratchpad, nada contra `DATABASE_URL`):** schema-base + migrations C1, C2 (views) e C3 aplicadas; as 11 views executam; UPSERT do rate limit devolve 1, 2, 3; UNIQUE do run e CHECK visão XOR painel barram.

### Pendências e riscos
- **Agendador:** o Railway não tem os crons (ADR17). Criar um cron chamando `GET /api/jobs/consultas-agendadas` com `Authorization: Bearer $CRON_SECRET` a cada 15 min (o job tolera chamadas repetidas). Sem isso nada é enviado.
- **E-mail:** sem `EMAIL_PROVIDER=resend` o transporte é o console (nada sai). Anexo grande (50.000 linhas × várias abas de painel) pode passar do limite do provedor; não há teto de tamanho por enquanto.
- **Duração:** `maxDuration = 300`, lote de 20 execuções e consultas com timeout de 15s cada. Painéis grandes com muitos destinatários podem precisar de lotes menores.
- **`CONSULTAS_EXPORTAR` obrigatório para receber:** PM (sem EXPORTAR por padrão) é pulado. Se o produto quiser PM recebendo, basta conceder EXPORTAR na Matriz ou rever a decisão.
- **IA:** qualidade depende do modelo; o catálogo completo vai no prompt (~dezenas de KB para quem vê tudo). Se o custo pesar, enviar só a entidade provável num 1º passo.
- **Rate limit por hora** soma janelas sem lock: dois pedidos simultâneos no limite podem passar 1 a mais (o do minuto é atômico).
- Migrations C1/C2/C3 precisam rodar no deploy, nesta ordem.

## Fase C3 — testes

### Testes criados (4 arquivos, 97 casos: 95 passam + 2 `it.fails` que documentam achados; nenhum código de produção alterado)
- `apps/web/src/lib/consultas/c3-ai-security.test.ts` (36):
  - **varredura do prompt por perfil**, com a matriz padrão da §2 (PM, FINANCE, PEOPLE, AREA_MANAGER e ADMIN, nenhum com Dados Sensíveis). Em todas as tentativas:
    - entidades e campos = exatamente os de `visibleCatalog`;
    - campo/entidade oculto ausente por key, rótulo e `"field"` dos exemplos;
    - sem view, `permissionCode`, colunas de escopo (`*_id`), `source`, `column` ou `sensitivity`;
    - métricas só da sensibilidade permitida, e fórmula oculta ausente;
    - todo exemplo passa por `validateConsulta` do próprio perfil;
    - system idêntico para todos e sem catálogo;
  - **prompt injection**:
    - "ignore as regras" + IA obediente → recusada nas duas tentativas, desiste;
    - a retentativa não cita o campo nem a entidade;
    - campo oculto só no filtro, no sort ou na medida → recusado;
    - SQL em entidade, campo, operador, logic, agg ou dir → inválido;
    - chaves `sql`/`scope` → inválidas;
    - valor malicioso em campo visível vira só VALOR (a spec não carrega escopo);
    - array ou spec embrulhada → inválido;
  - **robustez**: inválida→null = indisponível (2 tentativas); JSON truncado 2× = desiste; a spec devolvida é a normalizada;
  - **explicação**: OU, entre com data relativa e ISO, rótulo de lista, is_null, granularidade, ordenação por medida, limite, sem agrupamento/sem filtros; nunca cita campo fora da spec.
- `apps/web/src/lib/consultas/c3-schedule-rules.test.ts` (18), regras de São Paulo:
  - 23h e 00h atravessando o dia UTC;
  - borda exata (≤ now);
  - dia 31 em mês de 30 e em fevereiro (2027 e 2028 bissexto);
  - virada de mês às 22h (01/12 01:30Z → janela de novembro);
  - semanal: domingo×segunda na virada UTC, virada de ano, chaves distintas por semana;
  - mensal criado após a ocorrência → só no mês seguinte;
  - job parado → só a ocorrência mais recente;
  - Zod: hora, dia, frequência, ids com injeção, 50/51 destinatários, `ownerId` extra;
  - `runStatus`.
- `apps/web/src/lib/db/consultas-schedules.c3-security.test.ts` (26):
  - **Permissões e escopo**:
    - `resolveReportScope` recebe o usuário (id e papéis do banco) e a matriz DE CADA destinatário;
    - a matriz do criador é lida só para autoridade;
    - sessão nunca é usada;
    - destinatário sem o módulo → `sem_acesso_consultas`;
    - matriz ilegível → FAILED só para ele;
    - ROLES de outro papel → pulado;
    - spec adulterada → nada enviado.
  - **Criador sem autoridade** (sem AGENDAR, sem módulo, inativo ou removido) → nada consultado nem enviado, todos `criador_sem_permissao`. Alvo excluído → `alvo_excluido`.
  - **Idempotência**:
    - 2 jobs concorrentes (`Promise.all`) → 1 e-mail por destinatário;
    - retomada após crash (lease vencido) não reenvia nem reavalia quem já recebeu;
    - lease válido não é assumido;
    - progresso gravado após cada destinatário;
    - nova janela → novo envio;
    - lote respeita `batch` sem perder janela.
  - **Painel**:
    - XLSX aberto com exceljs: abas só das visões acessíveis (PM: 2 de 5; FINANCE: 3);
    - os nomes das inacessíveis não aparecem em abas, células, texto, HTML, assunto nem auditoria;
    - painel PRIVATE/ROLES → `sem_acesso_painel`;
    - nenhuma acessível → `nenhuma_visao_acessivel`.
  - **E-mail e auditoria**:
    - auditoria da execução sem e-mail, nome do alvo ou dados;
    - HTML escapado (nome com `<script>`);
    - anexo sem `../`;
    - job e rota não importam guards/sessão.
- `apps/web/src/lib/db/consultas-ai.c3-security.test.ts` (18):
  - **Permissão**:
    - IA+CRIAR sem módulo → FORBIDDEN, sem cota/auditoria;
    - injeção no pedido não amplia o catálogo (o catálogo segue o perfil, não o texto);
    - sucesso não executa SQL de dados.
  - **Auditoria sem o texto do usuário**, nos 5 desfechos (ok, gave_up, cannot_answer, unavailable/provider null, rate_limited). Varre auditoria, SQL e `console.*`.
  - **Rate limit**:
    - por hora: 39 passa, 40 bloqueia;
    - SUM parametrizado por usuário e janela;
    - borda do minuto UTC;
    - Retry-After 1s e 50s;
    - um único statement atômico, com userId só como parâmetro;
    - limpeza só do próprio usuário (>24h), e falha nela não bloqueia;
    - pedido >500 ou não-string → sem cota.
- **Verificação extra no PGlite** (no scratchpad, nada contra `DATABASE_URL`). Migrations atuais C1 + views C2 + C3:
  - `Project.createdAt = 2026-12-01T02:59Z` → `cadastrado_em = 2026-11-30`;
  - `Consultant.createdAt = 2026-11-27T01:30Z` → `2026-11-26`;
  - decisão anterior ao reenvio → `horas_ate_decisao = NULL`, e posterior → `3.5`.
  - As demais conversões `::date` são de datas de calendário gravadas à meia-noite UTC (correto manter).

### Resultado
- **Vitest (suíte inteira):** 5.141 passaram, 15 falharam, 2 *expected fail* (os achados), 1 skip, em 318 arquivos. As 15 falhas em 8 arquivos são exatamente o baseline `next-auth` → `next/server`. Os 4 arquivos novos: 95/95, mais 2 `it.fails`.
- **tsc (`tsconfig.test.json`):** só os 10 erros pré-existentes de `inbound.test.ts`.
- **eslint:** limpo nos testes novos e nos arquivos da fase.

### Bugs encontrados
- **Bloqueante:** nenhum.
- **Importante:** nenhum.
- **Menor:**
  1. **`lib/consultas/catalog.ts:708`.** A fórmula da métrica "% de ocupação" (Consultores) é `SOMA(Allocation.allocationPercent) …` e vai ao prompt da IA, com nome físico Model.campo. Não vaza dado nem campo proibido, mas contraria "prompt sem nomes físicos".
     - Esperado: fórmula em termos de negócio (ex.: `SOMA(% alocado)`).
     - Documentado em `it.fails` (`c3-ai-security.test.ts`).
  2. **`lib/consultas/schedule.ts:172` + `lib/db/consultas-schedules.ts:385`.** A janela do mensal é o mês, e a do diário é o dia. Se o dono muda o dia ou a hora DEPOIS do envio da janela, `activeSince` reinicia, mas a nova ocorrência cai na mesma `windowKey`, que já está SENT.
     - Exemplo: mensal do dia 5 enviado; o dono muda para o dia 20 → ninguém recebe neste mês. O mesmo vale para o diário das 8h alterado para 18h no mesmo dia.
     - Esperado: enviar a nova ocorrência (ex.: `windowKey` com dia/hora, ou incluir `activeSince` na chave). Obtido: nada.
     - Documentado em `it.fails` (`consultas-schedules.c3-security.test.ts`).
- **Observações (não bloqueiam):**
  - `catalog.ts:240`: a descrição da entidade Horas, enviada a quem não tem finanças (PM), menciona "o valor-hora de venda vigente na data". É só o conceito, sem campo nem dado.
  - `scheduleInputSchema.name` aceita quebras de linha e caracteres de controle, que vão para o assunto do e-mail. O transporte Resend é JSON, então não há injeção de cabeçalho, mas vale normalizar.
  - `getScheduleFormOptions` entrega a quem tem AGENDAR a lista de todos os usuários ativos com e-mail (até 2.000). É coerente com destinatário = usuário, mas é um diretório completo.

### Cobertura dos critérios C3
- [x] Assistente:
  - prompt só com `visibleCatalog` (varrido por 5 perfis), sem nomes físicos (ressalva no menor 1) e sem dados;
  - saída com campo/entidade proibido recusada sem revelar;
  - retentativa única e desistência amigável;
  - injection não altera o escopo;
  - sem IA/CRIAR/módulo → indisponível ou FORBIDDEN;
  - provider null tratado;
  - explicação determinística, e nada roda sem confirmar.
- [x] Rate limit no banco: minuto atômico, hora, Retry-After, limpeza. A auditoria nunca leva o texto.
- [x] Agendamento:
  - matriz, escopo e papéis por destinatário;
  - sem acesso/EXPORTAR → pulado e registrado;
  - criador sem autoridade → não envia;
  - idempotência por janela (concorrência, retomada, retry);
  - janelas de SP (virada de mês, dia 31, fevereiro, semanal);
  - CRON_SECRET (testes do dev);
  - sem sessão.
  - Ressalva no menor 2: mudança de horário dentro da mesma janela.
- [x] Painel agendado: só abas acessíveis, sem nomes das inacessíveis (planilha, e-mail e auditoria).
- [x] Ressalvas da C2:
  - fuso nas views (conferido no PGlite);
  - regra única de edição (servidor + UI);
  - filtro de entidade antes do limite;
  - `horas_ate_decisao` nunca negativo (PGlite).

## Fase C3 — correções

1. **Nome físico no prompt da IA.** A fórmula de "% de ocupação" (Consultores) passou de `SOMA(Allocation.allocationPercent)…` para `SOMA(% alocado) das alocações ativas`. O prompt já não levava `source`/`column`/`view`. Teste novo em `ai.test.ts` monta o prompt com acesso TOTAL (todas as entidades, finanças e Dados Sensíveis) e varre por `Tabela.coluna` e crases: nenhuma ocorrência. O `it.fails` do testador em `c3-ai-security.test.ts` virou `it` e passa.
2. **Mudar dia/hora não silencia mais a nova ocorrência.** A janela (`windowKey`) passou a ser a ocorrência efetiva, `aaaa-mm-ddTHH` (data + hora em SP), em todas as frequências (antes: dia, ou mês no mensal).
   - Idempotência mantida: a mesma ocorrência gera a mesma chave (UNIQUE do run).
   - Regra mantida: ao criar, reativar ou mudar horário, `activeSince` reinicia, e ocorrências já passadas continuam fora.
   - Nome do anexo continua só com a data (`…_aaaa-mm-dd.xlsx`).
   - O `it.fails` do mensal (dia 5 → 20 no mesmo mês) virou `it` e passa. Teste novo do diário: 08h enviado, muda para 10h às 09:30, nada antes das 10h, envia às 10h e não repete (`runs` = `…T08`, `…T10`).
   - Asserções de janela dos testes (meus e do testador) ajustadas ao formato novo; as de período comparam o prefixo (`aaaa-mm-dd` / `aaaa-mm`), preservando a intenção.
3. **Nome do agendamento (assunto do e-mail).** O Zod recusa caracteres de controle C0/C1, DEL e U+2028/U+2029, inclusive CR, LF e TAB ("O nome não pode ter quebras de linha nem caracteres de controle."). Como defesa em profundidade, `buildConsultaAgendadaEmail` normaliza o nome para uma linha só antes de montar assunto, título e corpo (vale para registros antigos). Testes: 6 nomes maliciosos recusados; assunto sem CR, LF ou U+2028 para um nome legado com `\r\nBcc:`.

Arquivos: `lib/consultas/catalog.ts`, `lib/consultas/schedule.ts`, `lib/db/consultas-schedules.ts` (nome do anexo), `lib/automation/email/templates.ts`. Testes: `lib/consultas/{ai,schedule,c3-schedule-rules,c3-ai-security}.test.ts` e `lib/db/consultas-schedules{,.c3-security}.test.ts`.

Validação:
- **vitest** (fase, jobs, auth, e-mail e IA): 2.210/2.210, em 61 arquivos; nenhum `it.fails` restante.
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.

## Fase C3 — ajustes do teste real

1. **Vocabulário de datas relativas.** As âncoras novas são `fim_mes`, `inicio_mes_anterior`, `fim_mes_anterior`, `inicio_ano`, `inicio_ano_anterior` e `fim_ano_anterior`. Elas se somam a `hoje`, `inicio_semana` e `inicio_mes`, são resolvidas no dia de São Paulo, e `offsetDays` continua somando dias à âncora.
   - **Fonte única:** `RELATIVE_ANCHORS` (`types.ts`) alimenta o Zod (`spec.ts`), o construtor (rótulos PT-BR em `RELATIVE_DATE_LABELS`, que o `FilterEditor` já lista), a explicação determinística e o prompt.
   - **Prompt:** lista as âncoras e dá exemplos — "mês passado" = `between [inicio_mes_anterior, fim_mes_anterior]`, "este mês", "este ano" = `gte inicio_ano`, "ano passado" e "últimos 30 dias". Também orienta a preferir âncoras a contas com `offsetDays`.
   - **ESPECIFICAÇÃO §5:** atualizada com `RelativeAnchor` e a semântica.
   - **Testes de borda (`dates.test.ts`):**
     - virada de ano no fuso de SP (31/12 23:30 SP = 01/01 em UTC);
     - fevereiro com 28 e com 29 dias;
     - dia 31 com mês anterior de 30 dias;
     - "mês passado" inclui o dia 1º;
     - `offsetDays` sobre as âncoras;
     - toda âncora tem rótulo.
2. **Troca silenciosa de métrica.** Regra nova no prompt: nunca substituir o que foi pedido por medida parecida (ex.: receita → horas). Se algum campo, métrica ou entidade necessária não estiver no catálogo fornecido, a IA deve responder `{"error": "fora do catálogo"}`.
   - Esse caso cai em `cannot_answer`, com a mensagem fixa `AI_FRIENDLY.cannotAnswer`; o texto da IA nunca chega ao usuário.
   - Testes com provider mockado, em `ai.test.ts` e `consultas-ai.test.ts`: PM pede "receita por projeto" e recebe `CANNOT_ANSWER` sem citar "receita"; a cota consumida é de 1 chamada.
   - Os testes também checam se a regra está no system prompt.

Arquivos: `lib/consultas/{types,spec,dates,ai}.ts`, `docs/consultas/ESPECIFICACAO.md`. Testes: `lib/consultas/{dates,ai}.test.ts`, `lib/db/consultas-ai.test.ts`.

Validação:
- **vitest** (fase, jobs, auth, e-mail e IA): 2.220/2.220, em 61 arquivos.
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.

**Risco:** a regra 10 depende de o modelo obedecer. Se ainda trocar a métrica, o próximo passo é um aviso explícito comparando o pedido com as medidas da spec.

- **Reteste (próximo mês):** novas âncoras `inicio_proximo_mes`/`fim_proximo_mes` em `RELATIVE_ANCHORS` (Zod, construtor, explicação, prompt com exemplo "próximo mês") e na §5 da spec. Testes de borda cobrem dezembro→janeiro (inclusive 31/12 23:30 em SP) e janeiro→fevereiro bissexto. Vitest 2.221/2.221; tsc só os 10 erros pré-existentes; eslint limpo.

## Fase C3 — correções 2

1. **(Importante) Posse do run + renovação do lease.**
   - `ConsultaScheduleRun.claimToken`: o claim (create ou takeover) gera um token com `randomUUID`.
   - Progresso e fechamento só gravam com `updateMany where { id, claimToken, status: RUNNING }` e `count === 1`. O fechamento também zera o token.
   - `saveProgress` renova `leaseUntil` (relógio do job + 10 min) **antes de cada envio** e após cada destinatário.
   - Se perdeu a posse, lança `LostClaimError`: o loop aborta sem enviar mais e esse worker não grava o final nem audita. O resumo ganhou o campo `lost`.
   - Teste: o worker antigo envia a `u-fin`, grava e "trava" 11 min; o cron novo assume com lease vencido, vê `u-fin` como SENT e envia só a `u-pm`. O antigo perde a posse antes do próximo envio. Resultado: 1 e-mail por destinatário, run final do worker novo (SENT, tentativa 2, token nulo) e uma única auditoria de execução.
2. **Rate limit:** o UPSERT ficou condicional (`DO UPDATE … WHERE count < limite RETURNING`). Pedido bloqueado no minuto não incrementa, logo não consome a cota da hora. Conferido no PGlite: 1..5, depois sem linha, contador parado em 5.
3. **Job sem teto de 1000:** os agendamentos ativos são percorridos em páginas de 500 por id (cursor). Teste com 1.203 agendamentos: todos verificados.
4. **Migration:** CHECKs de faixa para `hour` (0–23), `weekday` (1–7 ou nulo) e `monthDay` (1–31 ou nulo), mais a coluna `claimToken`. A migration é da própria C3, ainda não aplicada. Conferido no PGlite.
6. **Excluir visão/painel com agendamentos.**
   - Decisão: excluir com confirmação. A UI avisa "N envio(s) agendado(s) que a/o usa(m) também será(ão) removido(s)", com a contagem via `countSchedulesForTarget`, só para o dono.
   - A remoção continua atômica, pelo FK em cascata.
   - Auditoria: o evento de exclusão da visão/painel registra `schedulesRemoved`, e cada agendamento removido ganha um `CONSULTA_AGENDAMENTO_EXCLUIDO` (`reason: visao_excluida | painel_excluido`). Coberto por teste.
7. **Formulário de agendamento:** usuários vão ao cliente só com id e nome (`select` sem e-mail); a busca é por nome. Coberto por teste.
8. **Assistente:** a rejeição da server action (rede/servidor) vira a mensagem fixa "Não foi possível falar com o assistente agora…", e o construtor continua. Coberto por teste.

Arquivos:
- **Código:** `schema.prisma`, a migration C3, `lib/db/{consultas-schedules,consultas-ai,consultas-saved}.ts`, `components/consultas/{OwnerDeleteControl,ViewOwnerPanel,PanelForm,ScheduleForm,ConsultaAssistant}.tsx` e as páginas `visoes/[id]` e `paineis/[id]/editar`.
- **Testes:** os mocks de run/usuário/agendamento foram ajustados (inclusive nos testes do testador: progresso agora grava também antes do envio).

Validação:
- **vitest** (fase, jobs, auth, e-mail e IA): 2.227/2.227, em 61 arquivos.
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.
- **`prisma validate`:** ok, com env fictícia.
- **`db:generate`:** ok.

## Fase C3 — correções 3

1. **Garantia de entrega: at-least-once.** A idempotência é por janela: uma janela concluída não é reprocessada, e quem consta como SENT não recebe de novo numa retentativa ou retomada.
   - Não é exactly-once: se o processo cair entre `transport.send` e a gravação do progresso, aquele destinatário pode receber o mesmo arquivo outra vez. Envio por provedor externo e gravação no banco não podem ser atômicos.
   - Os comentários de `consultas-schedules.ts` (cabeçalho, progresso e `runConsultaSchedules`) foram corrigidos para dizer isso.
2. **Posse conferida logo antes do `transport.send`.** Depois de `buildWorkbook` e do template, o `saveProgress` confere o token e renova o lease. Se a posse foi perdida, `LostClaimError` (agora relançado pelo `catch` por destinatário) aborta sem enviar. Teste: run reassumido durante a geração → nenhum e-mail, `lost: 1`, e o run fica do outro worker.
3. **Erro inesperado não perde os SENT desta tentativa.** `executeRun` preenche `outcomes` por referência. No `catch`, quem já recebeu nesta tentativa ou em anteriores continua SENT (e SKIPPED continua SKIPPED); só quem não foi concluído vira FAILED, que é retentável. Teste: falha transitória do Prisma logo após enviar a `u-fin` → run FAILED com `u-fin` SENT; no retry só `u-pm` recebe.

Testes do testador ajustados: o de progresso agora exige que "u-fin SENT" seja gravado antes de qualquer trabalho para "u-pm", tolerando as gravações de posse anteriores.

Validação:
- **vitest** (fase, jobs, auth, e-mail e IA): 2.229/2.229, em 61 arquivos.
- **tsc:** só os 10 erros pré-existentes.
- **eslint:** limpo.

## Fase C3 — veredito do validador

1ª validação: APROVADO COM RESSALVAS (1 importante: posse/lease do run de agendamento → envio duplicado em run > 10 min).
Revalidação após "correções 2": APROVADO COM RESSALVAS — menores (at-least-once não documentado, posse antes do envio, SENT perdidos em erro inesperado) corrigidos em "correções 3" e conferidos pelo orquestrador (suíte: só as 15 falhas de baseline; tsc só baseline).
Teste real do assistente contra o DeepSeek (orquestrador): 5 perguntas, 1 tentativa cada, ~1,4 s; datas relativas exatas; PM pedindo receita → cannot_answer; prompt injection → cannot_answer.
Pendências de deploy: cron no Railway para `/api/jobs/consultas-agendadas`; `EMAIL_PROVIDER=resend`; migrations C1/C2 foram editadas no lugar antes de qualquer aplicação — confirmar que nenhum ambiente as aplicou.

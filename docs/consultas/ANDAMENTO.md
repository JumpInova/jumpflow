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
| C2 | pendente | — |
| C3 | pendente | — |

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

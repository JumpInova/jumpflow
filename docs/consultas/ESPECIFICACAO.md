# Consultas — Especificação

Módulo de consultas personalizadas do JumpFlow: o usuário monta relatórios próprios
(filtros, cruzamento de tabelas, agrupamentos e somas) sobre um **catálogo de dados**
que explica o significado de cada entidade e campo.

Referência de origem: módulo "Consultas" do Jump PM (`/Volumes/KINGSTON/Code/jump-pm`,
`src/lib/consultas/*`). Reaproveitar as ideias boas (catálogo tipado, AST única,
escopo obrigatório no servidor, IA restrita ao catálogo visível) e **não repetir** as
falhas conhecidas listadas na seção 9.

Progresso e vereditos: `docs/consultas/ANDAMENTO.md`.

## 1. Decisões de produto (fechadas)

1. **Público:** Gestão, Financeiro e People. Tudo governado pela **Matriz de
   Permissões** — se o público mudar, é configuração, não código.
2. CONSULTANT e SALES **sem acesso** por padrão (zero células na matriz).
3. Construtor **visual** + **IA** (fase C3). Não há linguagem textual própria (DSL)
   nem editor SQL.
4. A IA nunca recebe dados, só o catálogo que o usuário pode ver.
5. A IA do Flow é DeepSeek com fallback Gemini, via `getAiTextProvider()`
   (`apps/web/src/lib/ai/provider.ts`). Não chamar provider direto.

## 2. Matriz de Permissões

Códigos novos (migration aditiva + `seed.mjs` + `align-permission-catalog.mjs` +
constantes em `apps/web/src/lib/auth/permission-codes.ts`). Siga exatamente o padrão do
commit `c5ff0d8` (CONSULTORES_PROJETOS / CONSULTORES_RELATORIO).

| Código | Nome | Pai | Padrão (`view`) |
|---|---|---|---|
| `CONSULTAS` | Consultas | — (módulo "Gestão") | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE, PEOPLE |
| `CONSULTAS_HORAS` | Consultas: Horas | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE |
| `CONSULTAS_ALOCACOES` | Consultas: Alocações | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE, PEOPLE |
| `CONSULTAS_CONSULTORES` | Consultas: Consultores | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, PEOPLE |
| `CONSULTAS_PROJETOS` | Consultas: Projetos | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE |
| `CONSULTAS_APROVACOES` | Consultas: Aprovações | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER |
| `CONSULTAS_DESPESAS` | Consultas: Despesas | CONSULTAS | ADMIN, FINANCE |
| `CONSULTAS_FATURAMENTO` | Consultas: Faturamento | CONSULTAS | ADMIN, FINANCE |
| `CONSULTAS_PAGAMENTOS` | Consultas: Pagamentos | CONSULTAS | ADMIN, FINANCE |
| `CONSULTAS_SKILLS` | Consultas: Skills e certificados | CONSULTAS | ADMIN, AREA_MANAGER, PEOPLE |
| `CONSULTAS_AUSENCIAS` | Consultas: Ausências | CONSULTAS | ADMIN, AREA_MANAGER, PEOPLE |
| `CONSULTAS_CRIAR` | Criar consultas | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE, PEOPLE |
| `CONSULTAS_COMPARTILHAR` | Compartilhar visões | CONSULTAS | ADMIN, AREA_MANAGER, FINANCE, PEOPLE |
| `CONSULTAS_EXPORTAR` | Exportar resultados | CONSULTAS | ADMIN, AREA_MANAGER, FINANCE, PEOPLE |
| `CONSULTAS_AGENDAR` | Agendar envio | CONSULTAS | ADMIN, FINANCE |
| `CONSULTAS_IA` | Assistente de IA | CONSULTAS | ADMIN, AREA_MANAGER, PROJECT_MANAGER, FINANCE, PEOPLE |

Somente `canView` é concedido por padrão. A rota `/app/consultas` entra no mapa de rotas
(`route-permissions.ts`) e na navegação, gated por `CONSULTAS`.

Quem tem `CONSULTAS` mas não tem `CONSULTAS_CRIAR` só abre visões compartilhadas com ele.

## 3. Catálogo de dados (fonte única)

- Arquivo TS único e puro (sem Prisma/React), por exemplo
  `apps/web/src/lib/consultas/catalog.ts`. É compartilhado por:
  - compilador;
  - tela do catálogo;
  - construtor visual;
  - prompt da IA.
- **Proibido** um segundo mapa físico mantido à mão. A coluna física sai do próprio
  campo do catálogo.
- Cada **entidade** aponta para uma **view SQL curada** criada por migration
  (`consulta_horas`, `consulta_alocacoes`, ...). A view resolve os cruzamentos
  (joins) uma vez, com regra de negócio correta. Exemplos:
  - uma linha de horas já traz consultor, área, projeto, cliente, gestor;
  - também traz o **valor-hora de venda e de custo vigentes na data do lançamento**
    (reusar a mesma regra de vigência de `lib/db/reports.ts` /
    `resolveBillingRate` — a view deve produzir o mesmo número).
- Toda view expõe as colunas técnicas de escopo usadas pelo filtro de linha. Exemplos:
  `consultant_id`, `area_id`, `project_id`, `project_manager_id`.
- Tipo de cada entidade:
  ```ts
  type ConsultaEntity = {
    key: string; label: string; description: string; view: string;
    permissionCode: string;        // ex.: "CONSULTAS_HORAS"
    scope: ScopeKind;              // como aplicar o escopo de linha (seção 4)
    defaultColumns: string[];
    examples: { label: string; spec: ConsultaSpec }[];
    fields: ConsultaField[];
  };
  ```
- Tipo de cada campo:
  ```ts
  type ConsultaField = {
    key: string; label: string; column: string;   // coluna da view
    type: "texto" | "lista" | "data" | "pessoa" | "numero" | "moeda" | "horas" | "booleano";
    description: string;           // significado de negócio, em PT-BR
    source: string;                // origem legível, ex.: "TimeEntry.hours → aprovado"
    example?: string;
    options?: { value: string; label: string }[]; // enums com rótulo PT
    aggregations?: ("sum" | "avg" | "min" | "max" | "count")[];
    groupable?: boolean;
    sensitivity: "publico" | "financeiro" | "custo_sensivel";
    owner?: string;                // área dona do dado
  };
  ```
- **Métricas oficiais** ficam documentadas no catálogo com a fórmula:
  - Horas lançadas / aprovadas / faturáveis;
  - Receita (horas × valor de venda vigente);
  - Custo;
  - Margem;
  - % de ocupação.
- Dados `pessoal` (CPF, dados bancários, endereço, remuneração acordada) **não entram
  no catálogo**.

## 4. Segurança (servidor, sempre)

1. **Entidade:** o usuário precisa de `view` no `permissionCode` da entidade.
2. **Linha:** reusar o escopo dos Relatórios (`resolveReportScope` em
   `lib/db/reports.ts`). Cada view recebe, de forma obrigatória, um AND com o escopo
   do usuário, aplicado pelo servidor:
   - gestor de área → a própria área;
   - PM → os próprios projetos;
   - escopo amplo → tudo.

   O usuário nunca consegue removê-lo.
3. **Coluna:**
   - `financeiro` → mesma regra que libera valores financeiros nos Relatórios
     (FINANCIAL_ROLES / matriz equivalente);
   - `custo_sensivel` → só o grupo Dados Sensíveis (`canAccessSensitiveCost`).

   Campo sem permissão **some** do catálogo entregue ao cliente e à IA. Se aparecer
   numa spec mesmo assim, o servidor **rejeita** (403/400). Não basta mascarar.
4. **Execução:**
   - SQL gerado com `Prisma.sql`;
   - identificadores **somente** do catálogo (lista fixa, nunca string do cliente);
   - valores sempre parametrizados;
   - dentro de `$transaction` com `SET LOCAL statement_timeout = '15s'`.

   Agregações (`GROUP BY`, `SUM` etc.) rodam no Postgres, nunca em Node.
5. **Limites:**
   - tela: página de 100 linhas, paginação por offset, máx. 1000 linhas navegáveis;
   - exportação: até 50.000 linhas, gerada no servidor.
6. **Auditoria** (`recordAuditEvent`):
   - toda exportação;
   - toda execução que use campo `financeiro`/`custo_sensivel`;
   - criar, compartilhar ou excluir visões;
   - agendar envio.
7. **Validação:** a spec de consulta é validada por Zod no servidor antes de compilar
   (seção 5). O cliente nunca envia SQL.

## 5. Spec da consulta (AST)

```ts
type ConsultaSpec = {
  entity: string;
  filters: { logic: "and" | "or"; conditions: Condition[] } | null;  // 1 nível
  columns: string[];                       // usado sem agrupamento
  groupBy: { field: string; granularity?: "dia" | "semana" | "mes" | "ano" }[]; // ≤ 2
  measures: { field: string; agg: "sum" | "avg" | "min" | "max" | "count" }[];
  sort: { key: string; dir: "asc" | "desc" }[];   // key = campo ou medida
  limit?: number;
};
type Condition = { field: string; op: Op; value?: Value | Value[] };
type Op = "eq" | "neq" | "in" | "nin" | "contains" | "gt" | "gte" | "lt" | "lte"
        | "between" | "is_null" | "not_null";
type Value = string | number | boolean | { relative: "hoje" | "inicio_mes" | "inicio_semana"; offsetDays?: number };
```

- Operadores permitidos por tipo de campo (tabela no código, testada).
- Datas relativas resolvidas no fuso `America/Sao_Paulo` (usar o util de data do
  projeto; não fixar UTC−3).
- Com `groupBy`: `columns` é ignorado e o resultado são as linhas agrupadas com as
  medidas. Sem `groupBy`, as medidas viram uma linha de totais.

## 6. Fases

### C1 — Fundação (entregar primeiro)
- Matriz (todos os códigos da seção 2), rota, navegação e guard.
- Catálogo + views SQL de **Horas, Alocações, Consultores**.
- Compilador spec → SQL seguro, executor com timeout, escopo de linha e coluna.
- Tela `/app/consultas`:
  - construtor visual: entidade, filtros E/OU, colunas, agrupar (≤2, com
    granularidade de data), medidas, ordenação;
  - resultado em tabela com paginação, totais e estados vazio/erro/carregando;
  - linha clicável que leva ao registro quando houver página de detalhe.
- Tela de catálogo `/app/consultas/catalogo`:
  - busca por entidade/campo;
  - descrição, origem, tipo, sensibilidade (badge), exemplos;
  - "Usar na consulta".
- Exportação XLSX (`lib/export/xlsx.ts`) e CSV no servidor, gated por
  `CONSULTAS_EXPORTAR`. O CSV usa `;`, BOM e escape de fórmula (`= + - @` → prefixo `'`).
- Auditoria conforme a seção 4.
- Testes:
  - compilador (incluindo tentativas de injeção);
  - permissões de entidade/coluna;
  - escopo de linha;
  - operadores por tipo;
  - CSV com fórmula.

### C2 — Abrangência + visões
- Entidades restantes:
  - Projetos, Aprovações, Despesas, Faturamento (pré-fatura/receita), Pagamentos;
  - Skills/Certificados, Ausências.
- Visões salvas: modelo próprio (por exemplo `ConsultaView`) com:
  - `ownerId`, `name`, `description`, `spec Json`;
  - `visualization` (`tabela | barras | linhas | pizza | indicador`);
  - `sharing` (`PRIVATE | ROLES | ALL`), `sharedRoles`;
  - timestamps.

  Compartilhar exige `CONSULTAS_COMPARTILHAR`. A visão compartilhada roda **sempre
  com a permissão de quem vê**. Se o usuário perde acesso à entidade, ela não aparece
  para ele.
- Painéis: modelo com `items Json` (referências a visões, ≤ 24). Ao renderizar,
  **revalidar o acesso de cada visão para quem está vendo**, para não repetir o
  vazamento do Jump PM:
  - visão privada de outro dono não aparece nem com nome;
  - entidade sem acesso também não aparece.
- Gráficos seguindo `docs/design-system.md` (verificar a lib de gráficos já instalada
  antes de adicionar qualquer uma).

### C3 — IA + agendamento
- Assistente (`CONSULTAS_IA`):
  - linguagem natural → `ConsultaSpec` JSON via `getAiTextProvider()`;
  - prompt com o catálogo **já filtrado** pelo usuário;
  - a saída é validada pelo mesmo Zod + checagem de permissão;
  - 1 retentativa com o erro, e então desiste com uma mensagem amigável;
  - mostra a explicação em linguagem natural do que foi montado;
  - o usuário confirma antes de rodar;
  - rate limit por usuário persistido no banco (Railway pode ter mais de uma
    instância).
- Envio agendado (`CONSULTAS_AGENDAR`):
  - visão/painel → e-mail com XLSX anexo;
  - job cron-friendly em `/api/jobs/consultas-agendadas` (mesmo contrato `CRON_SECRET`
    de `/api/jobs/*`);
  - idempotente por janela;
  - **executa com a permissão de cada destinatário**; destinatário sem acesso é pulado
    e registrado no log.

## 7. UI

- Seguir `docs/design-system.md` e `docs/identidade-visual-playful-ops.md`.
- Motion só funcional (`motion/react`), sem parallax.
- Textos em PT-BR; responsivo; acessível (labels, foco, contraste).

## 8. Fora de escopo

- SQL livre.
- Linguagem textual própria.
- Edição de dados pela consulta.
- Acesso de consultor (fica possível só via matriz no futuro).

## 9. Falhas do Jump PM a NÃO repetir

- Agrupar em Node (até 10 mil linhas).
- Só COUNT.
- Catálogo duplicado.
- Painel que expõe visões privadas.
- Sem timeout.
- CSV no browser sem escape de fórmula.
- Rate limit em memória.
- Fuso fixo UTC−3.
- Owner override por papel global sem matriz.

/**
 * Visões salvas e painéis de Consultas (ESPECIFICAÇÃO §6 C2) — regras PURAS.
 *
 * - Entrada validada por Zod no servidor (nome, descrição, visualização,
 *   compartilhamento, papéis, itens do painel).
 * - Quem pode ABRIR uma visão/painel: dono, ou compartilhado com todos
 *   (`ALL`), ou com um papel que a pessoa tem (`ROLES`). Para visão, também é
 *   preciso ver a entidade — e a execução SEMPRE usa a permissão de quem vê
 *   (entidade, campos e escopo de linha), nunca a do dono.
 * - Não há "override" por papel global: nem ADMIN abre visão privada alheia
 *   (falha do Jump PM listada na §9).
 */
import { z } from "zod";
import { ROLE_NAMES, type RoleName } from "@/lib/auth/roles";
import { canSeeEntity, type ConsultaAccess } from "./access";
import { validateConsulta } from "./validate";

export const VISUALIZATIONS = ["TABLE", "BAR", "LINE", "PIE", "INDICATOR"] as const;
export type Visualization = (typeof VISUALIZATIONS)[number];

export const VISUALIZATION_LABELS: Record<Visualization, string> = {
  TABLE: "Tabela",
  BAR: "Barras",
  LINE: "Linhas",
  PIE: "Pizza",
  INDICATOR: "Indicador",
};

export const SHARING_MODES = ["PRIVATE", "ROLES", "ALL"] as const;
export type Sharing = (typeof SHARING_MODES)[number];

export const SHARING_LABELS: Record<Sharing, string> = {
  PRIVATE: "Só eu",
  ROLES: "Papéis selecionados",
  ALL: "Todos com acesso a Consultas",
};

/**
 * Papéis oferecidos no compartilhamento. Compartilhar com um papel não dá
 * acesso a nada: quem abre ainda precisa de `CONSULTAS` e da entidade na
 * Matriz, e roda com o próprio escopo.
 */
export const SHAREABLE_ROLES: readonly RoleName[] = ROLE_NAMES;

/** Teto de itens por painel (§6 C2). */
export const MAX_PANEL_ITEMS = 24;

export const PANEL_ITEM_SIZES = ["normal", "largo"] as const;
export type PanelItemSize = (typeof PANEL_ITEM_SIZES)[number];

const nameSchema = z
  .string()
  .trim()
  .min(1, "Informe um nome.")
  .max(120, "Nome muito longo (máx. 120).");

const descriptionSchema = z
  .string()
  .trim()
  .max(500, "Descrição muito longa (máx. 500).")
  .nullish()
  .transform((value) => (value ? value : null));

const sharingShape = {
  sharing: z.enum(SHARING_MODES),
  sharedRoles: z.array(z.enum(ROLE_NAMES)).max(ROLE_NAMES.length).default([]),
};

function normalizeSharing<T extends { sharing: Sharing; sharedRoles: RoleName[] }>(value: T): T {
  // Papéis só valem em ROLES; sem duplicatas.
  return {
    ...value,
    sharedRoles: value.sharing === "ROLES" ? [...new Set(value.sharedRoles)] : [],
  };
}

const rolesRequired = {
  check: (value: { sharing: Sharing; sharedRoles: RoleName[] }) =>
    value.sharing !== "ROLES" || value.sharedRoles.length > 0,
  message: "Escolha ao menos um papel para compartilhar.",
};

export const viewInputSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    visualization: z.enum(VISUALIZATIONS),
    ...sharingShape,
  })
  .strict()
  .refine(rolesRequired.check, { message: rolesRequired.message, path: ["sharedRoles"] })
  .transform(normalizeSharing);

export type ViewInput = z.infer<typeof viewInputSchema>;

export const panelItemSchema = z
  .object({
    viewId: z.string().min(1).max(64),
    size: z.enum(PANEL_ITEM_SIZES).default("normal"),
  })
  .strict();

export type PanelItem = z.infer<typeof panelItemSchema>;

export const panelInputSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema,
    items: z
      .array(panelItemSchema)
      .min(1, "Escolha ao menos uma visão.")
      .max(MAX_PANEL_ITEMS, `Um painel tem no máximo ${MAX_PANEL_ITEMS} visões.`)
      .refine(
        (items) => new Set(items.map((item) => item.viewId)).size === items.length,
        "A mesma visão aparece duas vezes no painel.",
      ),
    ...sharingShape,
  })
  .strict()
  .refine(rolesRequired.check, { message: rolesRequired.message, path: ["sharedRoles"] })
  .transform(normalizeSharing);

export type PanelInput = z.infer<typeof panelInputSchema>;

/** Itens gravados no banco (JSON) → lista segura; lixo é descartado. */
export function parsePanelItems(raw: unknown): PanelItem[] {
  if (!Array.isArray(raw)) return [];
  const items: PanelItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_PANEL_ITEMS)) {
    const parsed = panelItemSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.viewId)) continue;
    seen.add(parsed.data.viewId);
    items.push(parsed.data);
  }
  return items;
}

/** Primeira mensagem de erro de um Zod safeParse, em PT-BR. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Dados inválidos.";
}

export interface Viewer {
  /** `User.id` de quem vê (null = não resolvido: só vê o que é de todos/papéis). */
  userId: string | null;
  roles: readonly RoleName[];
}

export interface SharedMeta {
  ownerId: string;
  sharing: Sharing;
  sharedRoles: readonly string[];
}

export function isOwner(item: { ownerId: string }, viewer: Viewer): boolean {
  return viewer.userId !== null && item.ownerId === viewer.userId;
}

/** Regra de compartilhamento (sem considerar entidade/campos). */
export function canOpenShared(item: SharedMeta, viewer: Viewer): boolean {
  if (isOwner(item, viewer)) return true;
  if (item.sharing === "ALL") return true;
  if (item.sharing === "ROLES") {
    return item.sharedRoles.some((role) => viewer.roles.includes(role as RoleName));
  }
  return false;
}

/**
 * Quem vê pode abrir a visão: módulo + compartilhamento + entidade liberada.
 * Os campos da spec são checados à parte (`specUsableBy`).
 */
export function canOpenView(
  view: SharedMeta & { entity: string },
  viewer: Viewer,
  access: ConsultaAccess,
): boolean {
  return access.module && canOpenShared(view, viewer) && canSeeEntity(access, view.entity);
}

/** A spec salva roda com a permissão de quem vê? (campos, entidade, forma) */
export function specUsableBy(spec: unknown, access: ConsultaAccess): boolean {
  try {
    validateConsulta(spec, access);
    return true;
  } catch {
    return false;
  }
}

/** Compartilhar com alguém além do dono exige `CONSULTAS_COMPARTILHAR`. */
export function sharingAllowed(sharing: Sharing, access: ConsultaAccess): boolean {
  return sharing === "PRIVATE" || access.share;
}

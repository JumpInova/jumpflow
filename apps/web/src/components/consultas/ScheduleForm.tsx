"use client";

import { useId, useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Save, Search, Trash2 } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import {
  atualizarAgendamento,
  excluirAgendamento,
  salvarAgendamento,
} from "@/app/app/consultas/agendamentos/actions";
import {
  describeTiming,
  FREQUENCY_LABELS,
  MAX_SCHEDULE_RECIPIENTS,
  SCHEDULE_FREQUENCIES,
  WEEKDAY_LABELS,
  type ScheduleFrequency,
} from "@/lib/consultas/schedule";
import { focusRingInput } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { controlClass } from "./FilterEditor";

export interface ScheduleFormValue {
  name: string;
  /** `view:<id>` ou `panel:<id>`. */
  target: string;
  frequency: ScheduleFrequency;
  hour: number;
  weekday: number;
  monthDay: number;
  recipientUserIds: string[];
  active: boolean;
}

export interface ScheduleFormProps {
  scheduleId?: string;
  initial: ScheduleFormValue;
  views: { id: string; name: string }[];
  panels: { id: string; name: string }[];
  users: { id: string; name: string }[];
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);
const labelClass = "block text-sm font-semibold text-strong";

/**
 * Formulário de envio agendado. Destinatários = usuários do sistema; cada um
 * recebe a planilha gerada com a PRÓPRIA permissão (o servidor revalida tudo).
 */
export function ScheduleForm({ scheduleId, initial, views, panels, users }: ScheduleFormProps) {
  const router = useRouter();
  const ids = { name: useId(), target: useId(), frequency: useId(), hour: useId(), day: useId(), search: useId() };
  const [value, setValue] = useState<ScheduleFormValue>(initial);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  const selected = useMemo(() => new Set(value.recipientUserIds), [value.recipientUserIds]);
  const filteredUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((user) => user.name.toLowerCase().includes(q));
  }, [query, users]);
  const byId = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  function set<K extends keyof ScheduleFormValue>(key: K, next: ScheduleFormValue[K]) {
    setValue((current) => ({ ...current, [key]: next }));
  }

  function toggleRecipient(id: string) {
    set(
      "recipientUserIds",
      selected.has(id) ? value.recipientUserIds.filter((item) => item !== id) : [...value.recipientUserIds, id],
    );
  }

  function payload() {
    const [kind, ...rest] = value.target.split(":");
    return {
      name: value.name,
      target: { kind, id: rest.join(":") },
      frequency: value.frequency,
      hour: value.hour,
      weekday: value.frequency === "WEEKLY" ? value.weekday : null,
      monthDay: value.frequency === "MONTHLY" ? value.monthDay : null,
      recipientUserIds: value.recipientUserIds,
      active: value.active,
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!value.target) {
      setError("Escolha a visão ou o painel a enviar.");
      return;
    }
    if (value.recipientUserIds.length === 0) {
      setError("Escolha ao menos um destinatário.");
      return;
    }
    startTransition(async () => {
      const response = scheduleId
        ? await atualizarAgendamento(scheduleId, payload())
        : await salvarAgendamento(payload());
      if (!response.ok) {
        setError(response.error);
        return;
      }
      router.push("/app/consultas/agendamentos");
      router.refresh();
    });
  }

  function remove() {
    if (!scheduleId) return;
    startTransition(async () => {
      const response = await excluirAgendamento(scheduleId);
      if (!response.ok) {
        setError(response.error);
        setConfirming(false);
        return;
      }
      router.push("/app/consultas/agendamentos");
      router.refresh();
    });
  }

  const timing = describeTiming({
    frequency: value.frequency,
    hour: value.hour,
    weekday: value.weekday,
    monthDay: value.monthDay,
  });

  return (
    <form className="grid gap-6 lg:grid-cols-2" onSubmit={submit}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor={ids.name} className={labelClass}>
            Nome do envio
          </label>
          <input
            id={ids.name}
            required
            maxLength={120}
            className={controlClass}
            value={value.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Ex.: Horas da semana por projeto"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor={ids.target} className={labelClass}>
            O que enviar
          </label>
          <select
            id={ids.target}
            className={controlClass}
            value={value.target}
            onChange={(event) => set("target", event.target.value)}
          >
            <option value="">Escolha uma visão ou painel…</option>
            {views.length > 0 ? (
              <optgroup label="Visões">
                {views.map((view) => (
                  <option key={view.id} value={`view:${view.id}`}>
                    {view.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {panels.length > 0 ? (
              <optgroup label="Painéis (uma aba por visão)">
                {panels.map((panel) => (
                  <option key={panel.id} value={`panel:${panel.id}`}>
                    {panel.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <p className="text-xs text-soft">
            O destinatário precisa ter acesso à visão ou ao painel (compartilhe antes, se preciso).
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label htmlFor={ids.frequency} className={labelClass}>
              Frequência
            </label>
            <select
              id={ids.frequency}
              className={controlClass}
              value={value.frequency}
              onChange={(event) => set("frequency", event.target.value as ScheduleFrequency)}
            >
              {SCHEDULE_FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {FREQUENCY_LABELS[frequency]}
                </option>
              ))}
            </select>
          </div>
          {value.frequency === "WEEKLY" ? (
            <div className="space-y-1.5">
              <label htmlFor={ids.day} className={labelClass}>
                Dia da semana
              </label>
              <select
                id={ids.day}
                className={controlClass}
                value={value.weekday}
                onChange={(event) => set("weekday", Number(event.target.value))}
              >
                {Object.entries(WEEKDAY_LABELS).map(([day, label]) => (
                  <option key={day} value={day}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {value.frequency === "MONTHLY" ? (
            <div className="space-y-1.5">
              <label htmlFor={ids.day} className={labelClass}>
                Dia do mês
              </label>
              <select
                id={ids.day}
                className={controlClass}
                value={value.monthDay}
                onChange={(event) => set("monthDay", Number(event.target.value))}
              >
                {MONTH_DAYS.map((day) => (
                  <option key={day} value={day}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <label htmlFor={ids.hour} className={labelClass}>
              Horário
            </label>
            <select
              id={ids.hour}
              className={controlClass}
              value={value.hour}
              onChange={(event) => set("hour", Number(event.target.value))}
            >
              {HOURS.map((hour) => (
                <option key={hour} value={hour}>
                  {String(hour).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-sm text-medium" aria-live="polite">
          {timing} (horário de São Paulo).
        </p>

        <label className="flex items-center gap-2 text-sm text-medium">
          <input
            type="checkbox"
            checked={value.active}
            onChange={(event) => set("active", event.target.checked)}
          />
          Envio ativo
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className={labelClass}>
          Destinatários ({value.recipientUserIds.length}/{MAX_SCHEDULE_RECIPIENTS})
        </legend>
        <p className="text-xs text-soft">
          Usuários do JumpFlow. Cada um recebe a planilha com os dados que o próprio perfil permite;
          quem não tiver acesso ou permissão de exportar é pulado.
        </p>
        {value.recipientUserIds.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Destinatários escolhidos">
            {value.recipientUserIds.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => toggleRecipient(id)}
                  className={cn(
                    "rounded-full border border-border bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-strong hover:border-ink",
                    focusRingInput,
                  )}
                  aria-label={`Remover ${byId.get(id)?.name ?? "destinatário"}`}
                >
                  {byId.get(id)?.name ?? "Usuário indisponível"} ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-soft" />
          <label htmlFor={ids.search} className="sr-only">
            Buscar usuário
          </label>
          <input
            id={ids.search}
            type="search"
            className={cn(controlClass, "pl-8")}
            placeholder="Buscar por nome"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border p-1">
          {filteredUsers.length === 0 ? (
            <li className="px-2 py-3 text-sm text-soft">Nenhum usuário encontrado.</li>
          ) : (
            filteredUsers.map((user) => {
              const checked = selected.has(user.id);
              const full = !checked && value.recipientUserIds.length >= MAX_SCHEDULE_RECIPIENTS;
              return (
                <li key={user.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-surface-muted",
                      full && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={full}
                      onChange={() => toggleRecipient(user.id)}
                    />
                    <span className="min-w-0 truncate font-medium text-strong">{user.name}</span>
                  </label>
                </li>
              );
            })
          )}
        </ul>
      </fieldset>

      <div className="space-y-3 lg:col-span-2">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton type="submit" icon={Save} disabled={pending}>
            {pending ? "Salvando…" : scheduleId ? "Salvar agendamento" : "Criar agendamento"}
          </ActionButton>
          {scheduleId ? (
            confirming ? (
              <>
                <span className="text-sm text-medium">Excluir este agendamento?</span>
                <ActionButton type="button" size="sm" variant="danger" icon={Trash2} disabled={pending} onClick={remove}>
                  Sim, excluir
                </ActionButton>
                <ActionButton type="button" size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                  Cancelar
                </ActionButton>
              </>
            ) : (
              <ActionButton type="button" size="sm" variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
                Excluir agendamento
              </ActionButton>
            )
          ) : null}
        </div>
      </div>
    </form>
  );
}

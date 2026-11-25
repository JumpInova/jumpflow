"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { focusRing } from "@/lib/styles";

interface EntryDescriptionHoverProps {
  /** Descrição da atividade escrita pelo consultor. Sem texto, só renderiza o filho. */
  description?: string;
  /** Rótulo curto do lançamento (ex.: "12/11 · Desenvolvimento"), título do popover. */
  title: string;
  children: ReactNode;
  className?: string;
}

const PANEL_MAX_HEIGHT = 288;
const GAP = 6;
const CLOSE_DELAY_MS = 120;

interface Position {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Mostra a descrição da atividade ao passar o mouse (ou focar via teclado) em
 * um lançamento da fila de aprovação. Renderizado em portal com posição fixa:
 * o detalhe da linha usa `overflow-hidden` (animação de abrir/fechar), que
 * cortaria um popover absoluto. O painel é rolável para descrições longas e
 * continua aberto enquanto o ponteiro estiver sobre ele.
 */
export function EntryDescriptionHover({
  description,
  title,
  children,
  className,
}: EntryDescriptionHoverProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const panelId = useId();
  const text = description?.trim();

  function cancelClose() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function open() {
    cancelClose();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(448, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom - GAP - 8;
    const spaceAbove = rect.top - GAP - 8;
    const below =
      spaceBelow >= Math.min(PANEL_MAX_HEIGHT, 200) || spaceBelow >= spaceAbove;
    setPosition(
      below
        ? {
            left,
            top: rect.bottom + GAP,
            maxHeight: Math.max(96, Math.min(PANEL_MAX_HEIGHT, spaceBelow)),
          }
        : {
            left,
            bottom: window.innerHeight - rect.top + GAP,
            maxHeight: Math.max(96, Math.min(PANEL_MAX_HEIGHT, spaceAbove)),
          },
    );
  }

  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(() => setPosition(null), CLOSE_DELAY_MS);
  }

  const isOpen = position !== null;

  useEffect(() => {
    if (!isOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setPosition(null);
    }
    // Posição fixa não acompanha a rolagem da página: fecha ao rolar fora do
    // painel (rolar DENTRO dele é ler a descrição longa).
    function onScroll(event: Event) {
      if (panelRef.current?.contains(event.target as Node)) return;
      setPosition(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [isOpen]);

  useEffect(() => cancelClose, []);

  if (!text) return <span className={className}>{children}</span>;

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        aria-describedby={isOpen ? panelId : undefined}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
        onFocus={open}
        onBlur={scheduleClose}
        className={cn("cursor-help rounded-sm", focusRing, className)}
      >
        {children}
      </span>
      {isOpen
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="tooltip"
              tabIndex={-1}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
              onFocus={cancelClose}
              onBlur={scheduleClose}
              style={{
                left: position.left,
                top: position.top,
                bottom: position.bottom,
                maxHeight: position.maxHeight,
              }}
              className="fixed z-50 w-[min(28rem,calc(100vw-1rem))] overflow-y-auto rounded-md border border-border bg-surface px-3 py-2.5 text-left shadow-lg"
            >
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-soft">
                {title}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-strong">
                {text}
              </p>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

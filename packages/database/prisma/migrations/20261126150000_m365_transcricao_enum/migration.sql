-- Microsoft 365 (M3) — parte 1/2: SÓ o novo valor de enum.
--
-- Migration própria porque o Postgres não permite USAR um valor de enum
-- recém-adicionado na mesma transação em que foi criado (padrão de
-- 20261126140000_m365_atas_enum). Aditivo e idempotente. O evento é só in-app
-- (aviso ao gestor), sem regra de e-mail.

ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'CHECKPOINT_TRANSCRIPT_MISSING';

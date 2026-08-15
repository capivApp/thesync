/**
 * O change log e o cursor por ordem de commit.
 *
 * A ideia óbvia — `WHERE updatedAt > :ultimoSync` — perde linhas em silêncio, e
 * vale entender por quê antes de alguém "simplificar" isto:
 *
 *  - `updatedAt` costuma ser preenchido pelo CLIENTE do ORM, não pelo banco;
 *    com várias réplicas, o desvio de relógio entre elas já basta para uma
 *    linha nascer com timestamp anterior ao watermark de quem sincronizou.
 *  - Escrita crua com `NOW()` mistura o relógio do banco na mesma coluna, e
 *    `NOW()` é o INÍCIO da transação.
 *  - E o problema de fundo: qualquer número atribuído no INSERT é atribuído em
 *    ordem de INÍCIO, não de COMMIT. Uma transação longa (semear um inventário
 *    inteiro) commita linhas cujo número é menor que o de quem sincronizou no
 *    meio dela. Essas linhas ficam para trás do cursor e somem para sempre.
 *
 * A saída é perguntar por VISIBILIDADE, não por tempo: `pg_visible_in_snapshot`
 * resgata exatamente as transações que ainda estavam em voo.
 *
 * Requer PostgreSQL 13+.
 */

export const TABELA_CHANGE_LOG = 'sync_change_log';
export const TABELA_MARCA_PODA = 'sync_prune_mark';

export const SQL_CRIAR_CHANGE_LOG = `
CREATE TABLE IF NOT EXISTS public.sync_change_log (
  seq         BIGSERIAL   PRIMARY KEY,
  xid         xid8        NOT NULL DEFAULT pg_current_xact_id(),
  entidade    INT         NOT NULL,
  tabela      TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  op          CHAR(1)     NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  modified_by TEXT
);

CREATE INDEX IF NOT EXISTS sync_change_log_pull_idx
  ON public.sync_change_log (entidade, tabela, seq);
CREATE INDEX IF NOT EXISTS sync_change_log_catchup_idx
  ON public.sync_change_log (entidade, tabela, xid);

CREATE TABLE IF NOT EXISTS public.sync_prune_mark (
  entidade         INT    NOT NULL,
  tabela           TEXT   NOT NULL,
  pruned_below_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (entidade, tabela)
);
`;

/**
 * `SECURITY DEFINER` NÃO é opcional.
 *
 * Sem ele, o INSERT no log roda com a role da aplicação e passa pelo
 * `WITH CHECK` da política de RLS. Numa escrita em tabela FORA do RLS — que tem
 * entidade global — o check falha e a transação de negócio inteira aborta.
 *
 * E `SET search_path` também não é opcional: `SECURITY DEFINER` sem ele é
 * escalada de privilégio clássica.
 */
export const SQL_FUNCAO_TRIGGER = `
CREATE OR REPLACE FUNCTION public.sync_change_log_fn() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op  CHAR(1);
  v_row RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_op  := 'D';
  ELSIF TG_OP = 'INSERT' THEN
    v_row := NEW;
    v_op  := CASE WHEN NEW.enabled THEN 'I' ELSE 'D' END;
  ELSE
    v_row := NEW;
    v_op  := CASE
               WHEN NOT NEW.enabled THEN 'D'
               WHEN NOT OLD.enabled AND NEW.enabled THEN 'I'
               ELSE 'U'
             END;
  END IF;

  INSERT INTO public.sync_change_log (entidade, tabela, record_id, op, modified_by)
  VALUES (v_row.entidade, TG_TABLE_NAME, v_row.id::text, v_op, v_row."modifiedBy");

  RETURN NULL;
END $$;
`;

/**
 * O registro dos triggers roda na INICIALIZAÇÃO, não só na migration.
 *
 * Uma migration que faz `DROP TRIGGER` em laço sobre o schema apaga triggers de
 * outras funcionalidades sem avisar. Os únicos que sobrevivem a isso são os
 * recriados no bootstrap — e vale um teste de CI que confira `pg_trigger`
 * depois do bootstrap.
 */
export const SQL_APLICAR_TRIGGERS = `
CREATE OR REPLACE FUNCTION public.apply_sync_triggers(tabelas text[]) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS sync_changelog_%I ON public.%I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER sync_changelog_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.sync_change_log_fn();', t, t);
  END LOOP;
END $$;
`;

export interface SnapshotDoBanco {
    snapshot: string;
    xmin: string;
}

/** Precisa rodar na MESMA transação da consulta ao log. */
export const SQL_SNAPSHOT_ATUAL = `
SELECT pg_current_snapshot()::text AS snapshot,
       pg_snapshot_xmin(pg_current_snapshot())::text AS xmin;
`;

export interface ParametrosDoPull {
    entidade: number;
    tabela: string;
    cursorSeq: string;
    cursorXmin: string;
    cursorSnapshot: string;
    limite: number;
}

export interface LinhaDoLog {
    seq: string;
    record_id: string;
    op: string;
}

/**
 * O `OR` impede um índice único de resolver tudo — o planner combina os dois
 * por bitmap. Continua guiado por índice; não vira varredura sequencial.
 */
export const sqlDoPull = (): string => `
SELECT c.seq::text AS seq, c.record_id, c.op
  FROM public.sync_change_log c
 WHERE c.entidade = $1
   AND c.tabela   = $2
   AND ( c.seq > $3::bigint
      OR ( c.xid >= $4::xid8
       AND NOT pg_visible_in_snapshot(c.xid, $5::pg_snapshot) ) )
 ORDER BY c.seq
 LIMIT $6;
`;

/** Cursor anterior à poda: só recarga completa resolve. */
export const sqlDaMarcaDePoda = (): string => `
SELECT pruned_below_seq::text AS pruned_below_seq
  FROM public.sync_prune_mark
 WHERE entidade = $1 AND tabela = $2;
`;

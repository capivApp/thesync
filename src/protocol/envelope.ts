/**
 * Envelopes das rotas de sincronização.
 *
 * Deliberadamente NOVOS e regulares. O envelope legado da API
 * (`{data: {data: [], paginacao}}`, que vira `{data: [], paginate}` quando a
 * lista está vazia) é contrato do frontend web e não se mexe nele — mas ele
 * também não entra aqui. Normalizar essa irregularidade é trabalho do
 * adaptador de transporte do app, não do motor.
 */

/** O que aconteceu com um registro, do ponto de vista de quem sincroniza. */
export type OperacaoSync = 'upsert' | 'delete';

export interface MudancaSync<T = unknown> {
    op: OperacaoSync;
    id: string;
    /** Presente apenas em `upsert`. Em `delete` o registro já não existe. */
    row?: T;
}

export interface RespostaMudancas<T = unknown> {
    /** Guarde e devolva. Só persista quando `hasMore` for `false`. */
    cursor: string;
    hasMore: boolean;
    changes: MudancaSync<T>[];
}

export interface RespostaSnapshot<T = unknown> {
    items: T[];
    /** Passe de volta como `?cursor=` para pedir a próxima página. */
    nextId: string | null;
    hasMore: boolean;
}

/** O cursor é anterior à poda do change log: só uma recarga completa resolve. */
export interface ErroResync {
    code: 'RESYNC_REQUIRED';
    message: string;
}

export const CODIGO_RESYNC = 'RESYNC_REQUIRED' as const;

export const ehErroResync = (corpo: unknown): corpo is ErroResync =>
    !!corpo && typeof corpo === 'object' && (corpo as ErroResync).code === CODIGO_RESYNC;

/** Header por onde a versão do registro viaja no compare-and-swap. */
export const HEADER_VERSAO = 'if-match';
export const HEADER_ETAG = 'etag';
export const HEADER_IDEMPOTENCIA = 'x-idempotency-key';

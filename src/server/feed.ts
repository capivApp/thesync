/**
 * Monta a resposta de `/sync/changes`.
 *
 * A decisão mais importante aqui: **o `op` gravado no log não é a verdade**. O
 * feed hidrata os ids pelo repositório do recurso e decide pelo ESTADO ATUAL —
 * ausente ou desabilitado vira `delete`, o resto vira `upsert`.
 *
 * Isso dá três coisas de graça: N mudanças do mesmo registro colapsam em uma; o
 * cliente nunca recebe estado intermediário (inútil para quem estava offline); e
 * o tombstone aparece sem quebrar nenhum consumidor atual da API, que dependem
 * do filtro implícito de "só habilitados".
 */
import { avancarSeq, codificarCursor, decodificarCursor, type Cursor } from '../protocol/cursor';
import { CODIGO_RESYNC, type MudancaSync, type RespostaMudancas } from '../protocol/envelope';
import type { LinhaDoLog, SnapshotDoBanco } from './changeLog';

export const LIMITE_PADRAO = 500;
export const LIMITE_MAXIMO = 2_000;

export class CursorDeOutraEntidade extends Error {
    readonly status = 400;
    constructor() {
        super('O cursor pertence a outra entidade.');
        this.name = 'CursorDeOutraEntidade';
    }
}

export class RecargaNecessaria extends Error {
    readonly status = 410;
    readonly code = CODIGO_RESYNC;
    constructor() {
        super('O cursor é anterior à retenção do change log. Refaça a carga completa.');
        this.name = 'RecargaNecessaria';
    }
}

/**
 * Cursor ausente = primeira sincronização: começa do zero, com o snapshot
 * atual. Cursor de outra entidade = erro, sempre.
 *
 * O cursor é opaco, mas opaco não é confiável — quem o devolve é o aparelho.
 * O RLS já barra na consulta; esta é a camada de cima.
 */
export const cursorDaRequisicao = (
    codificado: string | null | undefined,
    entidade: number,
    snapshot: SnapshotDoBanco,
): Cursor => {
    const cursor = decodificarCursor(codificado);
    if (!cursor) {
        return { v: 1, e: entidade, s: '0', x: snapshot.xmin, p: snapshot.snapshot };
    }
    if (cursor.e !== entidade) throw new CursorDeOutraEntidade();
    return cursor;
};

export const conferirPoda = (cursor: Cursor, podadoAbaixoDe: string | null): void => {
    if (!podadoAbaixoDe) return;
    if (BigInt(cursor.s) < BigInt(podadoAbaixoDe)) throw new RecargaNecessaria();
};

export const limiteDaRequisicao = (bruto: unknown): number => {
    const pedido = Number(bruto);
    if (!Number.isFinite(pedido) || pedido <= 0) return LIMITE_PADRAO;
    return Math.min(Math.floor(pedido), LIMITE_MAXIMO);
};

export interface RegistroHidratado {
    id: string;
    /** `null` quando o registro não existe mais ou está desabilitado. */
    dados: unknown | null;
}

export interface EntradaDoFeed {
    linhas: LinhaDoLog[];
    limite: number;
    cursor: Cursor;
    snapshot: SnapshotDoBanco;
    hidratar: (ids: string[]) => Promise<RegistroHidratado[]>;
}

export const montarRespostaDeMudancas = async ({
    linhas,
    limite,
    cursor,
    snapshot,
    hidratar,
}: EntradaDoFeed): Promise<RespostaMudancas> => {
    const temMais = linhas.length > limite;
    const doLote = temMais ? linhas.slice(0, limite) : linhas;

    if (doLote.length === 0) {
        return {
            // Sem novidade: o cursor passa a valer do snapshot atual em diante.
            cursor: codificarCursor({ ...cursor, x: snapshot.xmin, p: snapshot.snapshot }),
            hasMore: false,
            changes: [],
        };
    }

    // Um registro tocado várias vezes aparece uma vez só, com o estado final.
    const ids = [...new Set(doLote.map((linha) => linha.record_id))];
    const hidratados = await hidratar(ids);
    const porId = new Map(hidratados.map((registro) => [registro.id, registro.dados]));

    const changes: MudancaSync[] = ids.map((id) => {
        const dados = porId.get(id) ?? null;
        return dados === null ? { op: 'delete', id } : { op: 'upsert', id, row: dados };
    });

    const ultimo = doLote[doLote.length - 1]!;

    // Enquanto pagina, só o `seq` anda: o snapshot antigo é o que garante o
    // resgate das transações que ainda estavam em voo. Trocá-lo no meio
    // perderia exatamente as linhas que o cursor existe para não perder.
    const proximo = temMais
        ? avancarSeq(cursor, ultimo.seq)
        : { ...cursor, s: ultimo.seq, x: snapshot.xmin, p: snapshot.snapshot };

    return { cursor: codificarCursor(proximo), hasMore: temMais, changes };
};

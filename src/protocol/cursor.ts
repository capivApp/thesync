/**
 * O cursor do pull.
 *
 * Ele NÃO é "o instante do último sync". É a resposta para uma pergunta
 * diferente: *o que ficou visível depois deste snapshot?* — que é a única
 * pergunta que a MVCC do Postgres responde sem furos.
 *
 * Por que não um timestamp: uma transação longa (a criação de um inventário
 * semeia milhares de itens numa transação só) commita linhas cujo `updatedAt`
 * é MAIS ANTIGO do que o relógio de quem sincronizou no meio dela. Quem avança
 * uma marca d'água por tempo passa por cima dessas linhas e nunca mais as vê.
 * O par `(seq, snapshot)` resolve isso porque o resgate é feito por
 * visibilidade de transação, não por ordem de chegada.
 *
 * O cursor é OPACO para o cliente — ele guarda e devolve, nunca interpreta. Mas
 * opaco não é confiável: o servidor revalida a entidade antes de usar.
 */

export const VERSAO_CURSOR = 1;

export interface Cursor {
    /** Versão do formato; muda quando o significado dos campos mudar. */
    v: number;
    /** Entidade (tenant) dona deste cursor. Revalidada no servidor. */
    e: number;
    /** Maior `seq` já consumido. */
    s: string;
    /** `xmin` do snapshot em que este cursor foi emitido. */
    x: string;
    /** `pg_current_snapshot()` serializado (`xmin:xmax:xip_list`). */
    p: string;
}

const paraBase64Url = (texto: string): string => {
    const bytes = new TextEncoder().encode(texto);
    let binario = '';
    for (const byte of bytes) binario += String.fromCharCode(byte);
    return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const deBase64Url = (codificado: string): string => {
    const preenchido = codificado.replace(/-/g, '+').replace(/_/g, '/');
    const binario = atob(preenchido.padEnd(Math.ceil(preenchido.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binario, (caractere) => caractere.charCodeAt(0));
    return new TextDecoder().decode(bytes);
};

export const codificarCursor = (cursor: Cursor): string => paraBase64Url(JSON.stringify(cursor));

/** `null` para cursor ausente, corrompido ou de uma versão que não conhecemos. */
export const decodificarCursor = (codificado: string | null | undefined): Cursor | null => {
    if (!codificado) return null;

    try {
        const cursor = JSON.parse(deBase64Url(codificado)) as Partial<Cursor>;
        if (cursor.v !== VERSAO_CURSOR) return null;
        if (typeof cursor.e !== 'number') return null;
        if (typeof cursor.s !== 'string' || typeof cursor.x !== 'string' || typeof cursor.p !== 'string') {
            return null;
        }
        return cursor as Cursor;
    } catch {
        return null;
    }
};

/**
 * Avanço DENTRO de uma paginação: só o `seq` anda.
 *
 * O snapshot é preservado de propósito — é ele que garante o resgate das
 * transações que ainda estavam em voo quando a página 1 foi lida. Trocar o
 * snapshot no meio da paginação perderia exatamente as linhas que o cursor
 * existe para não perder.
 */
export const avancarSeq = (cursor: Cursor, seq: string): Cursor => ({ ...cursor, s: seq });

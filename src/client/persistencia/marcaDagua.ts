/**
 * Onde cada tabela parou, por escopo.
 *
 * `cursorPagina` persistido a cada página é o que faz a carga inicial RETOMAR
 * em vez de recomeçar quando o usuário mata o app no meio de um download de
 * milhares de linhas — que é o que ele faz quando a barra parece travada.
 */
import { bancoDaEntidade } from './banco';
import type { ContextoSync, EstadoTabela } from '../nucleo/tipos';

interface LinhaEstado {
    tabela: string;
    escopo: string;
    cursor: string | null;
    cursor_pagina: string | null;
    carga_completa_em: number | null;
    reconciliado_em: number | null;
    ultimo_erro: string | null;
}

const vazio = (tabela: string, escopo: string): EstadoTabela => ({
    tabela,
    escopo,
    cursor: null,
    cursorPagina: null,
    cargaCompletaEm: null,
    reconciliadoEm: null,
    ultimoErro: null,
});

export const lerEstado = async (
    contexto: ContextoSync,
    tabela: string,
): Promise<EstadoTabela> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<LinhaEstado>(
        `SELECT * FROM sincronizacao_tabelas WHERE tabela = ? AND escopo = ?;`,
        [tabela, contexto.escopo],
    );

    if (!linha) return vazio(tabela, contexto.escopo);

    return {
        tabela: linha.tabela,
        escopo: linha.escopo,
        cursor: linha.cursor,
        cursorPagina: linha.cursor_pagina,
        cargaCompletaEm: linha.carga_completa_em,
        reconciliadoEm: linha.reconciliado_em,
        ultimoErro: linha.ultimo_erro,
    };
};

export const gravarEstado = async (
    contexto: ContextoSync,
    estado: EstadoTabela,
): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(
        `INSERT INTO sincronizacao_tabelas
       (tabela, escopo, cursor, cursor_pagina, carga_completa_em, reconciliado_em, ultimo_erro)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tabela, escopo) DO UPDATE SET
       cursor = excluded.cursor,
       cursor_pagina = excluded.cursor_pagina,
       carga_completa_em = excluded.carga_completa_em,
       reconciliado_em = excluded.reconciliado_em,
       ultimo_erro = excluded.ultimo_erro;`,
        [
            estado.tabela,
            contexto.escopo,
            estado.cursor,
            estado.cursorPagina,
            estado.cargaCompletaEm,
            estado.reconciliadoEm,
            estado.ultimoErro,
        ],
    );
};

export const registrarErro = async (
    contexto: ContextoSync,
    tabela: string,
    erro: string,
): Promise<void> => {
    const estado = await lerEstado(contexto, tabela);
    await gravarEstado(contexto, { ...estado, ultimoErro: erro });
};

/** A tabela já tem uma cópia local utilizável neste escopo? */
export const temCargaCompleta = async (
    contexto: ContextoSync,
    tabela: string,
): Promise<boolean> => {
    const estado = await lerEstado(contexto, tabela);
    return estado.cargaCompletaEm !== null;
};

/**
 * Fila de anexos — separada da fila de escritas, de propósito.
 *
 * Transporte diferente (multipart), custo de retry em megabytes, e um arquivo
 * em disco que só pode ser apagado depois da confirmação. E, principalmente:
 * um upload lento no 3G NÃO pode segurar dez contagens atrás dele.
 */
import { bancoDaEntidade } from './banco';
import type { ContextoSync } from '../nucleo/tipos';

export type EstadoAnexo = 'pendente' | 'enviando' | 'bloqueado';

export interface Anexo {
    id: string;
    sequencia: number;
    entidade: number;
    tabela: string;
    registroId: string;
    campo: string;
    caminho: string;
    nomeArquivo: string;
    mime: string;
    bytes: number;
    hash: string | null;
    seguro: boolean;
    estado: EstadoAnexo;
    tentativas: number;
    proximaTentativaEm: number;
    ultimoErro: string | null;
    idRemoto: string | null;
    criadoEm: number;
}

interface LinhaAnexo {
    id: string;
    sequencia: number;
    entidade: number;
    tabela: string;
    registro_id: string;
    campo: string;
    caminho: string;
    nome_arquivo: string;
    mime: string;
    bytes: number;
    hash: string | null;
    seguro: number;
    estado: string;
    tentativas: number;
    proxima_tentativa_em: number;
    ultimo_erro: string | null;
    id_remoto: string | null;
    criado_em: number;
}

export interface NovoAnexo {
    id: string;
    tabela: string;
    registroId: string;
    campo: string;
    caminho: string;
    nomeArquivo: string;
    mime: string;
    bytes: number;
    hash?: string | null;
    seguro: boolean;
}

const paraAnexo = (linha: LinhaAnexo): Anexo => ({
    id: linha.id,
    sequencia: linha.sequencia,
    entidade: linha.entidade,
    tabela: linha.tabela,
    registroId: linha.registro_id,
    campo: linha.campo,
    caminho: linha.caminho,
    nomeArquivo: linha.nome_arquivo,
    mime: linha.mime,
    bytes: linha.bytes,
    hash: linha.hash,
    seguro: linha.seguro === 1,
    estado: linha.estado as EstadoAnexo,
    tentativas: linha.tentativas,
    proximaTentativaEm: linha.proxima_tentativa_em,
    ultimoErro: linha.ultimo_erro,
    idRemoto: linha.id_remoto,
    criadoEm: linha.criado_em,
});

const proximaSequencia = async (entidade: number): Promise<number> => {
    const banco = await bancoDaEntidade(entidade);
    const resultado = await banco.runAsync(`INSERT INTO saida_sequencia (reservado) VALUES (?);`, [
        Date.now(),
    ]);
    return resultado.lastInsertRowId;
};

/**
 * O mesmo conteúdo já esperando para o mesmo registro não entra duas vezes.
 * Cobre o duplo-toque no botão da câmera, que é a origem mais comum de foto
 * duplicada de verdade.
 */
export const jaEnfileirado = async (
    contexto: ContextoSync,
    registroId: string,
    hash: string | null,
): Promise<boolean> => {
    if (!hash) return false;
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<{ total: number }>(
        `SELECT COUNT(*) AS total FROM anexos
      WHERE entidade = ? AND registro_id = ? AND hash = ? AND estado != 'bloqueado';`,
        [contexto.entidade, registroId, hash],
    );
    return (linha?.total ?? 0) > 0;
};

export const enfileirarAnexo = async (contexto: ContextoSync, novo: NovoAnexo): Promise<Anexo> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const anexo: Anexo = {
        ...novo,
        sequencia: await proximaSequencia(contexto.entidade),
        entidade: contexto.entidade,
        hash: novo.hash ?? null,
        estado: 'pendente',
        tentativas: 0,
        proximaTentativaEm: 0,
        ultimoErro: null,
        idRemoto: null,
        criadoEm: Date.now(),
    };

    await banco.runAsync(
        `INSERT INTO anexos
       (id, sequencia, entidade, tabela, registro_id, campo, caminho, nome_arquivo, mime,
        bytes, hash, seguro, estado, tentativas, proxima_tentativa_em, ultimo_erro,
        id_remoto, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', 0, 0, NULL, NULL, ?);`,
        [
            anexo.id,
            anexo.sequencia,
            anexo.entidade,
            anexo.tabela,
            anexo.registroId,
            anexo.campo,
            anexo.caminho,
            anexo.nomeArquivo,
            anexo.mime,
            anexo.bytes,
            anexo.hash,
            anexo.seguro ? 1 : 0,
            anexo.criadoEm,
        ],
    );

    return anexo;
};

export const listarAnexos = async (
    contexto: ContextoSync,
    registroId?: string,
): Promise<Anexo[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = registroId
        ? await banco.getAllAsync<LinhaAnexo>(
            `SELECT * FROM anexos WHERE entidade = ? AND registro_id = ? ORDER BY sequencia ASC;`,
            [contexto.entidade, registroId],
        )
        : await banco.getAllAsync<LinhaAnexo>(
            `SELECT * FROM anexos WHERE entidade = ? ORDER BY sequencia ASC;`,
            [contexto.entidade],
        );
    return linhas.map(paraAnexo);
};

export const listarAnexosProntos = async (contexto: ContextoSync): Promise<Anexo[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = await banco.getAllAsync<LinhaAnexo>(
        `SELECT * FROM anexos
      WHERE entidade = ? AND estado IN ('pendente','enviando') AND proxima_tentativa_em <= ?
      ORDER BY sequencia ASC;`,
        [contexto.entidade, Date.now()],
    );
    return linhas.map(paraAnexo);
};

export const contarAnexos = async (
    contexto: ContextoSync,
): Promise<{ pendentes: number; bloqueados: number; inseguros: number }> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<{
        pendentes: number;
        bloqueados: number;
        inseguros: number;
    }>(
        `SELECT
        SUM(CASE WHEN estado IN ('pendente','enviando') THEN 1 ELSE 0 END) AS pendentes,
        SUM(CASE WHEN estado = 'bloqueado' THEN 1 ELSE 0 END) AS bloqueados,
        SUM(CASE WHEN seguro = 0 THEN 1 ELSE 0 END) AS inseguros
       FROM anexos WHERE entidade = ?;`,
        [contexto.entidade],
    );
    return {
        pendentes: linha?.pendentes ?? 0,
        bloqueados: linha?.bloqueados ?? 0,
        inseguros: linha?.inseguros ?? 0,
    };
};

export const marcarEstadoAnexo = async (
    contexto: ContextoSync,
    id: string,
    estado: EstadoAnexo,
): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(`UPDATE anexos SET estado = ? WHERE id = ?;`, [estado, id]);
};

export const registrarFalhaAnexo = async (
    contexto: ContextoSync,
    parametros: {
        id: string;
        erro: string;
        contaTentativa: boolean;
        proximaTentativaEm: number;
        estado: EstadoAnexo;
    },
): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(
        `UPDATE anexos
        SET tentativas = tentativas + ?, proxima_tentativa_em = ?, estado = ?, ultimo_erro = ?
      WHERE id = ?;`,
        [
            parametros.contaTentativa ? 1 : 0,
            parametros.proximaTentativaEm,
            parametros.estado,
            parametros.erro,
            parametros.id,
        ],
    );
};

export const removerAnexo = async (contexto: ContextoSync, id: string): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(`DELETE FROM anexos WHERE id = ?;`, [id]);
};

/**
 * Anexos que estavam em voo quando o app morreu.
 *
 * Diferente da fila de escritas, aqui o reenvio é sempre permitido: perder uma
 * foto é pior do que arriscar uma duplicata, e a deduplicação de verdade é
 * feita no servidor pela chave derivada do conteúdo.
 */
export const recuperarAnexosEmVoo = async (contexto: ContextoSync): Promise<number> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const resultado = await banco.runAsync(
        `UPDATE anexos SET estado = 'pendente' WHERE entidade = ? AND estado = 'enviando';`,
        [contexto.entidade],
    );
    return resultado.changes;
};

export const liberarAnexosBloqueados = async (contexto: ContextoSync): Promise<number> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const resultado = await banco.runAsync(
        `UPDATE anexos SET estado = 'pendente', proxima_tentativa_em = 0, ultimo_erro = NULL
      WHERE entidade = ? AND estado = 'bloqueado';`,
        [contexto.entidade],
    );
    return resultado.changes;
};

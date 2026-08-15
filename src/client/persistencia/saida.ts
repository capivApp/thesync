/**
 * A fila de escritas.
 *
 * TODA escrita passa por aqui, inclusive com internet. Um caminho de código só,
 * a ordem das ações do usuário preservada, e o registro da intenção em disco
 * ANTES de qualquer tentativa de rede — se o app morrer entre o toque e a
 * resposta, nada se perde.
 *
 * O `id` da linha É a chave de idempotência. Dois identificadores para a mesma
 * coisa seriam duas coisas para manter em sincronia, com zero benefício.
 */
import { randomUUID } from 'expo-crypto';

import { bancoDaEntidade } from './banco';
import type { ContextoSync, OperacaoEscrita } from '../nucleo/tipos';

export type EstadoPendencia = 'pendente' | 'enviando' | 'bloqueada' | 'conflito';

export interface Pendencia {
    id: string;
    sequencia: number;
    entidade: number;
    tabela: string;
    registroId: string;
    operacao: OperacaoEscrita;
    payload: Record<string, unknown>;
    camposAlterados: string[];
    baseUpdatedAt: string | null;
    dependeDe: string[];
    estado: EstadoPendencia;
    tentativas: number;
    proximaTentativaEm: number;
    ultimoErro: string | null;
    ultimoStatusHttp: number | null;
    criadoEm: number;
    atualizadoEm: number;
}

interface LinhaSaida {
    id: string;
    sequencia: number;
    entidade: number;
    tabela: string;
    registro_id: string;
    operacao: string;
    payload: string;
    campos_alterados: string;
    base_updated_at: string | null;
    depende_de: string | null;
    estado: string;
    tentativas: number;
    proxima_tentativa_em: number;
    ultimo_erro: string | null;
    ultimo_status_http: number | null;
    criado_em: number;
    atualizado_em: number;
}

export interface NovaPendencia {
    tabela: string;
    registroId: string;
    operacao: OperacaoEscrita;
    payload: Record<string, unknown>;
    camposAlterados?: string[];
    baseUpdatedAt?: string | null;
    dependeDe?: string[];
}

const paraPendencia = (linha: LinhaSaida): Pendencia => ({
    id: linha.id,
    sequencia: linha.sequencia,
    entidade: linha.entidade,
    tabela: linha.tabela,
    registroId: linha.registro_id,
    operacao: linha.operacao as OperacaoEscrita,
    payload: JSON.parse(linha.payload) as Record<string, unknown>,
    camposAlterados: JSON.parse(linha.campos_alterados) as string[],
    baseUpdatedAt: linha.base_updated_at,
    dependeDe: linha.depende_de ? (JSON.parse(linha.depende_de) as string[]) : [],
    estado: linha.estado as EstadoPendencia,
    tentativas: linha.tentativas,
    proximaTentativaEm: linha.proxima_tentativa_em,
    ultimoErro: linha.ultimo_erro,
    ultimoStatusHttp: linha.ultimo_status_http,
    criadoEm: linha.criado_em,
    atualizadoEm: linha.atualizado_em,
});

/**
 * Sequência monotônica vinda do SQLite.
 *
 * Nunca `Date.now()`: o relógio do aparelho anda para trás quando o usuário
 * corrige a hora ou o NTP sincroniza, e aí as ações sobem fora de ordem —
 * "marquei encontrado e depois adicionei a observação" vira o contrário.
 */
const proximaSequencia = async (entidade: number): Promise<number> => {
    const banco = await bancoDaEntidade(entidade);
    const resultado = await banco.runAsync(
        `INSERT INTO saida_sequencia (reservado) VALUES (?);`,
        [Date.now()],
    );
    return resultado.lastInsertRowId;
};

/**
 * Junta uma edição nova a uma que ainda não subiu, do mesmo registro.
 *
 * Sem isso, trinta toques no mesmo item viram trinta requisições. A chave de
 * idempotência da linha resultante é NOVA de propósito: o payload mudou, e
 * reaproveitar a antiga faria o servidor replicar a resposta do payload velho.
 */
const coalescer = async (
    contexto: ContextoSync,
    nova: NovaPendencia,
): Promise<Pendencia | null> => {
    if (nova.operacao !== 'atualizar') return null;

    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<LinhaSaida>(
        `SELECT * FROM saida
      WHERE entidade = ? AND tabela = ? AND registro_id = ?
        AND estado = 'pendente' AND operacao IN ('criar', 'atualizar')
      ORDER BY sequencia DESC LIMIT 1;`,
        [contexto.entidade, nova.tabela, nova.registroId],
    );
    if (!linha) return null;

    const anterior = paraPendencia(linha);
    const payload = { ...anterior.payload, ...nova.payload };
    const campos = [...new Set([...anterior.camposAlterados, ...(nova.camposAlterados ?? [])])];
    const idNovo = randomUUID();
    const agora = Date.now();

    await banco.runAsync(
        `UPDATE saida
        SET id = ?, payload = ?, campos_alterados = ?, atualizado_em = ?,
            tentativas = 0, proxima_tentativa_em = 0, ultimo_erro = NULL
      WHERE id = ?;`,
        [idNovo, JSON.stringify(payload), JSON.stringify(campos), agora, anterior.id],
    );

    return { ...anterior, id: idNovo, payload, camposAlterados: campos, atualizadoEm: agora };
};

export const enfileirar = async (
    contexto: ContextoSync,
    nova: NovaPendencia,
): Promise<Pendencia> => {
    const coalescida = await coalescer(contexto, nova);
    if (coalescida) return coalescida;

    const banco = await bancoDaEntidade(contexto.entidade);
    const agora = Date.now();
    const pendencia: Pendencia = {
        id: randomUUID(),
        sequencia: await proximaSequencia(contexto.entidade),
        entidade: contexto.entidade,
        tabela: nova.tabela,
        registroId: nova.registroId,
        operacao: nova.operacao,
        payload: nova.payload,
        camposAlterados: nova.camposAlterados ?? Object.keys(nova.payload),
        baseUpdatedAt: nova.baseUpdatedAt ?? null,
        dependeDe: nova.dependeDe ?? [],
        estado: 'pendente',
        tentativas: 0,
        proximaTentativaEm: 0,
        ultimoErro: null,
        ultimoStatusHttp: null,
        criadoEm: agora,
        atualizadoEm: agora,
    };

    await banco.runAsync(
        `INSERT INTO saida
       (id, sequencia, entidade, tabela, registro_id, operacao, payload, campos_alterados,
        base_updated_at, depende_de, estado, tentativas, proxima_tentativa_em,
        ultimo_erro, ultimo_status_http, criado_em, atualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', 0, 0, NULL, NULL, ?, ?);`,
        [
            pendencia.id,
            pendencia.sequencia,
            pendencia.entidade,
            pendencia.tabela,
            pendencia.registroId,
            pendencia.operacao,
            JSON.stringify(pendencia.payload),
            JSON.stringify(pendencia.camposAlterados),
            pendencia.baseUpdatedAt,
            JSON.stringify(pendencia.dependeDe),
            pendencia.criadoEm,
            pendencia.atualizadoEm,
        ],
    );

    return pendencia;
};

/** Fila inteira do escopo, na ordem em que o usuário agiu. */
export const listarPendencias = async (
    contexto: ContextoSync,
    tabela?: string,
): Promise<Pendencia[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = tabela
        ? await banco.getAllAsync<LinhaSaida>(
            `SELECT * FROM saida WHERE entidade = ? AND tabela = ? ORDER BY sequencia ASC;`,
            [contexto.entidade, tabela],
        )
        : await banco.getAllAsync<LinhaSaida>(
            `SELECT * FROM saida WHERE entidade = ? ORDER BY sequencia ASC;`,
            [contexto.entidade],
        );
    return linhas.map(paraPendencia);
};

/** Só as que o motor pode tentar sozinho agora. */
export const listarProntas = async (contexto: ContextoSync): Promise<Pendencia[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = await banco.getAllAsync<LinhaSaida>(
        `SELECT * FROM saida
      WHERE entidade = ? AND estado IN ('pendente', 'enviando') AND proxima_tentativa_em <= ?
      ORDER BY sequencia ASC;`,
        [contexto.entidade, Date.now()],
    );
    return linhas.map(paraPendencia);
};

export interface ContagemFila {
    pendentes: number;
    bloqueadas: number;
    conflitos: number;
}

export const contarPendencias = async (contexto: ContextoSync): Promise<ContagemFila> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<{ pendentes: number; bloqueadas: number; conflitos: number }>(
        `SELECT
        SUM(CASE WHEN estado IN ('pendente','enviando') THEN 1 ELSE 0 END) AS pendentes,
        SUM(CASE WHEN estado = 'bloqueada' THEN 1 ELSE 0 END) AS bloqueadas,
        SUM(CASE WHEN estado = 'conflito' THEN 1 ELSE 0 END) AS conflitos
       FROM saida WHERE entidade = ?;`,
        [contexto.entidade],
    );
    return {
        pendentes: linha?.pendentes ?? 0,
        bloqueadas: linha?.bloqueadas ?? 0,
        conflitos: linha?.conflitos ?? 0,
    };
};

/** Idade da pendência mais antiga — o número que mais diz se algo travou. */
export const idadeDaMaisAntiga = async (contexto: ContextoSync): Promise<number | null> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<{ criado_em: number }>(
        `SELECT criado_em FROM saida WHERE entidade = ? AND estado != 'bloqueada'
      ORDER BY sequencia ASC LIMIT 1;`,
        [contexto.entidade],
    );
    return linha ? Date.now() - linha.criado_em : null;
};

export const marcarEstado = async (
    contexto: ContextoSync,
    id: string,
    estado: EstadoPendencia,
): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(`UPDATE saida SET estado = ?, atualizado_em = ? WHERE id = ?;`, [
        estado,
        Date.now(),
        id,
    ]);
};

export const removerPendencia = async (contexto: ContextoSync, id: string): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(`DELETE FROM saida WHERE id = ?;`, [id]);
};

export interface RegistroDeFalha {
    id: string;
    erro: string;
    status?: number;
    /** `false` para erro de rede: a fila reprograma sem gastar tentativa. */
    contaTentativa: boolean;
    proximaTentativaEm: number;
    estado: EstadoPendencia;
}

export const registrarFalha = async (
    contexto: ContextoSync,
    falha: RegistroDeFalha,
): Promise<void> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.runAsync(
        `UPDATE saida
        SET tentativas = tentativas + ?,
            proxima_tentativa_em = ?,
            estado = ?,
            ultimo_erro = ?,
            ultimo_status_http = ?,
            atualizado_em = ?
      WHERE id = ?;`,
        [
            falha.contaTentativa ? 1 : 0,
            falha.proximaTentativaEm,
            falha.estado,
            falha.erro,
            falha.status ?? null,
            Date.now(),
            falha.id,
        ],
    );
};

/**
 * Devolve à fila o que estava `enviando` quando o app morreu.
 *
 * `atualizar` é seguro reenviar (o PUT leva o estado que o usuário quer). Para
 * `criar` o reenvio só é seguro quando o id é do cliente — por isso quem chama
 * decide, com base na declaração da tabela.
 */
export const recuperarEmVoo = async (
    contexto: ContextoSync,
    ehSeguroReenviar: (pendencia: Pendencia) => boolean,
): Promise<Pendencia[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = await banco.getAllAsync<LinhaSaida>(
        `SELECT * FROM saida WHERE entidade = ? AND estado = 'enviando';`,
        [contexto.entidade],
    );

    const emVoo = linhas.map(paraPendencia);
    const duvidosas: Pendencia[] = [];

    for (const pendencia of emVoo) {
        const destino: EstadoPendencia = ehSeguroReenviar(pendencia) ? 'pendente' : 'conflito';
        if (destino === 'conflito') duvidosas.push(pendencia);
        await banco.runAsync(
            `UPDATE saida SET estado = ?, atualizado_em = ? WHERE id = ?;`,
            [destino, Date.now(), pendencia.id],
        );
    }

    return duvidosas;
};

/** "Tentar novamente" da tela: devolve as bloqueadas para a fila automática. */
export const liberarBloqueadas = async (contexto: ContextoSync): Promise<number> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const resultado = await banco.runAsync(
        `UPDATE saida SET estado = 'pendente', proxima_tentativa_em = 0, ultimo_erro = NULL,
          atualizado_em = ?
      WHERE entidade = ? AND estado IN ('bloqueada', 'conflito');`,
        [Date.now(), contexto.entidade],
    );
    return resultado.changes;
};

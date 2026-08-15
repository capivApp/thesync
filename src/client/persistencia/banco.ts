/**
 * Conexão com o banco local.
 *
 * Um ARQUIVO POR ENTIDADE. No servidor, entidade é isolamento de verdade (RLS
 * de Postgres); no aparelho, misturar dois tenants no mesmo arquivo seria um
 * vazamento à espera de um `WHERE` esquecido.
 *
 * O arquivo também é separado de qualquer banco de sessão do app: um `clear()`
 * de logout não pode apagar a contagem que alguém passou o dia fazendo.
 */
import * as SQLite from 'expo-sqlite';

import { MIGRACOES, VERSAO_ALVO } from './migracoes';

export type BancoLocal = SQLite.SQLiteDatabase;

const conexoes = new Map<number, Promise<BancoLocal>>();

export const nomeDoBanco = (entidade: number): string => `thesync_${entidade}.db`;

const lerVersao = async (banco: BancoLocal): Promise<number> => {
    const linha = await banco.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
    return linha?.user_version ?? 0;
};

const migrar = async (banco: BancoLocal): Promise<void> => {
    const versaoAtual = await lerVersao(banco);
    if (versaoAtual >= VERSAO_ALVO) return;

    const pendentes = MIGRACOES.filter((migracao) => migracao.versao > versaoAtual).sort(
        (uma, outra) => uma.versao - outra.versao,
    );

    for (const migracao of pendentes) {
        // Cada migração em sua própria transação: se a 3 falhar, a 2 continua
        // aplicada e a próxima abertura retoma de onde parou.
        await banco.execAsync('BEGIN;');
        try {
            await banco.execAsync(migracao.sql);
            await banco.execAsync(`PRAGMA user_version = ${migracao.versao};`);
            await banco.execAsync('COMMIT;');
        } catch (erro) {
            await banco.execAsync('ROLLBACK;').catch(() => undefined);
            throw erro;
        }
    }
};

const abrir = async (entidade: number): Promise<BancoLocal> => {
    const banco = await SQLite.openDatabaseAsync(nomeDoBanco(entidade));
    // WAL: leitura da tela não bloqueia a gravação do sync, e vice-versa.
    await banco.execAsync('PRAGMA journal_mode = WAL;');
    await banco.execAsync('PRAGMA synchronous = NORMAL;');
    await banco.execAsync('PRAGMA foreign_keys = ON;');
    await migrar(banco);
    return banco;
};

/** Conexão única por entidade. Uma falha na abertura não fica memorizada. */
export const bancoDaEntidade = (entidade: number): Promise<BancoLocal> => {
    const existente = conexoes.get(entidade);
    if (existente) return existente;

    const nova = abrir(entidade).catch((erro) => {
        conexoes.delete(entidade);
        throw erro;
    });
    conexoes.set(entidade, nova);
    return nova;
};

/**
 * Fecha as conexões abertas. Serve para troca de entidade e para testes.
 * NÃO apaga arquivo: dado de campo só some por decisão explícita do usuário.
 */
export const fecharBancos = async (): Promise<void> => {
    const abertas = [...conexoes.values()];
    conexoes.clear();
    await Promise.all(
        abertas.map((promessa) => promessa.then((banco) => banco.closeAsync()).catch(() => undefined)),
    );
};

/**
 * Apaga TUDO de uma entidade. Só deve ser chamado por uma ação explícita de
 * "limpar dados offline", e só com a fila vazia — quem chama é responsável por
 * conferir isso.
 */
export const apagarDadosDaEntidade = async (entidade: number): Promise<void> => {
    const banco = await bancoDaEntidade(entidade);
    await banco.execAsync(`
    DELETE FROM registros;
    DELETE FROM indice_registros;
    DELETE FROM sincronizacao_tabelas;
    DELETE FROM saida;
    DELETE FROM anexos;
    DELETE FROM conflitos;
    DELETE FROM mapa_ids;
  `);
};

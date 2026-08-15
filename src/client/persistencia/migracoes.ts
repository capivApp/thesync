/**
 * Migrações do banco local, por `PRAGMA user_version`.
 *
 * Regra: uma migração publicada NUNCA é editada. O banco dela já existe no
 * aparelho de alguém que está em campo, sem internet, com meio inventário
 * contado. Correção vira migração nova.
 */

export interface Migracao {
    versao: number;
    sql: string;
}

export const MIGRACOES: Migracao[] = [
    {
        versao: 1,
        sql: `
      -- ESPELHO: a verdade do servidor. Nunca a tela já editada.
      CREATE TABLE IF NOT EXISTS registros (
        entidade    INTEGER NOT NULL,
        tabela      TEXT    NOT NULL,
        id          TEXT    NOT NULL,
        dados       TEXT    NOT NULL,
        updated_at  TEXT,
        origem      TEXT    NOT NULL DEFAULT 'servidor',
        excluido    INTEGER NOT NULL DEFAULT 0,
        visto_em    INTEGER NOT NULL,
        baixado_em  INTEGER NOT NULL,
        PRIMARY KEY (entidade, tabela, id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS ix_registros_tabela
        ON registros (entidade, tabela, excluido);

      -- Colunas projetadas pela declaração da tabela, para as consultas que
      -- não podem carregar o conjunto inteiro (contadores, recortes).
      CREATE TABLE IF NOT EXISTS indice_registros (
        entidade    INTEGER NOT NULL,
        tabela      TEXT    NOT NULL,
        coluna      TEXT    NOT NULL,
        id          TEXT    NOT NULL,
        valor_texto TEXT,
        valor_num   REAL,
        PRIMARY KEY (entidade, tabela, coluna, id)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS ix_indice_texto
        ON indice_registros (entidade, tabela, coluna, valor_texto);
      CREATE INDEX IF NOT EXISTS ix_indice_num
        ON indice_registros (entidade, tabela, coluna, valor_num);

      CREATE TABLE IF NOT EXISTS sincronizacao_tabelas (
        tabela              TEXT    NOT NULL,
        escopo              TEXT    NOT NULL DEFAULT '',
        cursor              TEXT,
        cursor_pagina       TEXT,
        carga_completa_em   INTEGER,
        reconciliado_em     INTEGER,
        ultimo_erro         TEXT,
        PRIMARY KEY (tabela, escopo)
      ) WITHOUT ROWID;
    `,
    },
    {
        versao: 2,
        sql: `
      -- FILA DE ESCRITAS. 'id' É a chave de idempotência: uma identidade por
      -- mutação, reaproveitada em toda tentativa.
      CREATE TABLE IF NOT EXISTS saida (
        id                   TEXT    PRIMARY KEY NOT NULL,
        sequencia            INTEGER NOT NULL,
        entidade             INTEGER NOT NULL,
        tabela               TEXT    NOT NULL,
        registro_id          TEXT    NOT NULL,
        operacao             TEXT    NOT NULL,
        payload              TEXT    NOT NULL,
        campos_alterados     TEXT    NOT NULL DEFAULT '[]',
        base_updated_at      TEXT,
        depende_de           TEXT,
        estado               TEXT    NOT NULL DEFAULT 'pendente',
        tentativas           INTEGER NOT NULL DEFAULT 0,
        proxima_tentativa_em INTEGER NOT NULL DEFAULT 0,
        ultimo_erro          TEXT,
        ultimo_status_http   INTEGER,
        criado_em            INTEGER NOT NULL,
        atualizado_em        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ix_saida_pronta
        ON saida (estado, proxima_tentativa_em, sequencia);
      CREATE INDEX IF NOT EXISTS ix_saida_registro
        ON saida (tabela, registro_id, sequencia);

      -- A sequência é dona da ordem. Relógio de aparelho anda para trás quando
      -- o NTP sincroniza, e aí as ações do usuário sobem fora de ordem.
      CREATE TABLE IF NOT EXISTS saida_sequencia (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        reservado INTEGER NOT NULL
      );

      -- FILA DE ANEXOS. Separada: transporte multipart, retry em megabytes e um
      -- arquivo em disco que só pode ser apagado depois da confirmação.
      CREATE TABLE IF NOT EXISTS anexos (
        id                   TEXT    PRIMARY KEY NOT NULL,
        sequencia            INTEGER NOT NULL,
        entidade             INTEGER NOT NULL,
        tabela               TEXT    NOT NULL,
        registro_id          TEXT    NOT NULL,
        campo                TEXT    NOT NULL,
        caminho              TEXT    NOT NULL,
        nome_arquivo         TEXT    NOT NULL,
        mime                 TEXT    NOT NULL,
        bytes                INTEGER NOT NULL DEFAULT 0,
        hash                 TEXT,
        seguro               INTEGER NOT NULL DEFAULT 1,
        estado               TEXT    NOT NULL DEFAULT 'pendente',
        tentativas           INTEGER NOT NULL DEFAULT 0,
        proxima_tentativa_em INTEGER NOT NULL DEFAULT 0,
        ultimo_erro          TEXT,
        id_remoto            TEXT,
        criado_em            INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ix_anexos_pronto
        ON anexos (estado, proxima_tentativa_em, sequencia);
      CREATE INDEX IF NOT EXISTS ix_anexos_registro
        ON anexos (tabela, registro_id);
    `,
    },
    {
        versao: 3,
        sql: `
      -- CONFLITOS: o que o usuário fez e o servidor não aceitou como está.
      -- Nada aqui é descartado sem decisão explícita dele.
      CREATE TABLE IF NOT EXISTS conflitos (
        id              TEXT    PRIMARY KEY NOT NULL,
        entidade        INTEGER NOT NULL,
        tabela          TEXT    NOT NULL,
        registro_id     TEXT    NOT NULL,
        campos          TEXT    NOT NULL,
        minha_versao    TEXT    NOT NULL,
        versao_servidor TEXT    NOT NULL,
        resolucao       TEXT,
        criado_em       INTEGER NOT NULL,
        resolvido_em    INTEGER
      );

      CREATE INDEX IF NOT EXISTS ix_conflitos_abertos
        ON conflitos (entidade, resolvido_em);

      -- Id local -> id do servidor, para o modo em que o servidor decide o id.
      CREATE TABLE IF NOT EXISTS mapa_ids (
        tabela      TEXT    NOT NULL,
        id_local    TEXT    NOT NULL,
        id_servidor TEXT    NOT NULL,
        criado_em   INTEGER NOT NULL,
        PRIMARY KEY (tabela, id_local)
      ) WITHOUT ROWID;

      CREATE UNIQUE INDEX IF NOT EXISTS ux_mapa_servidor
        ON mapa_ids (tabela, id_servidor);
    `,
    },
];

export const VERSAO_ALVO = MIGRACOES.reduce((maior, migracao) => Math.max(maior, migracao.versao), 0);

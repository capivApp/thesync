import { describe, expect, it } from 'bun:test';

import { definirTabela } from '../nucleo/tipos';
import type { Pendencia } from '../persistencia/saida';
import { collectCriacoesPendentes, isAguardandoReferencia } from './referencias';

const semLeitura = {
    estrategia: {
        nome: 'nenhuma',
        puxar: async () => ({ registros: [], excluidos: [], completo: false, temMais: false }),
    },
};

const item = definirTabela<any>({
    nome: 'inventario_item',
    modo: 'leitura-escrita',
    chavePrimaria: 'id',
    leitura: semLeitura,
    conflito: 'campo-a-campo',
    referencias: [
        { campo: 'local_encontrado', tabela: 'localizacao' },
        { campo: 'bem.subLocalizacao_id', tabela: 'sublocalizacao' },
    ],
    descrever: () => 'item',
});

const pendencia = (parcial: Partial<Pendencia>): Pendencia => ({
    id: crypto.randomUUID(),
    sequencia: 1,
    entidade: 1,
    tabela: 'inventario_item',
    registroId: 'item-1',
    operacao: 'atualizar',
    payload: {},
    camposAlterados: [],
    baseUpdatedAt: null,
    baseVersion: null,
    dependeDe: [],
    estado: 'pendente',
    tentativas: 0,
    proximaTentativaEm: 0,
    ultimoErro: null,
    ultimoStatusHttp: null,
    criadoEm: 0,
    atualizadoEm: 0,
    ...parcial,
});

describe('collectCriacoesPendentes', () => {
    it('junta, por tabela, os ids que ainda não foram criados no servidor', () => {
        const criacoes = collectCriacoesPendentes([
            pendencia({ tabela: 'localizacao', registroId: 'loc-1', operacao: 'criar' }),
            pendencia({ tabela: 'localizacao', registroId: 'loc-2', operacao: 'criar', estado: 'bloqueada' }),
            pendencia({ tabela: 'localizacao', registroId: 'loc-3', operacao: 'atualizar' }),
        ]);

        expect([...(criacoes.get('localizacao') ?? [])]).toEqual(['loc-1', 'loc-2']);
    });
});

describe('isAguardandoReferencia', () => {
    const criacoes = collectCriacoesPendentes([
        pendencia({ tabela: 'localizacao', registroId: 'loc-nova', operacao: 'criar' }),
        pendencia({ tabela: 'sublocalizacao', registroId: 'sub-nova', operacao: 'criar' }),
        pendencia({ tabela: 'inventario_item', registroId: 'item-novo', operacao: 'criar' }),
    ]);

    it('espera quando aponta para uma localização que ainda não subiu', () => {
        const aponta = pendencia({ payload: { local_encontrado: 'loc-nova' } });
        expect(isAguardandoReferencia(item, aponta, criacoes)).toBe(true);
    });

    it('segue o caminho do campo aninhado', () => {
        const aponta = pendencia({ payload: { bem: { subLocalizacao_id: 'sub-nova' } } });
        expect(isAguardandoReferencia(item, aponta, criacoes)).toBe(true);
    });

    it('segue quando a referência já existe no servidor', () => {
        const aponta = pendencia({ payload: { local_encontrado: 'loc-antiga' } });
        expect(isAguardandoReferencia(item, aponta, criacoes)).toBe(false);
    });

    it('a edição de um registro espera a criação dele', () => {
        const edicao = pendencia({ registroId: 'item-novo', payload: { status: 'ENCONTRADO' } });
        expect(isAguardandoReferencia(item, edicao, criacoes)).toBe(true);
    });

    it('a própria criação não espera por si mesma', () => {
        const criacao = pendencia({ registroId: 'item-novo', operacao: 'criar' });
        expect(isAguardandoReferencia(item, criacao, criacoes)).toBe(false);
    });
});

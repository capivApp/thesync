import { describe, expect, it } from 'bun:test';

import { definirTabela } from '../nucleo/tipos';
import { gravarLote, lerRegistro, listarRegistros } from './registros';

const tabela = definirTabela<any>({
    nome: 'inventario_item',
    modo: 'leitura-escrita',
    chavePrimaria: 'id',
    leitura: { estrategia: { nome: 'nenhuma', puxar: async () => ({ registros: [], excluidos: [], completo: false, temMais: false }) } },
    conflito: 'campo-a-campo',
});

describe('gravarLote parcial', () => {
    const noInventario = { entidade: 1, escopo: 'inv-1' };
    const semEscopo = { entidade: 1, escopo: '' };

    it('mescla o recorte sem tirar a linha do escopo em que ela estava', async () => {
        await gravarLote(noInventario, tabela, [
            { id: 'item-1', inventarioId: 'inv-1', status: 'NAO_INICIADO', bem: { name: 'Mesa' } },
        ]);

        // A drenagem grava com o contexto SEM escopo: é assim que os gatilhos a chamam.
        await gravarLote(semEscopo, tabela, [{ id: 'item-1', status: 'ENCONTRADO' }], { parcial: true });

        const noEscopo = await listarRegistros<any>(noInventario, 'inventario_item');
        expect(noEscopo.map((registro) => registro.id)).toEqual(['item-1']);
        expect(noEscopo[0]?.dados).toEqual({
            id: 'item-1',
            inventarioId: 'inv-1',
            status: 'ENCONTRADO',
            bem: { name: 'Mesa' },
        });
    });

    it('a gravação inteira continua readotando a linha para o escopo da carga', async () => {
        await gravarLote({ entidade: 2, escopo: '' }, tabela, [{ id: 'item-2', status: 'NAO_INICIADO' }]);
        await gravarLote({ entidade: 2, escopo: 'inv-2' }, tabela, [{ id: 'item-2', status: 'NAO_INICIADO' }]);

        expect(await listarRegistros({ entidade: 2, escopo: 'inv-2' }, 'inventario_item')).toHaveLength(1);
        expect(await listarRegistros({ entidade: 2, escopo: '' }, 'inventario_item')).toHaveLength(0);
    });

    it('recorte de linha que não existe entra no escopo do contexto', async () => {
        await gravarLote({ entidade: 3, escopo: 'inv-3' }, tabela, [{ id: 'novo', status: 'ENCONTRADO' }], {
            parcial: true,
        });
        expect((await lerRegistro<any>({ entidade: 3, escopo: 'inv-3' }, 'inventario_item', 'novo'))?.dados).toEqual({
            id: 'novo',
            status: 'ENCONTRADO',
        });
        expect(await listarRegistros({ entidade: 3, escopo: 'inv-3' }, 'inventario_item')).toHaveLength(1);
    });
});

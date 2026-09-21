import { describe, expect, it } from 'bun:test';

import { definirTabela } from '../nucleo/tipos';
import { gravarLote, lerRegistro, listarRegistros, marcarExcluidos, reconciliarConjunto } from './registros';

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

/**
 * Gravações concorrentes na MESMA conexão: rotina de fundo, socket, drenagem e
 * carga escrevem ao mesmo tempo. Sem trava, o segundo `BEGIN` falha, o
 * `ROLLBACK` dele derruba a transação do primeiro, e o `COMMIT` do primeiro
 * morre com "cannot rollback - no transaction is active".
 */
describe('transações concorrentes na mesma entidade', () => {
    const contexto = { entidade: 10, escopo: 'inv-10' };

    it('dois lotes ao mesmo tempo gravam os dois sem erro', async () => {
        await Promise.all([
            gravarLote(contexto, tabela, [{ id: 'a-1' }, { id: 'a-2' }]),
            gravarLote(contexto, tabela, [{ id: 'b-1' }, { id: 'b-2' }]),
            gravarLote(contexto, tabela, [{ id: 'c-1' }], { parcial: true }),
        ]);

        const ids = (await listarRegistros(contexto, 'inventario_item')).map((registro) => registro.id).sort();
        expect(ids).toEqual(['a-1', 'a-2', 'b-1', 'b-2', 'c-1']);
    });

    it('gravar e marcar excluído ao mesmo tempo respeitam a ordem de chegada', async () => {
        await gravarLote(contexto, tabela, [{ id: 'd-1' }]);

        await Promise.all([
            marcarExcluidos(contexto, 'inventario_item', ['d-1']),
            gravarLote(contexto, tabela, [{ id: 'd-2' }]),
        ]);

        const ids = (await listarRegistros(contexto, 'inventario_item')).map((registro) => registro.id);
        expect(ids).not.toContain('d-1');
        expect(ids).toContain('d-2');
    });
});

describe('reconciliarConjunto', () => {
    it('não apaga o registro criado no aparelho que o servidor ainda não conhece', async () => {
        const contexto = { entidade: 20, escopo: '' };
        await gravarLote(contexto, tabela, [{ id: 'do-servidor' }, { id: 'sumiu' }]);
        await gravarLote(contexto, tabela, [{ id: 'criado-offline' }], 'local');

        const sumidos = await reconciliarConjunto(contexto, 'inventario_item', ['do-servidor']);

        expect(sumidos).toEqual(['sumiu']);
        const restantes = await listarRegistros(contexto, 'inventario_item');
        expect(restantes.map((registro) => registro.id).sort()).toEqual(['criado-offline', 'do-servidor']);
    });

    it('depois que o servidor devolve o registro, ele volta a ser reconciliado', async () => {
        const contexto = { entidade: 21, escopo: '' };
        await gravarLote(contexto, tabela, [{ id: 'criado-offline' }], 'local');
        await gravarLote(contexto, tabela, [{ id: 'criado-offline', name: 'Sala 12' }]);

        expect(await reconciliarConjunto(contexto, 'inventario_item', [])).toEqual(['criado-offline']);
    });
});

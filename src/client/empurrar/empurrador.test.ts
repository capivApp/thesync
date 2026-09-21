import { describe, expect, it } from 'bun:test';

import type { Falha } from '../../protocol/erros';
import type { RequisicaoEscrita, Transporte } from '../../protocol/transporte';
import { Emissor } from '../nucleo/eventos';
import { criarRegistroDeTabelas } from '../nucleo/registro';
import { definirTabela } from '../nucleo/tipos';
import { enfileirar, listarPendencias } from '../persistencia/saida';
import { Empurrador } from './empurrador';

const semLeitura = {
    estrategia: {
        nome: 'nenhuma',
        puxar: async () => ({ registros: [], excluidos: [], completo: false, temMais: false }),
    },
};

const localizacao = definirTabela<any>({
    nome: 'localizacao',
    modo: 'leitura-escrita',
    chavePrimaria: 'id',
    leitura: semLeitura,
    escrita: {
        estrategiaId: 'id-do-cliente',
        criar: (registro) => ({ metodo: 'PUT', rota: `/localizacao/sync/${registro.id}`, corpo: registro }),
        atualizar: (campos, id) => ({ metodo: 'PUT', rota: `/localizacao/sync/${id}`, corpo: campos }),
    },
    conflito: 'cliente-vence',
    descrever: () => 'localização',
});

const item = definirTabela<any>({
    nome: 'inventario_item',
    modo: 'leitura-escrita',
    chavePrimaria: 'id',
    leitura: semLeitura,
    escrita: {
        estrategiaId: 'id-do-servidor',
        atualizar: (campos, id) => ({ metodo: 'PUT', rota: `/item/${id}`, corpo: campos }),
    },
    conflito: 'campo-a-campo',
    dependeDe: ['localizacao'],
    referencias: [{ campo: 'local_encontrado', tabela: 'localizacao' }],
    descrever: () => 'item',
});

/** Servidor de mentira: guarda a ordem das chamadas e recusa as rotas pedidas. */
const buildTransporte = (entidade: number, recusar: (rota: string) => boolean) => {
    const chamadas: string[] = [];
    const transporte: Transporte = {
        listar: async () => ({ registros: [] }),
        escrever: async (requisicao: RequisicaoEscrita) => {
            chamadas.push(requisicao.rota);
            if (recusar(requisicao.rota)) throw new Error('500');
            return {};
        },
        enviarArquivo: async () => ({}),
        classificar: (): Falha => ({ tipo: 'servidor', mensagem: 'erro do servidor', semResposta: false }),
        entidadeAtual: () => entidade,
    };
    return { transporte, chamadas };
};

const buildEmpurrador = (transporte: Transporte) =>
    new Empurrador(criarRegistroDeTabelas([localizacao, item]), transporte, new Emissor());

const enqueueLocalEItem = async (contexto: { entidade: number; escopo: string }) => {
    await enfileirar(contexto, {
        tabela: 'localizacao',
        registroId: 'loc-nova',
        operacao: 'criar',
        payload: { id: 'loc-nova', name: 'Almoxarifado' },
    });
    await enfileirar(contexto, {
        tabela: 'inventario_item',
        registroId: 'item-1',
        operacao: 'atualizar',
        payload: { local_encontrado: 'loc-nova' },
    });
};

describe('Empurrador: referência a registro criado offline', () => {
    it('o item só sobe depois que a localização que ele aponta foi criada', async () => {
        const contexto = { entidade: 101, escopo: '' };
        await enqueueLocalEItem(contexto);
        const { transporte, chamadas } = buildTransporte(101, () => false);

        const resultado = await buildEmpurrador(transporte).drenar(contexto);

        expect(chamadas).toEqual(['/localizacao/sync/loc-nova', '/item/item-1']);
        expect(resultado.enviadas).toBe(2);
    });

    it('se a criação da localização falha, o item espera na fila sem gastar tentativa', async () => {
        const contexto = { entidade: 102, escopo: '' };
        await enqueueLocalEItem(contexto);
        const { transporte, chamadas } = buildTransporte(102, (rota) => rota.startsWith('/localizacao'));

        const resultado = await buildEmpurrador(transporte).drenar(contexto);

        expect(chamadas).toEqual(['/localizacao/sync/loc-nova']);
        expect(resultado.falhas).toBe(1);

        const itemNaFila = (await listarPendencias(contexto, 'inventario_item'))[0];
        expect(itemNaFila?.estado).toBe('pendente');
        expect(itemNaFila?.tentativas).toBe(0);
    });
});

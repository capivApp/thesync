import { describe, expect, it } from 'bun:test';

import { arquivosNoDisco } from '../../../test/expoFileSystemMock';
import type { Falha } from '../../protocol/erros';
import type { RequisicaoEscrita, Transporte } from '../../protocol/transporte';
import { enfileirarAnexo, listarAnexos } from '../persistencia/anexos';
import { lerRegistro } from '../persistencia/registros';
import { enfileirar, listarPendencias } from '../persistencia/saida';
import type { EventosSync } from './eventos';
import { criarMotor, DescarteBloqueadoError } from './motor';
import { definirTabela } from './tipos';

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
    referencias: [{ campo: 'local_encontrado', tabela: 'localizacao' }],
});

/**
 * Servidor de mentira que PRENDE a primeira escrita: a requisição sai e nunca
 * volta, como o upload que segurou a fila de um aparelho por meia hora.
 * `liberar()` devolve a resposta dela quando o teste quiser.
 */
const buildTransportePreso = (entidade: number) => {
    const chamadas: string[] = [];
    let liberar: () => void = () => undefined;
    const presa = new Promise<void>((resolve) => {
        liberar = resolve;
    });

    const transporte: Transporte = {
        listar: async () => ({ registros: [] }),
        escrever: async (requisicao: RequisicaoEscrita) => {
            chamadas.push(requisicao.rota);
            if (chamadas.length === 1) await presa;
            return {};
        },
        enviarArquivo: async () => ({}),
        classificar: (): Falha => ({ tipo: 'servidor', mensagem: 'erro do servidor', semResposta: false }),
        entidadeAtual: () => entidade,
    };
    return { transporte, chamadas, liberar: () => liberar() };
};

const buildMotor = (transporte: Transporte) => criarMotor({ transporte, tabelas: [localizacao, item] });

const listenEstados = (motor: ReturnType<typeof buildMotor>) => {
    const estados: EventosSync['drenagem:estado'][] = [];
    motor.escutar('drenagem:estado', (estado) => estados.push(estado));
    return estados;
};

const waitAte = async (condicao: () => boolean) => {
    for (let volta = 0; volta < 100 && !condicao(); volta += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

const enqueueAtualizacoes = async (contexto: { entidade: number; escopo: string }, ids: string[]) => {
    for (const id of ids) {
        await enfileirar(contexto, {
            tabela: 'inventario_item',
            registroId: id,
            operacao: 'atualizar',
            payload: { status: 'ENCONTRADO' },
        });
    }
};

describe('forceDrenagem', () => {
    it('envia a fila mesmo com outra drenagem presa numa requisição', async () => {
        const contexto = { entidade: 101, escopo: '' };
        const { transporte, chamadas } = buildTransportePreso(contexto.entidade);
        const motor = buildMotor(transporte);
        await enqueueAtualizacoes(contexto, ['item-1', 'item-2']);

        void motor.drenar(contexto);
        await waitAte(() => chamadas.length === 1);

        const resultado = await motor.forceDrenagem(contexto);

        expect(resultado.interrompidaPor).toBe('fim');
        expect(chamadas).toEqual(['/item/item-1', '/item/item-1', '/item/item-2']);
        expect(await listarPendencias(contexto)).toHaveLength(0);
    });

    /**
     * A drenagem presa ainda termina um dia, quando a requisição dela volta.
     * Se ela anunciasse o próprio fim, a tela diria "parado" com a nova ainda
     * enviando, e a próxima chamada de `drenar()` não teria em quem esperar.
     */
    it('a drenagem abandonada não anuncia o próprio fim nem solta a vez', async () => {
        const contexto = { entidade: 102, escopo: '' };
        const { transporte, chamadas, liberar } = buildTransportePreso(contexto.entidade);
        const motor = buildMotor(transporte);
        const estados = listenEstados(motor);
        await enqueueAtualizacoes(contexto, ['item-1']);

        const abandonada = motor.drenar(contexto);
        await waitAte(() => chamadas.length === 1);
        await motor.forceDrenagem(contexto);
        const antesDeLiberar = estados.length;

        liberar();
        await abandonada;

        expect(estados.slice(antesDeLiberar)).toEqual([]);
        expect(estados.at(-1)).toEqual({ drenando: false, motivo: 'fim' });
    });

    it('sem nada preso, drena como sempre', async () => {
        const contexto = { entidade: 103, escopo: '' };
        const { transporte, chamadas, liberar } = buildTransportePreso(contexto.entidade);
        liberar();
        const motor = buildMotor(transporte);
        await enqueueAtualizacoes(contexto, ['item-1']);

        const resultado = await motor.forceDrenagem(contexto);

        expect(resultado).toMatchObject({ escritas: 1, interrompidaPor: 'fim' });
        expect(chamadas).toEqual(['/item/item-1']);
    });
});

describe('discardPendencia', () => {
    const buildMotorLivre = (entidade: number) => {
        const { transporte, liberar } = buildTransportePreso(entidade);
        liberar();
        return buildMotor(transporte);
    };

    it('tira a alteração da fila e avisa a nova contagem', async () => {
        const contexto = { entidade: 201, escopo: '' };
        const motor = buildMotorLivre(contexto.entidade);
        await enqueueAtualizacoes(contexto, ['item-1', 'item-2']);
        const contagens: number[] = [];
        motor.escutar('fila:alterada', ({ pendentes }) => contagens.push(pendentes));

        const [primeira] = await listarPendencias(contexto);
        await motor.discardPendencia(contexto, primeira!.id);

        const restantes = await listarPendencias(contexto);
        expect(restantes.map((pendencia) => pendencia.registroId)).toEqual(['item-2']);
        expect(contagens.at(-1)).toBe(1);
    });

    it('descartar uma criação apaga também o registro que só existia no aparelho', async () => {
        const contexto = { entidade: 202, escopo: '' };
        const motor = buildMotorLivre(contexto.entidade);
        const excluidos: string[] = [];
        motor.escutar('registro:excluido', ({ id }) => excluidos.push(id));

        const { id, pendencia } = await motor.criar(contexto, {
            tabela: 'localizacao',
            campos: { name: 'Sala nova' },
        });
        await motor.discardPendencia(contexto, pendencia.id);

        expect(await listarPendencias(contexto)).toHaveLength(0);
        expect(await lerRegistro(contexto, 'localizacao', id)).toBeNull();
        expect(excluidos).toEqual([id]);
    });

    /**
     * Descartar a sublocalização criada offline deixaria cada item que aponta
     * para ela subindo com uma referência que o servidor não conhece.
     */
    it('recusa descartar uma criação da qual outras alterações dependem', async () => {
        const contexto = { entidade: 203, escopo: '' };
        const motor = buildMotorLivre(contexto.entidade);
        const { id, pendencia } = await motor.criar(contexto, {
            tabela: 'localizacao',
            campos: { name: 'Sala nova' },
        });
        await enfileirar(contexto, {
            tabela: 'inventario_item',
            registroId: 'item-1',
            operacao: 'atualizar',
            payload: { local_encontrado: id },
        });

        const descarte = motor.discardPendencia(contexto, pendencia.id);

        await expect(descarte).rejects.toBeInstanceOf(DescarteBloqueadoError);
        expect(await listarPendencias(contexto)).toHaveLength(2);
        expect(await lerRegistro(contexto, 'localizacao', id)).not.toBeNull();
    });

    it('id que já saiu da fila não é erro', async () => {
        const contexto = { entidade: 204, escopo: '' };
        const motor = buildMotorLivre(contexto.entidade);

        await expect(motor.discardPendencia(contexto, 'nao-existe')).resolves.toBeUndefined();
    });
});

describe('discardAnexo', () => {
    it('tira a foto da fila e apaga o arquivo guardado no aparelho', async () => {
        const contexto = { entidade: 301, escopo: '' };
        const { transporte, liberar } = buildTransportePreso(contexto.entidade);
        liberar();
        const motor = buildMotor(transporte);
        arquivosNoDisco.add('documentos/foto-1.jpg');
        await enfileirarAnexo(contexto, {
            id: 'foto-1',
            tabela: 'inventario_item',
            registroId: 'item-1',
            campo: 'bem.imagens',
            caminho: 'documentos/foto-1.jpg',
            nomeArquivo: 'foto-1.jpg',
            mime: 'image/jpeg',
            bytes: 10,
            seguro: true,
        });

        await motor.discardAnexo(contexto, 'foto-1');

        expect(await listarAnexos(contexto)).toHaveLength(0);
        expect(arquivosNoDisco.has('documentos/foto-1.jpg')).toBe(false);
    });
});

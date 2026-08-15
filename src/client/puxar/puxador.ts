/**
 * Traz o que mudou no servidor para o espelho local.
 *
 * O puxador não sabe COMO buscar — isso é da estratégia declarada na tabela.
 * Ele sabe o que fazer com o resultado: gravar em lote, reconciliar exclusões
 * quando o conjunto veio completo, avançar a marca d'água e avisar quem escuta.
 */
import { Emissor } from '../nucleo/eventos';
import type { ContextoSync, DefinicaoTabela } from '../nucleo/tipos';
import type { Transporte } from '../../protocol/transporte';
import {
    contarRegistros,
    gravarLote,
    marcarExcluidos,
    reconciliarConjunto,
} from '../persistencia/registros';
import { gravarEstado, lerEstado } from '../persistencia/marcaDagua';

/** Teto de páginas por rodada — evita laço infinito se o servidor mentir no `temMais`. */
const MAX_PAGINAS = 200;

export interface ResultadoSincronizacaoTabela {
    tabela: string;
    gravados: number;
    excluidos: number;
}

const idsDe = (tabela: DefinicaoTabela, registros: unknown[]): string[] =>
    registros
        .map((bruto: any) =>
            tabela.leitura.extrairId ? tabela.leitura.extrairId(bruto) : bruto?.[tabela.chavePrimaria],
        )
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

export const puxarTabela = async (
    contexto: ContextoSync,
    tabela: DefinicaoTabela,
    transporte: Transporte,
    emissor: Emissor,
    sinal?: AbortSignal,
): Promise<ResultadoSincronizacaoTabela> => {
    let estado = await lerEstado(contexto, tabela.nome);

    /**
     * Autocorreção: marca de carga completa com o espelho VAZIO.
     *
     * Se a carga inicial for interrompida no meio depois de já ter marcado a
     * conclusão, toda rodada seguinte entra no caminho incremental — pede só o
     * que mudou desde o cursor, não vem nada, e a tabela fica vazia para
     * sempre, sem erro nenhum. Aqui a marca é desfeita para a carga ser
     * refeita do começo.
     */
    if (estado.cargaCompletaEm && (await contarRegistros(contexto, tabela.nome)) === 0) {
        console.warn(
            `[thesync] "${tabela.nome}" marcada como carregada mas sem registros; refazendo a carga.`,
        );
        estado = { ...estado, cargaCompletaEm: null, cursor: null, cursorPagina: null };
        await gravarEstado(contexto, estado);
    }

    let gravados = 0;
    let concluiuAPaginacao = false;
    let excluidos = 0;
    const idsCompletos: string[] = [];
    let vistoConjuntoCompleto = false;

    for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
        const resultado = await tabela.leitura.estrategia.puxar({
            tabela,
            contexto,
            transporte,
            estado,
            sinal,
        });

        // O servidor podou o log além do nosso cursor: a próxima rodada refaz a
        // carga inicial. Não grava nada agora para não misturar meio-estado.
        if (resultado.recomecar) {
            await gravarEstado(contexto, {
                ...estado,
                cursor: null,
                cursorPagina: null,
                cargaCompletaEm: null,
                ultimoErro: 'O servidor exigiu recarga completa.',
            });
            break;
        }

        gravados += await gravarLote(contexto, tabela, resultado.registros);

        if (resultado.completo) {
            vistoConjuntoCompleto = true;
            idsCompletos.push(...idsDe(tabela, resultado.registros));
        }

        if (resultado.excluidos.length > 0) {
            excluidos += await marcarExcluidos(contexto, tabela.nome, resultado.excluidos);
        }

        // A página é gravada ANTES do estado avançar: se o app morrer agora, a
        // próxima abertura retoma daqui em vez de recomeçar.
        estado = {
            ...estado,
            cursor: resultado.cursor !== undefined ? resultado.cursor : estado.cursor,
            cursorPagina: resultado.temMais ? (resultado.cursorPagina ?? null) : null,
            ultimoErro: null,
        };
        await gravarEstado(contexto, estado);

        if (!resultado.temMais) {
            concluiuAPaginacao = true;
            break;
        }
    }

    // O que o servidor não listou num conjunto completo, não existe mais. É
    // assim que a exclusão aparece enquanto o backend não manda tombstone.
    if (vistoConjuntoCompleto) {
        const sumidos = await reconciliarConjunto(contexto, tabela.nome, idsCompletos);
        excluidos += sumidos.length;
        sumidos.forEach((id) => emissor.emitir('registro:excluido', { tabela: tabela.nome, id }));
    }

    const agora = Date.now();
    await gravarEstado(contexto, {
        ...estado,
        /**
         * Só marca como carregada quando a paginação REALMENTE terminou. Marcar
         * no fim de qualquer rodada fazia uma carga interrompida passar por
         * concluída, e a tabela nunca mais era baixada por inteiro.
         */
        cargaCompletaEm: estado.cargaCompletaEm ?? (concluiuAPaginacao ? agora : null),
        reconciliadoEm: vistoConjuntoCompleto ? agora : estado.reconciliadoEm,
        cursorPagina: concluiuAPaginacao ? null : estado.cursorPagina,
    });

    console.log(
        `[thesync] ${tabela.nome}: ${gravados} gravados, ${excluidos} excluídos` +
        `${concluiuAPaginacao ? '' : ' (paginação incompleta)'}`,
    );

    emissor.emitir('tabela:sincronizada', {
        tabela: tabela.nome,
        escopo: contexto.escopo,
        gravados,
        excluidos,
    });

    return { tabela: tabela.nome, gravados, excluidos };
};

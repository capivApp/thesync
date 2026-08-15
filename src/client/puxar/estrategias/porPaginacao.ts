/**
 * Baixa a tabela inteira percorrendo a listagem paginada que o backend já tem.
 *
 * É a estratégia para tabelas grandes em backend SEM o feed de sincronização:
 * `porListaCompleta` pediria tudo de uma vez e a resposta estoura o tempo do
 * proxy muito antes de chegar ao aparelho — que é o motivo de listagens com
 * milhares de registros voltarem 524.
 *
 * Como o resultado é o conjunto completo, ela também reconcilia exclusões: o
 * que não veio em nenhuma página não existe mais.
 */
import type { ContextoPuxada, EstrategiaPuxada, ResultadoPuxada } from '../../nucleo/tipos';

export interface OpcoesPorPaginacao {
    rota: string;
    /** Registros por página. */
    tamanhoDaPagina?: number;
    /** Filtros fixos ou derivados do escopo. */
    filtros?: (escopo: string) => Record<string, string>;
}

const TAMANHO_PADRAO = 200;

export const porPaginacao = (opcoes: OpcoesPorPaginacao): EstrategiaPuxada => {
    const tamanho = opcoes.tamanhoDaPagina ?? TAMANHO_PADRAO;

    return {
        nome: 'por-paginacao',

        async puxar({ tabela, contexto, transporte, estado, sinal }: ContextoPuxada): Promise<ResultadoPuxada> {
            // `cursorPagina` guarda o número da última página trazida, para a
            // carga retomar em vez de recomeçar se o app for fechado no meio.
            const proxima = Number(estado.cursorPagina ?? 0) + 1;

            const resposta = await transporte.listar({
                rota: opcoes.rota,
                filtros: opcoes.filtros?.(contexto.escopo),
                campos: tabela.leitura.campos,
                pagina: { numero: proxima, tamanho },
                sinal,
            });

            const totalDePaginas = resposta.paginacao?.totalPaginas ?? 1;
            const temMais = proxima < totalDePaginas && resposta.registros.length > 0;

            return {
                registros: resposta.registros,
                excluidos: [],
                // O conjunto só está completo quando a última página chega.
                completo: !temMais,
                cursorPagina: temMais ? String(proxima) : null,
                temMais,
            };
        },
    };
};

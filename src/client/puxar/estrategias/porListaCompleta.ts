/**
 * Baixa a lista inteira da tabela.
 *
 * Serve bem para cadastros de apoio — localizações, sublocalizações — que são
 * pequenos e que o app já baixava por completo mesmo online. Como o resultado é
 * o conjunto completo, ele também reconcilia exclusões sem precisar de
 * tombstone no servidor.
 *
 * Para tabelas grandes, use `porChangeLog` (quando o backend tiver o feed) ou
 * uma carga inicial paginada.
 */
import type { ContextoPuxada, EstrategiaPuxada, ResultadoPuxada } from '../../nucleo/tipos';

export interface OpcoesPorListaCompleta {
    rota: string;
    /** Filtros fixos ou derivados do escopo. */
    filtros?: (escopo: string) => Record<string, string>;
}

export const porListaCompleta = (opcoes: OpcoesPorListaCompleta): EstrategiaPuxada => ({
    nome: 'por-lista-completa',

    async puxar({ tabela, contexto, transporte, sinal }: ContextoPuxada): Promise<ResultadoPuxada> {
        const resposta = await transporte.listar({
            rota: opcoes.rota,
            filtros: opcoes.filtros?.(contexto.escopo),
            campos: tabela.leitura.campos,
            sinal,
        });

        return {
            registros: resposta.registros,
            excluidos: [],
            completo: true,
            temMais: false,
        };
    },
});

/**
 * Sincronização incremental pelo feed do servidor.
 *
 * É a estratégia final: em vez de rebaixar a lista inteira a cada vez, o app
 * pede "o que ficou visível depois deste cursor" e recebe só o que mudou —
 * exclusões incluídas.
 *
 * Duas coisas que parecem detalhe e não são:
 *
 * 1. **A carga inicial pede o cursor ANTES de baixar o dump.** É o padrão
 *    snapshot + catch-up: o cursor zero é capturado primeiro, o dump é
 *    paginado por keyset, e o que mudou durante o dump é reentregue depois. Se
 *    o cursor fosse capturado no fim, tudo que mudou durante o download seria
 *    perdido.
 *
 * 2. **O cursor novo só é persistido quando a paginação termina.** Um crash no
 *    meio faz a próxima rodada recomeçar do cursor anterior — reentrega, que o
 *    upsert absorve. O contrário perderia páginas.
 */
import type { ContextoPuxada, EstrategiaPuxada, ResultadoPuxada } from '../../nucleo/tipos';

interface MudancaDoServidor {
    op: 'upsert' | 'delete';
    id: string;
    row?: unknown;
}

interface RespostaMudancas {
    cursor: string;
    hasMore: boolean;
    changes: MudancaDoServidor[];
}

interface RespostaSnapshot {
    items: unknown[];
    nextId: string | null;
    hasMore: boolean;
}

export interface OpcoesPorChangeLog {
    /** Rota base do recurso; `/sync/changes` e `/sync/snapshot` são derivadas. */
    rotaBase: string;
    /** Filtros do escopo (ex.: o inventário aberto). */
    filtros?: (escopo: string) => Record<string, string>;
    /** Registros por página. O servidor tem teto próprio. */
    tamanhoDaPagina?: number;
}

const TAMANHO_PADRAO = 500;

/** O servidor responde 410 quando o cursor é anterior à poda do log. */
const exigeRecarga = (erro: unknown): boolean =>
    (erro as { status?: number })?.status === 410;

export const porChangeLog = (opcoes: OpcoesPorChangeLog): EstrategiaPuxada => {
    const tamanho = opcoes.tamanhoDaPagina ?? TAMANHO_PADRAO;

    const baixarPaginaDoSnapshot = async (
        { contexto, transporte, sinal }: ContextoPuxada,
        apos: string | null,
    ): Promise<RespostaSnapshot> => {
        const resposta = await transporte.listar({
            rota: `${opcoes.rotaBase}/sync/snapshot`,
            filtros: {
                ...(opcoes.filtros?.(contexto.escopo) ?? {}),
                ...(apos ? { cursor: apos } : {}),
                limit: String(tamanho),
            },
            sinal,
        });
        return (resposta.registros[0] ?? { items: [], nextId: null, hasMore: false }) as RespostaSnapshot;
    };

    const pedirMudancas = async (
        { contexto, transporte, sinal }: ContextoPuxada,
        cursor: string | null,
    ): Promise<RespostaMudancas> => {
        const resposta = await transporte.listar({
            rota: `${opcoes.rotaBase}/sync/changes`,
            filtros: {
                ...(opcoes.filtros?.(contexto.escopo) ?? {}),
                ...(cursor ? { cursor } : {}),
                limit: String(tamanho),
            },
            sinal,
        });
        return (resposta.registros[0] ?? { cursor: '', hasMore: false, changes: [] }) as RespostaMudancas;
    };

    return {
        nome: 'por-change-log',

        async puxar(ctx: ContextoPuxada): Promise<ResultadoPuxada> {
            const { estado } = ctx;

            // ── Carga inicial ────────────────────────────────────────────────
            if (!estado.cargaCompletaEm) {
                // O cursor vem PRIMEIRO. Capturá-lo no fim perderia tudo que
                // mudasse durante o download.
                const cursorZero = estado.cursor ?? (await pedirMudancas(ctx, null)).cursor;

                const pagina = await baixarPaginaDoSnapshot(ctx, estado.cursorPagina);

                return {
                    registros: pagina.items,
                    excluidos: [],
                    // Cada página do snapshot faz parte da varredura completa.
                    // Se ela pode ou não reconciliar exclusões é o puxador quem
                    // decide, olhando se a rodada começou do começo.
                    completo: true,
                    cursor: cursorZero,
                    cursorPagina: pagina.nextId,
                    temMais: pagina.hasMore,
                };
            }

            // ── Incremental ──────────────────────────────────────────────────
            try {
                const resposta = await pedirMudancas(ctx, estado.cursor);

                return {
                    registros: resposta.changes
                        .filter((mudanca) => mudanca.op === 'upsert' && mudanca.row !== undefined)
                        .map((mudanca) => mudanca.row),
                    excluidos: resposta.changes
                        .filter((mudanca) => mudanca.op === 'delete')
                        .map((mudanca) => mudanca.id),
                    completo: false,
                    // Enquanto pagina, o cursor devolvido pelo servidor já
                    // carrega o snapshot antigo — só repassamos.
                    cursor: resposta.cursor,
                    temMais: resposta.hasMore,
                };
            } catch (erro) {
                if (!exigeRecarga(erro)) throw erro;

                // O log foi podado além do nosso cursor. Não há incremental
                // possível: a próxima rodada refaz a carga inicial.
                console.warn('[thesync] change log podado além do cursor; refazendo a carga completa.');
                return {
                    registros: [],
                    excluidos: [],
                    completo: false,
                    cursor: null,
                    cursorPagina: null,
                    temMais: false,
                    recomecar: true,
                };
            }
        },
    };
};

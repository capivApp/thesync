/**
 * Quando o backend JÁ tem um endpoint que devolve o conjunto completo.
 *
 * É o caso do inventário: o `GET /inventario-patrimonio/:id` traz todos os
 * itens aninhados. Esse endpoint É a reconciliação — inclusive das exclusões,
 * porque o que não veio na resposta não existe mais.
 *
 * Não invente delta onde já existe conjunto completo. A estratégia mais simples
 * que está correta ganha da mais sofisticada que precisa de backend novo.
 */
import type { ContextoPuxada, EstrategiaPuxada, ResultadoPuxada } from '../../nucleo/tipos';

export interface OpcoesViaAgregado {
    /** Rota do agregado. Recebe o escopo (ex.: o id do inventário aberto). */
    rota: (escopo: string) => string;
    /** Extrai a lista de registros desta tabela de dentro da resposta. */
    extrair: (resposta: unknown) => unknown[];
    /** Extrai também o próprio agregado, quando ele é uma tabela declarada. */
    extrairAgregado?: (resposta: unknown) => unknown | null;
}

export const viaAgregado = (opcoes: OpcoesViaAgregado): EstrategiaPuxada => ({
    nome: 'via-agregado',

    async puxar({ contexto, transporte, sinal }: ContextoPuxada): Promise<ResultadoPuxada> {
        const resposta = await transporte.listar({
            rota: opcoes.rota(contexto.escopo),
            sinal,
        });

        // O agregado vem como registro único; o transporte normaliza para lista.
        const bruto = resposta.registros[0] ?? null;
        const registros = opcoes.extrair(bruto) ?? [];

        return {
            registros,
            excluidos: [],
            completo: true,
            temMais: false,
        };
    },
});

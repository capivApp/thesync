/**
 * A fronteira entre o motor e o HTTP do app hospedeiro.
 *
 * É a única superfície que o motor conhece de rede. Tudo que é específico de um
 * backend — formato de envelope, headers de paginação, gramática de filtro,
 * como a sessão é renovada — mora na implementação, nunca aqui. É isso que
 * permite que dois apps com estratégias de autenticação diferentes (um com
 * relogin por senha, outro com refresh token) usem o mesmo motor.
 */
import type { Falha } from './erros';

export interface PaginaSolicitada {
    numero: number;
    tamanho: number;
}

export interface Ordenacao {
    campo: string;
    direcao: 'asc' | 'desc';
}

export interface RequisicaoListagem {
    rota: string;
    /** Filtros já no formato do backend (`campo` → `operador:valor`). */
    filtros?: Record<string, string>;
    /** Projeção: só estas colunas. Reduz o payload da reconciliação. */
    campos?: string[];
    ordenarPor?: Ordenacao;
    pagina?: PaginaSolicitada;
    sinal?: AbortSignal;
}

export interface RespostaListagem {
    registros: unknown[];
    paginacao?: { pagina: number; total: number; totalPaginas: number };
}

export interface RequisicaoEscrita {
    metodo: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    rota: string;
    corpo?: unknown;
    /** A MESMA em toda tentativa da mesma mutação. É o que evita duplicata. */
    chaveIdempotencia: string;
    /** Versão que o usuário estava vendo, para o compare-and-swap opcional. */
    versaoEsperada?: string;
}

export interface RequisicaoArquivo {
    rota: string;
    campoArquivo: string;
    arquivo: { uri: string; nome: string; mime: string };
    campos?: Record<string, string>;
    chaveIdempotencia: string;
}

export interface Transporte {
    listar(requisicao: RequisicaoListagem): Promise<RespostaListagem>;
    escrever(requisicao: RequisicaoEscrita): Promise<unknown>;
    enviarArquivo(requisicao: RequisicaoArquivo): Promise<unknown>;

    /**
     * Traduz o erro do app para o vocabulário do motor.
     *
     * Precisa distinguir com precisão "não houve resposta" de "o servidor
     * recusou" — o motor decide se gasta uma tentativa a partir disso.
     */
    classificar(erro: unknown): Falha;

    /** Entidade (tenant) da sessão ATUAL. O motor recusa enviar dado de outra. */
    entidadeAtual(): number | null;
}

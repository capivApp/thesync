/**
 * O vocabulário do motor.
 *
 * Uma tabela é DECLARADA, não programada: de onde ler, para onde escrever, como
 * descobrir exclusões, o que fazer quando dois aparelhos editam a mesma coisa.
 * Quando o backend ganhar um recurso novo (change log, upsert por id do
 * cliente), muda a estratégia declarada — não o motor.
 */
import type { Transporte } from '../../protocol/transporte';

export type ModoTabela = 'somente-leitura' | 'leitura-escrita';

export type PoliticaConflito = 'campo-a-campo' | 'servidor-vence' | 'cliente-vence' | 'manual';

/** Quem decide o `id` de um registro criado offline. */
export type EstrategiaId = 'id-do-cliente' | 'id-do-servidor';

export type OperacaoEscrita = 'criar' | 'atualizar' | 'remover';

/** Recorte da sincronização: entidade (tenant) e, opcionalmente, um agregado. */
export interface ContextoSync {
    entidade: number;
    /** Ex.: o id do inventário aberto. String vazia = a tabela inteira. */
    escopo: string;
}

export interface RequisicaoEscritaDeclarada {
    metodo: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    rota: string;
    corpo?: unknown;
}

export interface ColunaIndexada<T = any> {
    nome: string;
    tipo: 'texto' | 'numero';
    extrair: (registro: T) => string | number | null | undefined;
}

export interface ReferenciaFK {
    campo: string;
    tabela: string;
}

/** O que o motor precisa saber para subir um arquivo ligado a um registro. */
export interface DefinicaoAnexo<T = any> {
    /** Caminho do campo que guarda a lista de anexos (ex.: `bem.imagens`). */
    campo: string;
    rota: (registro: T) => string;
    campoArquivo: string;
    camposExtras?: (registro: T) => Record<string, string>;
    /** Extrai do retorno o registro atualizado, para o motor gravar no espelho. */
    aplicarResposta?: (resposta: unknown) => unknown;
}

export interface LeituraDeclarada<T = any> {
    /** Estratégia de atualização — o que troca quando o backend evolui. */
    estrategia: EstrategiaPuxada;
    /** Projeção enviada ao servidor. Reduz o payload da reconciliação. */
    campos?: string[];
    /** Extrai o id do registro cru, quando não é `chavePrimaria` direto. */
    extrairId?: (bruto: any) => string;
}

export interface EscritaDeclarada<T = any> {
    estrategiaId: EstrategiaId;
    criar?: (registro: T) => RequisicaoEscritaDeclarada;
    atualizar: (campos: Partial<T>, id: string) => RequisicaoEscritaDeclarada;
    remover?: (id: string) => RequisicaoEscritaDeclarada;
    /** Onde está o id do servidor na resposta de um `criar`. */
    idServidorDaResposta?: (resposta: unknown) => string | null;
}

export interface DefinicaoTabela<T = any> {
    nome: string;
    modo: ModoTabela;
    chavePrimaria: string;

    leitura: LeituraDeclarada<T>;
    escrita?: EscritaDeclarada<T>;

    conflito: PoliticaConflito;

    /** Tabelas que precisam subir antes desta. Ordena o push. */
    dependeDe?: string[];
    referencias?: ReferenciaFK[];
    colunasIndexadas?: ColunaIndexada<T>[];
    anexos?: DefinicaoAnexo<T>;

    /**
     * Texto legível do registro, para a tela de pendências e de conflitos.
     * Sem isso a tela mostra `inventario_item#a3f9-…` para alguém que só quer
     * saber de qual armário se trata.
     */
    descrever: (registro: T) => string;
}

/** Estado de sincronização de uma tabela dentro de um escopo. */
export interface EstadoTabela {
    tabela: string;
    escopo: string;
    cursor: string | null;
    cursorPagina: string | null;
    cargaCompletaEm: number | null;
    reconciliadoEm: number | null;
    ultimoErro: string | null;
}

export interface ContextoPuxada {
    tabela: DefinicaoTabela;
    contexto: ContextoSync;
    transporte: Transporte;
    estado: EstadoTabela;
    sinal?: AbortSignal;
}

export interface ResultadoPuxada {
    /** Registros para gravar ou atualizar no espelho. */
    registros: unknown[];
    /** Ids que sumiram do servidor. */
    excluidos: string[];
    /** Cursor novo, quando a estratégia usa cursor. */
    cursor?: string | null;
    /** Página onde parar/retomar, quando a carga inicial é paginada. */
    cursorPagina?: string | null;
    /**
     * `true` quando `registros` é o CONJUNTO COMPLETO da tabela no escopo — e
     * então tudo que ficou de fora está excluído. É o que permite reconciliar
     * exclusões sem o servidor mandar tombstone.
     */
    completo: boolean;
    /** Ainda há páginas; o motor chama de novo. */
    temMais: boolean;
}

export interface EstrategiaPuxada {
    nome: string;
    puxar(ctx: ContextoPuxada): Promise<ResultadoPuxada>;
}

/** Ajuda o TypeScript a inferir `T` sem obrigar a anotar tudo à mão. */
export const definirTabela = <T>(definicao: DefinicaoTabela<T>): DefinicaoTabela<T> => definicao;

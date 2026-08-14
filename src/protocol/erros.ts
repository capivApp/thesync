/**
 * Classificação de falha — a decisão mais importante do motor.
 *
 * Confundir "a rede caiu" com "o servidor recusou" é o bug clássico de fila
 * offline: cinco minutos de túnel queimam o limite de tentativas e a tela passa
 * a mentir que a contagem falhou, quando nada falhou. Por isso a classificação
 * é um tipo do protocolo e não uma checagem espalhada por aí.
 */

export type TipoFalha =
    /** A requisição não chegou a receber resposta. NÃO conta tentativa. */
    | 'rede'
    /** 401/403 depois de o transporte já ter tentado renovar a sessão. */
    | 'autenticacao'
    /** 409 de chave de idempotência com dono ou corpo diferente. */
    | 'conflito-chave'
    /** O registro mudou no servidor desde que o usuário o editou. */
    | 'conflito-versao'
    /** 400/422 — o payload está errado e repetir não resolve. */
    | 'validacao'
    /** 404 — o registro sumiu no servidor. */
    | 'registro-sumiu'
    /** 5xx — vale tentar de novo, com calma. */
    | 'servidor'
    | 'desconhecido';

export interface Falha {
    tipo: TipoFalha;
    mensagem: string;
    status?: number;
    /** A requisição não obteve resposta do servidor. */
    semResposta: boolean;
    /** Corpo da resposta, quando houve uma. */
    dados?: unknown;
}

/** Falhas que o motor reprograma sozinho, sem gastar tentativa do usuário. */
const NAO_CONSOMEM_TENTATIVA: ReadonlySet<TipoFalha> = new Set<TipoFalha>([
    'rede',
    'autenticacao',
    'conflito-chave',
    'conflito-versao',
    'registro-sumiu',
    'validacao',
]);

export const consomeTentativa = (falha: Falha): boolean => !NAO_CONSOMEM_TENTATIVA.has(falha.tipo);

/** Falhas que param a fila inteira em vez de pular para a próxima pendência. */
const INTERROMPEM_A_FILA: ReadonlySet<TipoFalha> = new Set<TipoFalha>(['rede', 'autenticacao']);

export const interrompeAFila = (falha: Falha): boolean => INTERROMPEM_A_FILA.has(falha.tipo);

/** Falhas que tiram a pendência da fila automática e a mandam para a tela. */
const EXIGEM_O_USUARIO: ReadonlySet<TipoFalha> = new Set<TipoFalha>([
    'validacao',
    'registro-sumiu',
    'conflito-versao',
]);

export const exigeOUsuario = (falha: Falha): boolean => EXIGEM_O_USUARIO.has(falha.tipo);

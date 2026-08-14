/**
 * O contrato entre as duas pontas.
 *
 * Cliente e servidor moram no mesmo repositório por causa deste diretório: o
 * formato do cursor, o envelope e a classificação de falha precisam evoluir
 * juntos. Em repositórios separados eles divergem — e a divergência só aparece
 * em campo, no aparelho de alguém, sem internet.
 */
export {
    avancarSeq,
    codificarCursor,
    decodificarCursor,
    VERSAO_CURSOR,
    type Cursor,
} from './cursor';

export {
    CODIGO_RESYNC,
    ehErroResync,
    HEADER_ETAG,
    HEADER_IDEMPOTENCIA,
    HEADER_VERSAO,
    type ErroResync,
    type MudancaSync,
    type OperacaoSync,
    type RespostaMudancas,
    type RespostaSnapshot,
} from './envelope';

export {
    consomeTentativa,
    exigeOUsuario,
    interrompeAFila,
    type Falha,
    type TipoFalha,
} from './erros';

export type {
    Ordenacao,
    PaginaSolicitada,
    RequisicaoArquivo,
    RequisicaoEscrita,
    RequisicaoListagem,
    RespostaListagem,
    Transporte,
} from './transporte';

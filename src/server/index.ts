/**
 * `@capivapp/thesync/server` — o lado servidor.
 *
 * Não é um framework: é um conjunto de peças (SQL, funções puras de decisão e
 * helpers) para plugar na arquitetura que o backend já tem. A intenção é que o
 * recurso seja ganho "de graça" no roteador base, do mesmo jeito que a
 * idempotência já é.
 *
 * Nada aqui importa Express ou Prisma diretamente — o que existe são tipos
 * estruturais. Assim o pacote não força versão de nada no backend.
 */
export {
    SQL_APLICAR_TRIGGERS,
    SQL_CRIAR_CHANGE_LOG,
    SQL_FUNCAO_TRIGGER,
    SQL_SNAPSHOT_ATUAL,
    sqlDaMarcaDePoda,
    sqlDoPull,
    TABELA_CHANGE_LOG,
    TABELA_MARCA_PODA,
    type LinhaDoLog,
    type ParametrosDoPull,
    type SnapshotDoBanco,
} from './changeLog';

export {
    conferirPoda,
    cursorDaRequisicao,
    CursorDeOutraEntidade,
    limiteDaRequisicao,
    LIMITE_MAXIMO,
    LIMITE_PADRAO,
    montarRespostaDeMudancas,
    RecargaNecessaria,
    type EntradaDoFeed,
    type RegistroHidratado,
} from './feed';

export {
    corpoDoDesfecho,
    decidirIdempotencia,
    RETENCAO_MS,
    SQL_CRIAR_IDEMPOTENCIA,
    SQL_PODAR_IDEMPOTENCIA,
    statusDoDesfecho,
    TABELA_IDEMPOTENCIA,
    type ConsultaIdempotencia,
    type DesfechoIdempotencia,
    type RegistroIdempotencia,
} from './idempotencia';

export {
    chaveDoAnexo,
    sqlInserirAnexoEmConjunto,
    type ChaveDeAnexo,
    type ParametrosDaChave,
} from './anexoIdempotente';

export {
    atualizarComVersao,
    ConflitoDeVersao,
    etagDaVersao,
    SQL_ADICIONAR_VERSAO,
    SQL_APLICAR_TRIGGERS_VERSAO,
    SQL_FUNCAO_VERSAO,
    versaoEsperada,
    type DelegateComCas,
} from './versao';

export * from '../protocol/index';

/**
 * `@capivapp/thesync/client` — o motor no aparelho.
 *
 * Depende de expo-sqlite, expo-file-system, expo-network e expo-crypto. Todos
 * rodam em Expo Go, sem módulo nativo customizado: testar em campo não pode
 * depender de gerar build.
 */
export { criarMotor, Motor } from './nucleo/motor';
export type {
    AnexoSolicitado,
    ConfiguracaoMotor,
    EscritaSolicitada,
    EstadoDaFila,
    ResultadoDrenagemCompleta,
} from './nucleo/motor';

export { criarRegistroDeTabelas, RegistroDeTabelas } from './nucleo/registro';
export { definirTabela } from './nucleo/tipos';
export type {
    ColunaIndexada,
    ContextoSync,
    DefinicaoAnexo,
    DefinicaoTabela,
    EstadoTabela,
    EstrategiaId,
    EstrategiaPuxada,
    ModoTabela,
    OperacaoEscrita,
    PoliticaConflito,
    ResultadoPuxada,
} from './nucleo/tipos';

export { Emissor } from './nucleo/eventos';
export type { EventosSync, NomeEvento, Ouvinte } from './nucleo/eventos';

export { comAlternativa, type OpcoesComAlternativa } from './puxar/estrategias/comAlternativa';
export { porChangeLog, type OpcoesPorChangeLog } from './puxar/estrategias/porChangeLog';
export { porListaCompleta } from './puxar/estrategias/porListaCompleta';
export { porPaginacao, type OpcoesPorPaginacao } from './puxar/estrategias/porPaginacao';
export { viaAgregado } from './puxar/estrategias/viaAgregado';

export {
    contarPor,
    contarRegistros,
    lerRegistro,
    listarIds,
    listarRegistros,
    type FiltroLocal,
    type RegistroLocal,
} from './persistencia/registros';

export { listarPendencias, type EstadoPendencia, type Pendencia } from './persistencia/saida';
export { listarAnexos, type Anexo, type EstadoAnexo } from './persistencia/anexos';
export { apagarDadosDaEntidade, fecharBancos } from './persistencia/banco';
export { lerEstado, temCargaCompleta } from './persistencia/marcaDagua';

export { espacoDisponivel, espacoOcupado } from './anexos/arquivos';
export { conferirConectividade, estaOnline, monitorarConectividade } from './rede/conectividade';
export { ligarGatilhos, type OpcoesGatilhos } from './gatilhos/index';
export { MAX_TENTATIVAS } from './empurrar/backoff';
export type { OrcamentoDrenagem } from './empurrar/empurrador';

/**
 * Estado da rede.
 *
 * Duas perguntas diferentes, e é importante não confundi-las:
 *
 *  - "posso mostrar o cache?" — na dúvida, SIM. O pior desfecho é uma tela em
 *    branco para quem tem os dados no aparelho.
 *  - "posso drenar a fila?" — na dúvida, NÃO gastar tentativa. Cinco minutos de
 *    túnel não podem queimar o limite e fazer a tela mentir que falhou.
 *
 * Por isso `estaOnline()` é otimista e a decisão de contar tentativa nunca
 * depende só dela — depende de a requisição ter obtido resposta.
 */
import * as Network from 'expo-network';

let ultimoEstadoConhecido = true;

const interpretar = (estado: Network.NetworkState): boolean =>
    estado.isConnected !== false && estado.isInternetReachable !== false;

/** Último valor conhecido, sem ida ao sistema. Para decisões de renderização. */
export const estaOnline = (): boolean => ultimoEstadoConhecido;

/** Pergunta ao sistema agora. Para decisões de envio. */
export const conferirConectividade = async (): Promise<boolean> => {
    try {
        ultimoEstadoConhecido = interpretar(await Network.getNetworkStateAsync());
    } catch (erro) {
        console.warn('[thesync] não foi possível ler o estado da rede:', erro);
        ultimoEstadoConhecido = true;
    }
    return ultimoEstadoConhecido;
};

export const monitorarConectividade = (aoMudar: (online: boolean) => void) =>
    Network.addNetworkStateListener((estado) => {
        const online = interpretar(estado);
        const mudou = online !== ultimoEstadoConhecido;
        ultimoEstadoConhecido = online;
        if (mudou) aoMudar(online);
    });

/**
 * Quando drenar.
 *
 * Isolado de propósito. Hoje os gatilhos são o ciclo de vida do app e o retorno
 * da rede; amanhã, uma tarefa de segundo plano registra mais um gatilho que
 * chama exatamente o MESMO `motor.drenar()`. Nada do motor muda.
 */
import { AppState, type AppStateStatus } from 'react-native';

import type { Motor } from '../nucleo/motor';
import type { ContextoSync } from '../nucleo/tipos';
import { monitorarConectividade } from '../rede/conectividade';

export interface OpcoesGatilhos {
    motor: Motor;
    /** Lê o contexto na hora do disparo — a entidade pode ter mudado. */
    contexto: () => ContextoSync | null;
    /** Rede de segurança para o caso de nenhum gatilho disparar. */
    intervaloMs?: number;
}

const INTERVALO_PADRAO_MS = 60_000;

/**
 * Liga os gatilhos e devolve a função que os desliga.
 *
 * A drenagem é single-flight no motor, então gatilhos que disparam juntos
 * (voltar do segundo plano com a rede voltando ao mesmo tempo) não duplicam
 * envio.
 */
export const ligarGatilhos = ({ motor, contexto, intervaloMs = INTERVALO_PADRAO_MS }: OpcoesGatilhos) => {
    const drenar = () => {
        const atual = contexto();
        if (!atual) return;
        void motor.drenar(atual).catch((erro) => {
            console.warn('[thesync] drenagem falhou:', erro);
        });
    };

    const aoMudarEstadoDoApp = (estado: AppStateStatus) => {
        if (estado === 'active') drenar();
    };

    const inscricaoApp = AppState.addEventListener('change', aoMudarEstadoDoApp);
    const inscricaoRede = monitorarConectividade((online) => {
        if (online) drenar();
    });
    const intervalo = setInterval(drenar, intervaloMs);

    // Uma tentativa no arranque: o app pode ter sido aberto justamente para
    // subir o que ficou pendente da última jornada.
    drenar();

    return () => {
        inscricaoApp.remove();
        inscricaoRede.remove();
        clearInterval(intervalo);
    };
};

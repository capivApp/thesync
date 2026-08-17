/**
 * Como o motor avisa a UI — e o único jeito que ele tem de falar com ela.
 *
 * O drenador não importa React, não lê store e não toca em cache de query. Ele
 * emite. É isso que permite que, um dia, uma tarefa de segundo plano chame o
 * MESMO drenador sem que exista tela nenhuma escutando.
 */

export interface EventosSync {
    /** Um registro entrou ou mudou no espelho. */
    'registro:alterado': { tabela: string; id: string; registro: unknown };
    /** Um registro sumiu do servidor. */
    'registro:excluido': { tabela: string; id: string };
    /** Um lote de registros chegou (carga inicial, reconciliação). */
    'tabela:sincronizada': { tabela: string; escopo: string; gravados: number; excluidos: number };
    /**
     * Uma página da carga entrou no espelho, para a tela poder dizer
     * "12.400 de 103.000" em vez de um spinner que não distingue baixando de
     * travado. Numa tabela de cem mil registros a carga leva dezenas de
     * minutos, e sem número na tela o usuário mata o app achando que morreu.
     *
     * `total` é `null` quando a estratégia não sabe o tamanho do conjunto — o
     * feed incremental não conta o que ainda não entregou. Aí a tela mostra o
     * que já veio, sem barra.
     */
    'carga:progresso': { tabela: string; escopo: string; baixados: number; total: number | null };
    /** Progresso da drenagem, para a tela poder dizer "enviando 42 de 300". */
    'fila:progresso': { enviadas: number; total: number; anexos: number };
    /** A fila mudou de tamanho ou de composição. */
    'fila:alterada': { pendentes: number; bloqueadas: number; conflitos: number; anexos: number };
    /**
     * Uma drenagem começou ou terminou. No fim, `motivo` diz POR QUE parou —
     * `sessao` é o que permite à tela pedir o login que destrava o envio, em
     * vez de deixar a fila parada em silêncio.
     */
    'drenagem:estado': {
        drenando: boolean;
        motivo?: 'fim' | 'rede' | 'sessao' | 'orcamento';
    };
    /** Algo precisa da atenção do usuário. */
    'atencao': { tipo: 'conflito' | 'bloqueada' | 'sessao' | 'armazenamento'; detalhe: string };
}

export type NomeEvento = keyof EventosSync;
export type Ouvinte<E extends NomeEvento> = (dados: EventosSync[E]) => void;

export class Emissor {
    private readonly ouvintes = new Map<NomeEvento, Set<Ouvinte<any>>>();

    escutar<E extends NomeEvento>(evento: E, ouvinte: Ouvinte<E>): () => void {
        const doEvento = this.ouvintes.get(evento) ?? new Set<Ouvinte<any>>();
        doEvento.add(ouvinte);
        this.ouvintes.set(evento, doEvento);
        return () => {
            doEvento.delete(ouvinte);
        };
    }

    /**
     * Um ouvinte que explode não pode derrubar a drenagem: a fila é dado do
     * usuário, a tela é só a tela.
     */
    emitir<E extends NomeEvento>(evento: E, dados: EventosSync[E]): void {
        this.ouvintes.get(evento)?.forEach((ouvinte) => {
            try {
                ouvinte(dados);
            } catch (erro) {
                console.warn(`[thesync] ouvinte de "${evento}" lançou:`, erro);
            }
        });
    }

    limpar(): void {
        this.ouvintes.clear();
    }
}

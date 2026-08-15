/**
 * Negociação de capacidade: tenta a estratégia preferida, cai para a de sempre.
 *
 * O motivo é concreto: o app e o backend sobem em momentos diferentes. Se a
 * declaração da tabela apontar direto para um recurso que ainda não foi
 * implantado, o app para de sincronizar por completo — e a tela fica vazia sem
 * explicar por quê, que é pior do que sincronizar de um jeito menos eficiente.
 *
 * A alternativa também cobre o caminho de volta: se o recurso novo for
 * removido ou desabilitado num ambiente, o app continua funcionando.
 */
import type { ContextoPuxada, EstrategiaPuxada, ResultadoPuxada } from '../../nucleo/tipos';

/** 404 = rota inexistente; 501 = declarada mas não habilitada naquele recurso. */
const recursoAusente = (erro: unknown): boolean => {
    const status = (erro as { status?: number })?.status;
    return status === 404 || status === 501;
};

export interface OpcoesComAlternativa {
    preferida: EstrategiaPuxada;
    alternativa: EstrategiaPuxada;
    /**
     * Decide se vale trocar. Por padrão só troca quando o recurso não existe —
     * um erro de rede NÃO deve mudar de estratégia, senão o app abandona a
     * preferida na primeira oscilação de sinal.
     */
    quandoTrocar?: (erro: unknown) => boolean;
}

export const comAlternativa = ({
    preferida,
    alternativa,
    quandoTrocar = recursoAusente,
}: OpcoesComAlternativa): EstrategiaPuxada => {
    // Uma vez decidido, não insiste: repetir a preferida a cada rodada
    // gastaria uma requisição perdida por sincronização.
    let usarAlternativa = false;

    return {
        nome: 'com-alternativa',

        async puxar(ctx: ContextoPuxada): Promise<ResultadoPuxada> {
            if (usarAlternativa) return alternativa.puxar(ctx);

            try {
                return await preferida.puxar(ctx);
            } catch (erro) {
                if (!quandoTrocar(erro)) throw erro;

                console.warn(
                    `[thesync] "${preferida.nome}" indisponível no servidor; usando "${alternativa.nome}".`,
                );
                usarAlternativa = true;
                return alternativa.puxar(ctx);
            }
        },
    };
};

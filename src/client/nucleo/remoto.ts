/**
 * O que chega de fora do ciclo de sincronização — o socket, hoje.
 *
 * O tempo real é um empurrão: a mensagem pode chegar DEPOIS de um pull que já
 * trouxe a versão mais nova do mesmo registro. Gravar assim mesmo faria o
 * espelho andar para trás — e a tela mostraria, por um minuto, a contagem
 * anterior à que o usuário acabou de ver.
 */
const instante = (valor: unknown): number => {
    if (typeof valor !== 'string' && typeof valor !== 'number') return 0;
    const data = new Date(valor).getTime();
    return Number.isNaN(data) ? 0 : data;
};

/**
 * O registro que chegou é mais VELHO do que o que já está no espelho?
 *
 * Sem `updatedAt` dos dois lados não há como saber — e aí o padrão é aplicar,
 * que é o que o pull sempre fez.
 */
export const isRetrocesso = (atualUpdatedAt: string | null, novoUpdatedAt: unknown): boolean => {
    const atual = instante(atualUpdatedAt);
    const novo = instante(novoUpdatedAt);
    if (!atual || !novo) return false;
    return novo < atual;
};

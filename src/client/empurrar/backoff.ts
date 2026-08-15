/**
 * Espera entre tentativas.
 *
 * Exponencial com teto e ruído. O ruído não é enfeite: sem ele, cinquenta
 * aparelhos que perderam a rede no mesmo corredor voltam a bater no servidor
 * exatamente no mesmo instante quando ela retorna.
 */

export const BASE_MS = 5_000;
export const TETO_MS = 15 * 60 * 1_000;
const RUIDO = 0.2;

export const MAX_TENTATIVAS = 5;

export const proximaTentativaEm = (tentativas: number, agora = Date.now()): number => {
    const cru = Math.min(BASE_MS * 2 ** Math.max(0, tentativas), TETO_MS);
    const variacao = cru * RUIDO * (Math.random() * 2 - 1);
    return agora + Math.round(cru + variacao);
};

export const esgotouTentativas = (tentativas: number): boolean => tentativas >= MAX_TENTATIVAS;

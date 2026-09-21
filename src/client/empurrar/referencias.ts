/**
 * Quando uma pendência precisa esperar outra.
 *
 * Com `id-do-cliente` o id do registro criado offline já é o definitivo: o
 * item que aponta para a localização nova leva, desde o toque, o mesmo id que
 * o servidor vai gravar. Não há chave para trocar depois. O que falta garantir
 * é a ORDEM: se a criação da localização entra em backoff (um 5xx), a
 * atualização do item, que está pronta, subiria antes e o servidor a recusaria
 * por chave estrangeira. A sequência da fila não basta porque o backoff tira a
 * criação da vez.
 *
 * A regra lê as `referencias` que a tabela declara: enquanto o registro
 * apontado tiver uma criação na fila, quem aponta para ele espera, sem gastar
 * tentativa. A edição de um registro que ainda não foi criado espera também.
 */
import type { DefinicaoTabela } from '../nucleo/tipos';
import type { Pendencia } from '../persistencia/saida';

/** Ids que ainda não existem no servidor, por tabela. */
export type CriacoesPendentes = Map<string, Set<string>>;

/** Toda criação que ainda está na fila, em qualquer estado: nenhuma chegou ao servidor. */
export const collectCriacoesPendentes = (pendencias: Pendencia[]): CriacoesPendentes => {
    const criacoes: CriacoesPendentes = new Map();
    for (const pendencia of pendencias.filter((atual) => atual.operacao === 'criar')) {
        const ids = criacoes.get(pendencia.tabela) ?? new Set<string>();
        ids.add(pendencia.registroId);
        criacoes.set(pendencia.tabela, ids);
    }
    return criacoes;
};

/** `bem.subLocalizacao_id` lê o campo aninhado. */
const readCampo = (payload: unknown, caminho: string): unknown =>
    caminho
        .split('.')
        .reduce<unknown>(
            (atual, chave) =>
                atual && typeof atual === 'object' ? (atual as Record<string, unknown>)[chave] : undefined,
            payload,
        );

const isCriacaoPendente = (criacoes: CriacoesPendentes, tabela: string, id: unknown): boolean =>
    typeof id === 'string' && criacoes.get(tabela)?.has(id) === true;

export const isAguardandoReferencia = (
    tabela: DefinicaoTabela,
    pendencia: Pendencia,
    criacoes: CriacoesPendentes,
): boolean => {
    const isEdicaoDeQuemNaoExiste =
        pendencia.operacao !== 'criar' && isCriacaoPendente(criacoes, tabela.nome, pendencia.registroId);
    if (isEdicaoDeQuemNaoExiste) return true;

    return (tabela.referencias ?? []).some(({ campo, tabela: alvo }) =>
        isCriacaoPendente(criacoes, alvo, readCampo(pendencia.payload, campo)),
    );
};

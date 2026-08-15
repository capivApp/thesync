/**
 * Idempotência durável.
 *
 * A implementação comum — um `Map` em memória do processo com TTL curto — não
 * serve para offline por três motivos, e o terceiro é o pior:
 *
 *  1. não sobrevive a restart nem é compartilhada entre réplicas;
 *  2. o TTL é de segundos, e o reenvio de campo acontece horas depois;
 *  3. ela costuma APAGAR a chave quando a conexão morre antes da resposta — que
 *     é exatamente o cenário do celular em campo. O retry re-executa mesmo
 *     dentro do TTL.
 *
 * Tabela e não cache externo: a escrita de negócio já roda dentro de uma
 * transação do banco. Gravando o registro na MESMA transação, o exactly-once sai
 * de graça. Com cache existe a janela "commitou no banco, perdeu no cache", que
 * produz justamente a duplicata que o mecanismo deveria evitar.
 */

export const TABELA_IDEMPOTENCIA = 'sync_idempotency';

/**
 * Sete dias. Trinta segundos é ficção para trabalho de campo; trinta dias faz a
 * tabela crescer sem retorno, porque o cliente desiste muito antes disso.
 */
export const RETENCAO_MS = 7 * 24 * 60 * 60 * 1_000;

export const SQL_CRIAR_IDEMPOTENCIA = `
CREATE TABLE IF NOT EXISTS public.sync_idempotency (
  entidade     INT         NOT NULL,
  key          TEXT        NOT NULL,
  owner        TEXT        NOT NULL,
  method       TEXT        NOT NULL,
  path         TEXT        NOT NULL,
  request_hash TEXT        NOT NULL,
  status       INT,
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (entidade, key)
);

CREATE INDEX IF NOT EXISTS sync_idempotency_prune_idx
  ON public.sync_idempotency (created_at);
`;

export type DesfechoIdempotencia =
    /** Primeira vez: siga com a requisição. */
    | { tipo: 'seguir' }
    /** Já concluída pelo mesmo dono e com o mesmo corpo: devolve o que foi gravado. */
    | { tipo: 'replay'; status: number; corpo: unknown }
    /** Uma requisição igual ainda está em voo. */
    | { tipo: 'em-voo'; retryAposSegundos: number }
    /** Mesma chave, corpo diferente. */
    | { tipo: 'corpo-divergente' }
    /** Mesma chave, outro usuário/entidade. */
    | { tipo: 'dono-divergente' };

export interface RegistroIdempotencia {
    owner: string;
    requestHash: string;
    status: number | null;
    response: unknown;
}

export interface ConsultaIdempotencia {
    owner: string;
    requestHash: string;
    existente: RegistroIdempotencia | null;
}

/**
 * Decide o desfecho a partir do que já existe na tabela.
 *
 * Função pura de propósito: é a regra mais fácil de errar do mecanismo e a mais
 * barata de testar isolada.
 */
export const decidirIdempotencia = ({
    owner,
    requestHash,
    existente,
}: ConsultaIdempotencia): DesfechoIdempotencia => {
    if (!existente) return { tipo: 'seguir' };
    if (existente.owner !== owner) return { tipo: 'dono-divergente' };

    // Reusar a chave com corpo diferente e receber a resposta antiga em silêncio
    // é o pior desfecho possível: o cliente acha que gravou o novo.
    if (existente.requestHash !== requestHash) return { tipo: 'corpo-divergente' };

    if (existente.status === null) return { tipo: 'em-voo', retryAposSegundos: 2 };

    return { tipo: 'replay', status: existente.status, corpo: existente.response };
};

export const statusDoDesfecho = (desfecho: DesfechoIdempotencia): number => {
    const porTipo: Record<DesfechoIdempotencia['tipo'], number> = {
        seguir: 200,
        replay: 200,
        'em-voo': 409,
        'corpo-divergente': 422,
        'dono-divergente': 409,
    };
    return porTipo[desfecho.tipo];
};

export const corpoDoDesfecho = (desfecho: DesfechoIdempotencia): unknown => {
    const porTipo: Record<DesfechoIdempotencia['tipo'], unknown> = {
        seguir: null,
        replay: desfecho.tipo === 'replay' ? desfecho.corpo : null,
        'em-voo': { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'Uma requisição igual ainda está em andamento.' },
        'corpo-divergente': {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'A chave de idempotência já foi usada com outro conteúdo.',
        },
        'dono-divergente': { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'A chave pertence a outro usuário.' },
    };
    return porTipo[desfecho.tipo];
};

/**
 * A poda precisa de escopo de tenant explícito.
 *
 * Sob RLS, um `DELETE` sem ele apaga ZERO linhas e o job "passa" para sempre,
 * enquanto a tabela cresce. Mesma armadilha vale para a poda do change log.
 */
export const SQL_PODAR_IDEMPOTENCIA = `
DELETE FROM public.sync_idempotency
 WHERE created_at < now() - interval '7 days';
`;

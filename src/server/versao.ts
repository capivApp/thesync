/**
 * Detecção de conflito por versão.
 *
 * `If-Unmodified-Since` sobre `updatedAt` não serve aqui pelos mesmos motivos
 * que o watermark não serve (ver `changeLog.ts`): a coluna é preenchida pelo
 * cliente do ORM, convive com escrita crua usando o relógio do banco, e duas
 * escritas no mesmo milissegundo são indistinguíveis.
 *
 * Um contador incrementado por TRIGGER resolve — e por ser trigger, também
 * pega a escrita crua, que um middleware do ORM não pegaria.
 *
 * O ponto que torna isto adotável: **sem o header, o comportamento é idêntico
 * ao de antes**. Consumidores que não sabem da versão continuam funcionando.
 */

export const SQL_ADICIONAR_VERSAO = (tabela: string): string => `
ALTER TABLE public.${tabela}
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
`;

export const SQL_FUNCAO_VERSAO = `
CREATE OR REPLACE FUNCTION public.bump_version_fn() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
`;

export const SQL_APLICAR_TRIGGERS_VERSAO = `
CREATE OR REPLACE FUNCTION public.apply_version_triggers(tabelas text[]) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS bump_version_%I ON public.%I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER bump_version_%I BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.bump_version_fn();', t, t);
  END LOOP;
END $$;
`;

export class ConflitoDeVersao extends Error {
    readonly status = 409;
    constructor(readonly atual: unknown) {
        super('O registro foi alterado por outro usuário.');
        this.name = 'ConflitoDeVersao';
    }
}

/** `undefined` quando o cliente não mandou nada — e aí não há checagem. */
export const versaoEsperada = (headerIfMatch: unknown): number | undefined => {
    if (typeof headerIfMatch !== 'string') return undefined;
    const limpo = headerIfMatch.replace(/^W\//, '').replace(/"/g, '').trim();
    const numero = Number(limpo);
    return Number.isInteger(numero) && numero >= 0 ? numero : undefined;
};

export const etagDaVersao = (versao: number): string => `"${versao}"`;

export interface DelegateComCas {
    update(args: { where: { id: string }; data: object }): Promise<unknown>;
    updateMany(args: { where: { id: string; version: number }; data: object }): Promise<{ count: number }>;
    findUnique(args: { where: { id: string } }): Promise<unknown>;
}

/**
 * Compare-and-swap ATÔMICO. Nunca ler-e-depois-escrever: entre a leitura e a
 * escrita cabe exatamente a atualização que queríamos detectar.
 */
export const atualizarComVersao = async (
    delegate: DelegateComCas,
    id: string,
    dados: object,
    esperada?: number,
): Promise<unknown> => {
    if (esperada === undefined) return delegate.update({ where: { id }, data: dados });

    const { count } = await delegate.updateMany({ where: { id, version: esperada }, data: dados });
    if (count === 0) throw new ConflitoDeVersao(await delegate.findUnique({ where: { id } }));

    return delegate.findUnique({ where: { id } });
};

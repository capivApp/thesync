/**
 * Anexo idempotente por HASH DO CONTEÚDO.
 *
 * O padrão comum — gerar um id no servidor e concatenar na lista — faz todo
 * reenvio criar um objeto novo no armazenamento e uma entrada nova no registro.
 * Como o cenário de campo é justamente "a conexão caiu no meio do upload", isso
 * significa foto duplicada toda vez que a rede oscila.
 *
 * Derivando a chave do conteúdo já otimizado:
 *  - o reenvio reescreve o MESMO objeto (operação sem efeito);
 *  - a entrada não duplica, porque a inserção é em conjunto e não concatenação;
 *  - e o comportamento que protege duas pessoas fotografando o mesmo bem ao
 *    mesmo tempo continua atômico.
 *
 * Nenhuma quantidade de cuidado no cliente substitui isto.
 */

export interface ChaveDeAnexo {
    /** Identidade estável do anexo, derivada do conteúdo. */
    id: string;
    /** Caminho no armazenamento de objetos. */
    chave: string;
}

export interface ParametrosDaChave {
    entidade: number;
    registroId: string;
    /** sha256 (hex) do conteúdo já otimizado. */
    hash: string;
    extensao?: string;
}

export const chaveDoAnexo = ({
    entidade,
    registroId,
    hash,
    extensao = 'webp',
}: ParametrosDaChave): ChaveDeAnexo => ({
    id: hash,
    chave: `sync/anexos/${entidade}/${registroId}/${hash}.${extensao}`,
});

/**
 * Inserção em CONJUNTO na coluna JSON.
 *
 * O `CASE` é o que torna a operação idempotente sem abrir mão da atomicidade: a
 * entrada só é concatenada quando ainda não existe uma com o mesmo id, e tudo
 * acontece numa instrução só — duas pessoas fotografando ao mesmo tempo não se
 * sobrescrevem.
 *
 * `$1` = json da entrada, `$2` = id da entrada, `$3` = id do registro.
 */
export const sqlInserirAnexoEmConjunto = (tabela: string, coluna: string): string => `
UPDATE public.${tabela}
   SET "${coluna}" = CASE
         WHEN EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE("${coluna}", '[]'::jsonb)) entrada
            WHERE entrada->>'id' = $2
         )
         THEN "${coluna}"
         ELSE (
           CASE WHEN jsonb_typeof("${coluna}") = 'array' THEN "${coluna}" ELSE '[]'::jsonb END
         ) || $1::jsonb
       END,
       "updatedAt" = NOW()
 WHERE "id" = $3
 RETURNING *;
`;

/**
 * O espelho: o que o servidor disse, como ele disse.
 *
 * Mantê-lo puro é o que torna todo o resto previsível. A tela é
 * `espelho + fila sobreposta`; se o espelho fosse contaminado com edições
 * locais, o app perderia a capacidade de perceber que divergiu do servidor.
 */
import { bancoDaEntidade } from './banco';
import type { ColunaIndexada, ContextoSync, DefinicaoTabela } from '../nucleo/tipos';

export interface RegistroLocal<T = unknown> {
    id: string;
    dados: T;
    updatedAt: string | null;
    origem: 'servidor' | 'local';
    excluido: boolean;
}

interface LinhaRegistro {
    id: string;
    dados: string;
    updated_at: string | null;
    origem: string;
    excluido: number;
}

export interface FiltroLocal {
    /** Filtra por uma coluna projetada na declaração da tabela. */
    coluna?: string;
    igualA?: string | number;
    /** Inclui os marcados como excluídos (por padrão eles não aparecem). */
    incluirExcluidos?: boolean;
    limite?: number;
}

const paraRegistro = <T>(linha: LinhaRegistro): RegistroLocal<T> => ({
    id: linha.id,
    dados: JSON.parse(linha.dados) as T,
    updatedAt: linha.updated_at,
    origem: linha.origem === 'local' ? 'local' : 'servidor',
    excluido: linha.excluido === 1,
});

/**
 * Trava contra parâmetro posicional fora de ordem em SQL montado.
 *
 * Um `?` a mais ou a menos o SQLite acusa; a ORDEM trocada ele aceita em
 * silêncio — casa os valores nas posições erradas, a consulta não encontra
 * nada e a tela fica vazia como se não houvesse dado. Foi assim que o
 * inventário apareceu sem itens. A contagem não pega troca entre dois
 * parâmetros do mesmo tipo, mas pega o caso que realmente acontece: alguém
 * acrescentar uma condição e esquecer de empilhar o valor no lugar certo.
 */
const conferirParametros = (sql: string, parametros: unknown[]): void => {
    const esperados = (sql.match(/\?/g) ?? []).length;
    if (esperados === parametros.length) return;
    throw new Error(
        `[thesync] SQL com ${esperados} parâmetros e ${parametros.length} valores. ` +
        `Eles são posicionais: monte os valores na ordem em que os "?" aparecem.`,
    );
};

const idDoRegistro = (tabela: DefinicaoTabela, bruto: any): string | null => {
    const id = tabela.leitura.extrairId ? tabela.leitura.extrairId(bruto) : bruto?.[tabela.chavePrimaria];
    return typeof id === 'string' && id.length > 0 ? id : null;
};

const valorIndexado = (coluna: ColunaIndexada, registro: unknown) => {
    const valor = coluna.extrair(registro);
    if (valor === null || valor === undefined) return { texto: null, numero: null };
    if (coluna.tipo === 'numero') {
        const numero = Number(valor);
        return { texto: null, numero: Number.isFinite(numero) ? numero : null };
    }
    return { texto: String(valor), numero: null };
};

/**
 * Grava um lote de registros do servidor.
 *
 * UMA transação com statement preparado. Milhares de gravações soltas levam
 * minutos num Android médio, e o usuário mata o app no meio da carga inicial.
 */
export const gravarLote = async (
    contexto: ContextoSync,
    tabela: DefinicaoTabela,
    brutos: unknown[],
    origem: 'servidor' | 'local' = 'servidor',
): Promise<number> => {
    if (brutos.length === 0) return 0;

    const banco = await bancoDaEntidade(contexto.entidade);
    const agora = Date.now();
    const colunas = tabela.colunasIndexadas ?? [];
    let gravados = 0;

    await banco.withTransactionAsync(async () => {
        const gravarRegistro = await banco.prepareAsync(`
      INSERT INTO registros
        (entidade, tabela, id, dados, updated_at, origem, excluido, visto_em, baixado_em)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT (entidade, tabela, id) DO UPDATE SET
        dados = excluded.dados,
        updated_at = excluded.updated_at,
        origem = excluded.origem,
        excluido = 0,
        visto_em = excluded.visto_em,
        baixado_em = excluded.baixado_em;
    `);
        const gravarIndice = await banco.prepareAsync(`
      INSERT INTO indice_registros (entidade, tabela, coluna, id, valor_texto, valor_num)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (entidade, tabela, coluna, id) DO UPDATE SET
        valor_texto = excluded.valor_texto,
        valor_num = excluded.valor_num;
    `);

        try {
            for (const bruto of brutos) {
                const id = idDoRegistro(tabela, bruto);
                if (!id) continue;

                const updatedAt = (bruto as any)?.updatedAt ?? null;
                await gravarRegistro.executeAsync([
                    contexto.entidade,
                    tabela.nome,
                    id,
                    JSON.stringify(bruto),
                    typeof updatedAt === 'string' ? updatedAt : null,
                    origem,
                    agora,
                    agora,
                ]);

                // Índice na MESMA transação do registro, senão o índice mente.
                for (const coluna of colunas) {
                    const { texto, numero } = valorIndexado(coluna, bruto);
                    await gravarIndice.executeAsync([
                        contexto.entidade,
                        tabela.nome,
                        coluna.nome,
                        id,
                        texto,
                        numero,
                    ]);
                }

                gravados += 1;
            }
        } finally {
            await gravarRegistro.finalizeAsync();
            await gravarIndice.finalizeAsync();
        }
    });

    return gravados;
};

export const lerRegistro = async <T>(
    contexto: ContextoSync,
    tabela: string,
    id: string,
): Promise<RegistroLocal<T> | null> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<LinhaRegistro>(
        `SELECT id, dados, updated_at, origem, excluido
       FROM registros WHERE entidade = ? AND tabela = ? AND id = ?;`,
        [contexto.entidade, tabela, id],
    );
    return linha ? paraRegistro<T>(linha) : null;
};

export const listarRegistros = async <T>(
    contexto: ContextoSync,
    tabela: string,
    filtro: FiltroLocal = {},
): Promise<RegistroLocal<T>[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    /**
     * Os parâmetros são POSICIONAIS: eles precisam ser montados na mesma ordem
     * em que os `?` aparecem no SQL. O `?` da junção vem ANTES dos do `WHERE`,
     * então ele é empilhado primeiro.
     *
     * Isto já esteve errado e não deu erro nenhum: o SQLite apenas casou os
     * valores nas posições trocadas, a consulta não encontrou nada e a tela
     * ficou vazia como se o inventário não tivesse itens. Por isso a montagem
     * agora acompanha a leitura do SQL, de cima para baixo.
     */
    const parametros: (string | number)[] = [];

    const junta = filtro.coluna
        ? `JOIN indice_registros i
             ON i.entidade = r.entidade AND i.tabela = r.tabela
            AND i.id = r.id AND i.coluna = ?`
        : '';
    if (filtro.coluna) parametros.push(filtro.coluna);

    const condicoes = ['r.entidade = ?', 'r.tabela = ?'];
    parametros.push(contexto.entidade, tabela);

    if (!filtro.incluirExcluidos) condicoes.push('r.excluido = 0');

    if (filtro.coluna && filtro.igualA !== undefined) {
        condicoes.push(typeof filtro.igualA === 'number' ? 'i.valor_num = ?' : 'i.valor_texto = ?');
        parametros.push(filtro.igualA);
    }

    const limite = filtro.limite ? ` LIMIT ${Number(filtro.limite)}` : '';
    const sql = `SELECT r.id, r.dados, r.updated_at, r.origem, r.excluido
       FROM registros r ${junta}
      WHERE ${condicoes.join(' AND ')}${limite};`;

    conferirParametros(sql, parametros);

    const linhas = await banco.getAllAsync<LinhaRegistro>(sql, parametros);

    return linhas.map((linha) => paraRegistro<T>(linha));
};

/** Quantos registros a tabela tem no espelho. Barato: só conta. */
export const contarRegistros = async (
    contexto: ContextoSync,
    tabela: string,
): Promise<number> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linha = await banco.getFirstAsync<{ total: number }>(
        `SELECT COUNT(*) AS total FROM registros
      WHERE entidade = ? AND tabela = ? AND excluido = 0;`,
        [contexto.entidade, tabela],
    );
    return linha?.total ?? 0;
};

export const listarIds = async (
    contexto: ContextoSync,
    tabela: string,
): Promise<string[]> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = await banco.getAllAsync<{ id: string }>(
        `SELECT id FROM registros WHERE entidade = ? AND tabela = ? AND excluido = 0;`,
        [contexto.entidade, tabela],
    );
    return linhas.map((linha) => linha.id);
};

/** Contagem agrupada por uma coluna projetada — sem carregar o conjunto. */
export const contarPor = async (
    contexto: ContextoSync,
    tabela: string,
    coluna: string,
): Promise<Record<string, number>> => {
    const banco = await bancoDaEntidade(contexto.entidade);
    const linhas = await banco.getAllAsync<{ valor: string | null; total: number }>(
        `SELECT i.valor_texto AS valor, COUNT(*) AS total
       FROM indice_registros i
       JOIN registros r ON r.entidade = i.entidade AND r.tabela = i.tabela AND r.id = i.id
      WHERE i.entidade = ? AND i.tabela = ? AND i.coluna = ? AND r.excluido = 0
      GROUP BY i.valor_texto;`,
        [contexto.entidade, tabela, coluna],
    );

    return linhas.reduce<Record<string, number>>((acumulado, linha) => {
        acumulado[linha.valor ?? ''] = linha.total;
        return acumulado;
    }, {});
};

/**
 * Marca exclusões. O registro NÃO é apagado: uma pendência da fila ainda pode
 * apontar para ele, e a tela precisa conseguir dizer de qual item se tratava.
 */
export const marcarExcluidos = async (
    contexto: ContextoSync,
    tabela: string,
    ids: string[],
): Promise<number> => {
    if (ids.length === 0) return 0;

    const banco = await bancoDaEntidade(contexto.entidade);
    await banco.withTransactionAsync(async () => {
        const marcar = await banco.prepareAsync(
            `UPDATE registros SET excluido = 1 WHERE entidade = ? AND tabela = ? AND id = ?;`,
        );
        try {
            for (const id of ids) await marcar.executeAsync([contexto.entidade, tabela, id]);
        } finally {
            await marcar.finalizeAsync();
        }
    });

    return ids.length;
};

/**
 * Reconciliação por conjunto completo: tudo que o servidor NÃO listou está
 * excluído. É como o app descobre exclusões enquanto o backend não manda
 * tombstone — e por isso `ResultadoPuxada.completo` existe.
 */
export const reconciliarConjunto = async (
    contexto: ContextoSync,
    tabela: string,
    idsPresentes: string[],
): Promise<string[]> => {
    const presentes = new Set(idsPresentes);
    const locais = await listarIds(contexto, tabela);
    const sumidos = locais.filter((id) => !presentes.has(id));
    await marcarExcluidos(contexto, tabela, sumidos);
    return sumidos;
};

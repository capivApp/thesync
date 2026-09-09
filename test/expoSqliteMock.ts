/**
 * `expo-sqlite` de mentira, em cima do `bun:sqlite`, para os testes de
 * persistência rodarem fora do aparelho.
 *
 * Só a fatia da API que o pacote usa. Cada nome de banco vira um banco em
 * memória próprio, então dois testes na mesma entidade compartilham estado —
 * use entidades diferentes ou `fecharBancos()` entre eles.
 */
import { Database } from 'bun:sqlite';
import { mock } from 'bun:test';

class Statement {
    constructor(private readonly banco: Database, private readonly sql: string) {}

    async executeAsync(parametros: unknown[] = []) {
        return this.banco.run(this.sql, parametros as never);
    }

    async finalizeAsync() {}
}

class SQLiteDatabase {
    private readonly banco = new Database(':memory:');

    async execAsync(sql: string) {
        this.banco.exec(sql);
    }

    async runAsync(sql: string, parametros: unknown[] = []) {
        const resultado = this.banco.run(sql, parametros as never);
        return { changes: resultado.changes, lastInsertRowId: Number(resultado.lastInsertRowid) };
    }

    async getFirstAsync<T>(sql: string, parametros: unknown[] = []): Promise<T | null> {
        return (this.banco.query(sql).get(...(parametros as never[])) as T) ?? null;
    }

    async getAllAsync<T>(sql: string, parametros: unknown[] = []): Promise<T[]> {
        return this.banco.query(sql).all(...(parametros as never[])) as T[];
    }

    async prepareAsync(sql: string) {
        return new Statement(this.banco, sql);
    }

    async withTransactionAsync(trabalho: () => Promise<void>) {
        this.banco.exec('BEGIN;');
        try {
            await trabalho();
            this.banco.exec('COMMIT;');
        } catch (erro) {
            this.banco.exec('ROLLBACK;');
            throw erro;
        }
    }

    async closeAsync() {
        this.banco.close();
    }
}

mock.module('expo-sqlite', () => ({
    openDatabaseAsync: async () => new SQLiteDatabase(),
}));

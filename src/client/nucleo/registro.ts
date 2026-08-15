/**
 * O catálogo de tabelas declaradas.
 *
 * Mapa por nome (nunca uma cadeia de condicionais) e ordenação topológica das
 * dependências: uma localização criada offline precisa existir no servidor
 * antes do item que a referencia subir.
 */
import type { DefinicaoTabela } from './tipos';

export class TabelaNaoRegistrada extends Error {
    constructor(nome: string) {
        super(`Tabela "${nome}" não foi declarada no motor de sincronização.`);
        this.name = 'TabelaNaoRegistrada';
    }
}

export class DependenciaCiclica extends Error {
    constructor(envolvidas: string[]) {
        super(`Dependência cíclica entre tabelas: ${envolvidas.join(' → ')}.`);
        this.name = 'DependenciaCiclica';
    }
}

export class RegistroDeTabelas {
    private readonly porNome = new Map<string, DefinicaoTabela>();

    constructor(definicoes: DefinicaoTabela[] = []) {
        definicoes.forEach((definicao) => this.adicionar(definicao));
    }

    adicionar(definicao: DefinicaoTabela): void {
        this.porNome.set(definicao.nome, definicao);
    }

    obter(nome: string): DefinicaoTabela {
        const definicao = this.porNome.get(nome);
        if (!definicao) throw new TabelaNaoRegistrada(nome);
        return definicao;
    }

    tem(nome: string): boolean {
        return this.porNome.has(nome);
    }

    todas(): DefinicaoTabela[] {
        return [...this.porNome.values()];
    }

    graváveis(): DefinicaoTabela[] {
        return this.todas().filter((definicao) => definicao.modo === 'leitura-escrita');
    }

    /**
     * Ordem em que as tabelas podem subir: dependência antes de dependente.
     *
     * Dependência declarada para tabela que não existe é ignorada de propósito
     * — o app pode sincronizar um subconjunto do domínio sem que a declaração
     * precise mudar.
     */
    ordemDePush(): DefinicaoTabela[] {
        const ordenadas: DefinicaoTabela[] = [];
        const visitando = new Set<string>();
        const visitadas = new Set<string>();

        const visitar = (definicao: DefinicaoTabela, caminho: string[]): void => {
            if (visitadas.has(definicao.nome)) return;
            if (visitando.has(definicao.nome)) throw new DependenciaCiclica([...caminho, definicao.nome]);

            visitando.add(definicao.nome);
            (definicao.dependeDe ?? [])
                .filter((nome) => this.porNome.has(nome))
                .forEach((nome) => visitar(this.obter(nome), [...caminho, definicao.nome]));
            visitando.delete(definicao.nome);

            visitadas.add(definicao.nome);
            ordenadas.push(definicao);
        };

        this.todas().forEach((definicao) => visitar(definicao, []));
        return ordenadas;
    }
}

export const criarRegistroDeTabelas = (definicoes: DefinicaoTabela[]): RegistroDeTabelas =>
    new RegistroDeTabelas(definicoes);

/**
 * O motor.
 *
 * Amarra espelho, fila de escritas e fila de anexos numa API pequena. Nada aqui
 * importa React nem toca em tela — o motor emite eventos. É o que permite ligar
 * envio em segundo plano depois sem reescrever nada: uma tarefa headless chama
 * `drenar()` exatamente como a UI chama.
 */
import type { Transporte } from '../../protocol/transporte';
import { FilaDeAnexos } from '../anexos/filaAnexos';
import { guardarArquivo, novoIdDeAnexo } from '../anexos/arquivos';
import { Empurrador, type OrcamentoDrenagem } from '../empurrar/empurrador';
import {
    contarAnexos,
    enfileirarAnexo,
    jaEnfileirado,
    recuperarAnexosEmVoo,
} from '../persistencia/anexos';
import { lerRegistro } from '../persistencia/registros';
import {
    contarPendencias,
    enfileirar,
    idadeDaMaisAntiga,
    liberarBloqueadas,
    recuperarEmVoo,
    type Pendencia,
} from '../persistencia/saida';
import { liberarAnexosBloqueados } from '../persistencia/anexos';
import { puxarTabela } from '../puxar/puxador';
import { conferirConectividade } from '../rede/conectividade';
import { Emissor, type NomeEvento, type Ouvinte } from './eventos';
import { criarRegistroDeTabelas, RegistroDeTabelas } from './registro';
import type { ContextoSync, DefinicaoTabela } from './tipos';

export interface ConfiguracaoMotor {
    transporte: Transporte;
    tabelas: DefinicaoTabela[];
}

export interface EscritaSolicitada {
    tabela: string;
    id: string;
    campos: Record<string, unknown>;
}

export interface AnexoSolicitado {
    tabela: string;
    id: string;
    arquivo: { uri: string; mime: string };
    /** Hash do conteúdo, quando o app já calculou. Evita o duplo-toque. */
    hash?: string;
}

export interface EstadoDaFila {
    pendentes: number;
    bloqueadas: number;
    conflitos: number;
    anexosPendentes: number;
    anexosBloqueados: number;
    anexosInseguros: number;
    idadeDaMaisAntigaMs: number | null;
}

export interface ResultadoDrenagemCompleta {
    escritas: number;
    anexos: number;
    restantes: number;
    interrompidaPor: 'fim' | 'rede' | 'sessao' | 'orcamento';
}

export class Motor {
    private readonly registro: RegistroDeTabelas;
    private readonly emissor = new Emissor();
    private readonly empurrador: Empurrador;
    private readonly filaDeAnexos: FilaDeAnexos;
    private drenagemEmVoo: Promise<ResultadoDrenagemCompleta> | null = null;

    constructor(private readonly configuracao: ConfiguracaoMotor) {
        this.registro = criarRegistroDeTabelas(configuracao.tabelas);
        this.empurrador = new Empurrador(this.registro, configuracao.transporte, this.emissor);
        this.filaDeAnexos = new FilaDeAnexos(this.registro, configuracao.transporte, this.emissor);
    }

    escutar<E extends NomeEvento>(evento: E, ouvinte: Ouvinte<E>): () => void {
        return this.emissor.escutar(evento, ouvinte);
    }

    tabelas(): DefinicaoTabela[] {
        return this.registro.todas();
    }

    /**
     * Devolve à fila o que ficou "enviando" quando o app morreu.
     *
     * Reenviar um `atualizar` é seguro: o PUT leva o estado que o usuário quer,
     * e repetir dá o mesmo resultado. Um `criar` só é seguro quando o id vem do
     * cliente — senão o reenvio criaria um segundo registro.
     */
    async recuperar(contexto: ContextoSync): Promise<{ duvidosas: Pendencia[]; anexos: number }> {
        const duvidosas = await recuperarEmVoo(contexto, (pendencia) => {
            if (pendencia.operacao !== 'criar') return true;
            const tabela = this.registro.obter(pendencia.tabela);
            return tabela.escrita?.estrategiaId === 'id-do-cliente';
        });

        const anexos = await recuperarAnexosEmVoo(contexto);
        return { duvidosas, anexos };
    }

    /** Traz do servidor tudo que o escopo precisa. */
    async sincronizar(contexto: ContextoSync, sinal?: AbortSignal): Promise<void> {
        for (const tabela of this.registro.todas()) {
            await puxarTabela(contexto, tabela, this.configuracao.transporte, this.emissor, sinal);
        }
    }

    /** Traz uma tabela só — usado quando a tela de um agregado abre. */
    async sincronizarTabela(
        contexto: ContextoSync,
        nome: string,
        sinal?: AbortSignal,
    ): Promise<void> {
        await puxarTabela(
            contexto,
            this.registro.obter(nome),
            this.configuracao.transporte,
            this.emissor,
            sinal,
        );
    }

    /**
     * Registra a intenção do usuário. Grava em disco ANTES de qualquer rede.
     *
     * `baseUpdatedAt` guarda o que ele estava vendo — é o que permite detectar,
     * na hora do envio, que outra pessoa mexeu no registro nesse meio-tempo.
     */
    async enfileirar(contexto: ContextoSync, escrita: EscritaSolicitada): Promise<Pendencia> {
        const atual = await lerRegistro(contexto, escrita.tabela, escrita.id);

        return enfileirar(contexto, {
            tabela: escrita.tabela,
            registroId: escrita.id,
            operacao: 'atualizar',
            payload: escrita.campos,
            camposAlterados: Object.keys(escrita.campos),
            baseUpdatedAt: atual?.updatedAt ?? null,
        });
    }

    /**
     * Guarda o arquivo e enfileira.
     *
     * A cópia para o diretório do app acontece ANTES do enfileiramento: se o
     * app morrer no meio, o pior caso é um arquivo órfão — nunca uma pendência
     * apontando para um arquivo que o sistema apagou.
     */
    async anexar(contexto: ContextoSync, solicitado: AnexoSolicitado): Promise<string | null> {
        const tabela = this.registro.obter(solicitado.tabela);
        if (!tabela.anexos) throw new Error(`Tabela "${tabela.nome}" não declara anexos.`);

        if (await jaEnfileirado(contexto, solicitado.id, solicitado.hash ?? null)) return null;

        const id = novoIdDeAnexo();
        const guardado = guardarArquivo(id, solicitado.arquivo.uri, solicitado.arquivo.mime);

        if (!guardado.seguro) {
            this.emissor.emitir('atencao', {
                tipo: 'armazenamento',
                detalhe: 'A foto ficou no cache do aparelho e pode ser apagada pelo sistema. Sincronize assim que possível.',
            });
        }

        await enfileirarAnexo(contexto, {
            id,
            tabela: solicitado.tabela,
            registroId: solicitado.id,
            campo: tabela.anexos.campo,
            caminho: guardado.caminho,
            nomeArquivo: guardado.nome,
            mime: solicitado.arquivo.mime,
            bytes: guardado.bytes,
            hash: solicitado.hash ?? null,
            seguro: guardado.seguro,
        });

        await this.publicarEstadoDaFila(contexto);
        return id;
    }

    /**
     * Esvazia as duas filas. Single-flight: chamadas concorrentes esperam a
     * mesma drenagem em vez de duplicar envio.
     *
     * Escritas primeiro: elas são pequenas e é a contagem que o usuário quer
     * ver refletida. Um upload de 2 MB no 3G não pode segurar dez contagens.
     */
    drenar(contexto: ContextoSync, orcamento: OrcamentoDrenagem = {}): Promise<ResultadoDrenagemCompleta> {
        this.drenagemEmVoo ??= this.executarDrenagem(contexto, orcamento).finally(() => {
            this.drenagemEmVoo = null;
        });
        return this.drenagemEmVoo;
    }

    private async executarDrenagem(
        contexto: ContextoSync,
        orcamento: OrcamentoDrenagem,
    ): Promise<ResultadoDrenagemCompleta> {
        this.emissor.emitir('drenagem:estado', { drenando: true });

        try {
            if (!(await conferirConectividade())) {
                return { escritas: 0, anexos: 0, restantes: 0, interrompidaPor: 'rede' };
            }

            const escritas = await this.empurrador.drenar(contexto, orcamento);
            if (escritas.interrompidaPor === 'rede' || escritas.interrompidaPor === 'sessao') {
                return {
                    escritas: escritas.enviadas,
                    anexos: 0,
                    restantes: escritas.restantes,
                    interrompidaPor: escritas.interrompidaPor,
                };
            }

            const anexos = await this.filaDeAnexos.drenar(contexto, orcamento);
            await this.publicarEstadoDaFila(contexto);

            return {
                escritas: escritas.enviadas,
                anexos: anexos.enviados,
                restantes: escritas.restantes + anexos.restantes,
                interrompidaPor: anexos.interrompidaPor === 'fim' ? escritas.interrompidaPor : anexos.interrompidaPor,
            };
        } finally {
            this.emissor.emitir('drenagem:estado', { drenando: false });
        }
    }

    async estadoDaFila(contexto: ContextoSync): Promise<EstadoDaFila> {
        const [escritas, anexos, idade] = await Promise.all([
            contarPendencias(contexto),
            contarAnexos(contexto),
            idadeDaMaisAntiga(contexto),
        ]);

        return {
            ...escritas,
            anexosPendentes: anexos.pendentes,
            anexosBloqueados: anexos.bloqueados,
            anexosInseguros: anexos.inseguros,
            idadeDaMaisAntigaMs: idade,
        };
    }

    /** "Tentar novamente" da tela de pendências. */
    async liberarBloqueadas(contexto: ContextoSync): Promise<number> {
        const escritas = await liberarBloqueadas(contexto);
        const anexos = await liberarAnexosBloqueados(contexto);
        await this.publicarEstadoDaFila(contexto);
        return escritas + anexos;
    }

    private async publicarEstadoDaFila(contexto: ContextoSync): Promise<void> {
        const estado = await this.estadoDaFila(contexto);
        this.emissor.emitir('fila:alterada', {
            pendentes: estado.pendentes,
            bloqueadas: estado.bloqueadas,
            conflitos: estado.conflitos,
            anexos: estado.anexosPendentes,
        });
    }
}

export const criarMotor = (configuracao: ConfiguracaoMotor): Motor => new Motor(configuracao);

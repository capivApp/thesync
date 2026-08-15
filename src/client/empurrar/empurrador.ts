/**
 * Esvazia a fila.
 *
 * Nada aqui importa React, lê store ou toca em cache de tela — o empurrador
 * emite eventos e quem escuta é a UI. É o que permite que, um dia, uma tarefa
 * de segundo plano chame exatamente esta função sem existir tela nenhuma.
 *
 * Ele também respeita um orçamento (`limiteMs`), do tamanho da janela curta que
 * o Android concede a tarefas de fundo.
 */
import { consomeTentativa, exigeOUsuario, interrompeAFila } from '../../protocol/erros';
import type { Falha } from '../../protocol/erros';
import type { Transporte } from '../../protocol/transporte';
import { Emissor } from '../nucleo/eventos';
import type { RegistroDeTabelas } from '../nucleo/registro';
import type { ContextoSync, DefinicaoTabela } from '../nucleo/tipos';
import { gravarLote, lerRegistro } from '../persistencia/registros';
import {
    contarPendencias,
    listarProntas,
    marcarEstado,
    registrarFalha,
    removerPendencia,
    type EstadoPendencia,
    type Pendencia,
} from '../persistencia/saida';
import { esgotouTentativas, proximaTentativaEm } from './backoff';

export interface OrcamentoDrenagem {
    /** Para de pegar pendências novas depois disto. Não aborta a que está em voo. */
    limiteMs?: number;
    /** Teto de pendências nesta rodada. */
    limiteItens?: number;
    sinal?: AbortSignal;
}

export interface ResultadoDrenagem {
    enviadas: number;
    falhas: number;
    restantes: number;
    interrompidaPor: 'fim' | 'rede' | 'sessao' | 'orcamento';
}

type Desfecho = 'enviada' | 'falhou' | 'parar';

const requisicaoDe = (
    tabela: DefinicaoTabela,
    pendencia: Pendencia,
): { metodo: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; rota: string; corpo?: unknown } => {
    const escrita = tabela.escrita;
    if (!escrita) throw new Error(`Tabela "${tabela.nome}" não declara escrita.`);

    const construtores = {
        criar: () => {
            if (!escrita.criar) throw new Error(`Tabela "${tabela.nome}" não permite criação.`);
            return escrita.criar(pendencia.payload as any);
        },
        atualizar: () => escrita.atualizar(pendencia.payload as any, pendencia.registroId),
        remover: () => {
            if (!escrita.remover) throw new Error(`Tabela "${tabela.nome}" não permite remoção.`);
            return escrita.remover(pendencia.registroId);
        },
    } as const;

    return construtores[pendencia.operacao]();
};

const estadoAposFalha = (falha: Falha, tentativas: number): EstadoPendencia => {
    if (falha.tipo === 'conflito-versao') return 'conflito';
    if (exigeOUsuario(falha)) return 'bloqueada';
    if (consomeTentativa(falha) && esgotouTentativas(tentativas + 1)) return 'bloqueada';
    return 'pendente';
};

export class Empurrador {
    constructor(
        private readonly registro: RegistroDeTabelas,
        private readonly transporte: Transporte,
        private readonly emissor: Emissor,
    ) { }

    /**
     * A entidade da linha é conferida contra a da sessão ANTES de despachar.
     *
     * Cenário real: o conferente enfileira offline na prefeitura A, troca de
     * entidade para a B e reconecta. Sem esta checagem a contagem de A entraria
     * na B — e o servidor aceitaria, porque o header da requisição já é o de B.
     */
    private entidadeConfere(pendencia: Pendencia): boolean {
        const atual = this.transporte.entidadeAtual();
        return atual !== null && atual === pendencia.entidade;
    }

    private async aplicarSucesso(
        contexto: ContextoSync,
        tabela: DefinicaoTabela,
        pendencia: Pendencia,
    ): Promise<void> {
        // O espelho recebe o que sabemos ter sido aceito. A verdade completa
        // chega no próximo pull ou pelo tempo real; isto evita a tela piscar
        // de volta para o valor antigo entre o envio e a próxima sincronização.
        const atual = await lerRegistro<Record<string, unknown>>(contexto, tabela.nome, pendencia.registroId);
        if (atual) {
            await gravarLote(contexto, tabela, [{ ...atual.dados, ...pendencia.payload }]);
            this.emissor.emitir('registro:alterado', {
                tabela: tabela.nome,
                id: pendencia.registroId,
                registro: { ...atual.dados, ...pendencia.payload },
            });
        }

        await removerPendencia(contexto, pendencia.id);
    }

    private async processar(contexto: ContextoSync, pendencia: Pendencia): Promise<Desfecho> {
        if (!this.entidadeConfere(pendencia)) {
            await registrarFalha(contexto, {
                id: pendencia.id,
                erro: 'A sessão atual é de outra entidade. Entre na entidade original para enviar.',
                contaTentativa: false,
                proximaTentativaEm: 0,
                estado: 'bloqueada',
            });
            this.emissor.emitir('atencao', {
                tipo: 'sessao',
                detalhe: 'Há alterações pendentes de outra entidade.',
            });
            return 'falhou';
        }

        const tabela = this.registro.obter(pendencia.tabela);
        await marcarEstado(contexto, pendencia.id, 'enviando');

        try {
            const requisicao = requisicaoDe(tabela, pendencia);
            await this.transporte.escrever({
                ...requisicao,
                chaveIdempotencia: pendencia.id,
                // Só manda `If-Match` quando sabemos a versão que o usuário
                // estava vendo. Sem ela o servidor mantém o comportamento
                // antigo — é o que permite adotar a checagem aos poucos.
                versaoEsperada:
                    pendencia.baseVersion === null ? undefined : String(pendencia.baseVersion),
            });
            await this.aplicarSucesso(contexto, tabela, pendencia);
            return 'enviada';
        } catch (erro) {
            const falha = this.transporte.classificar(erro);
            const conta = consomeTentativa(falha);

            await registrarFalha(contexto, {
                id: pendencia.id,
                erro: falha.mensagem,
                status: falha.status,
                contaTentativa: conta,
                proximaTentativaEm: conta ? proximaTentativaEm(pendencia.tentativas) : 0,
                estado: estadoAposFalha(falha, pendencia.tentativas),
            });

            if (exigeOUsuario(falha)) {
                this.emissor.emitir('atencao', {
                    tipo: falha.tipo === 'conflito-versao' ? 'conflito' : 'bloqueada',
                    detalhe: `${tabela.descrever(pendencia.payload)}: ${falha.mensagem}`,
                });
            }

            return interrompeAFila(falha) ? 'parar' : 'falhou';
        }
    }

    async drenar(contexto: ContextoSync, orcamento: OrcamentoDrenagem = {}): Promise<ResultadoDrenagem> {
        const limite = orcamento.limiteMs ? Date.now() + orcamento.limiteMs : Infinity;
        const prontas = await listarProntas(contexto);
        const alvo = orcamento.limiteItens ? prontas.slice(0, orcamento.limiteItens) : prontas;

        let enviadas = 0;
        let falhas = 0;
        let interrompidaPor: ResultadoDrenagem['interrompidaPor'] = 'fim';

        for (const pendencia of alvo) {
            if (orcamento.sinal?.aborted) {
                interrompidaPor = 'orcamento';
                break;
            }
            if (Date.now() > limite) {
                interrompidaPor = 'orcamento';
                break;
            }

            const desfecho = await this.processar(contexto, pendencia);
            if (desfecho === 'enviada') enviadas += 1;
            if (desfecho === 'falhou') falhas += 1;
            if (desfecho === 'parar') {
                interrompidaPor = 'rede';
                break;
            }

            this.emissor.emitir('fila:progresso', {
                enviadas,
                total: alvo.length,
                anexos: 0,
            });
        }

        const contagem = await contarPendencias(contexto);
        this.emissor.emitir('fila:alterada', { ...contagem, anexos: 0 });

        return {
            enviadas,
            falhas,
            restantes: contagem.pendentes,
            interrompidaPor,
        };
    }
}

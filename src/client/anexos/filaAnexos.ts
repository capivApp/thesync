/**
 * Sobe os anexos.
 *
 * Duas regras que vêm de perder foto em campo:
 *
 * 1. **Só retenta quando não houve resposta.** Se o servidor respondeu — mesmo
 *    com erro — o arquivo pode já ter sido gravado lá. Reenviar às cegas é
 *    como se fabrica duplicata.
 * 2. **O arquivo local só é apagado depois da confirmação.** Até lá ele é a
 *    única cópia que existe.
 */
import { consomeTentativa, interrompeAFila } from '../../protocol/erros';
import type { Transporte } from '../../protocol/transporte';
import { Emissor } from '../nucleo/eventos';
import type { RegistroDeTabelas } from '../nucleo/registro';
import type { ContextoSync, DefinicaoTabela } from '../nucleo/tipos';
import { esgotouTentativas, proximaTentativaEm } from '../empurrar/backoff';
import {
    contarAnexos,
    listarAnexosProntos,
    marcarEstadoAnexo,
    registrarFalhaAnexo,
    removerAnexo,
    type Anexo,
} from '../persistencia/anexos';
import { gravarLote, lerRegistro } from '../persistencia/registros';
import type { OrcamentoDrenagem } from '../empurrar/empurrador';
import { descartarArquivo, espacoDisponivel } from './arquivos';

/** Abaixo disto o app avisa antes de a próxima foto falhar por falta de espaço. */
const ESPACO_MINIMO_BYTES = 100 * 1024 * 1024;

export interface ResultadoDrenagemAnexos {
    enviados: number;
    falhas: number;
    restantes: number;
    interrompidaPor: 'fim' | 'rede' | 'sessao' | 'orcamento';
}

export class FilaDeAnexos {
    constructor(
        private readonly registro: RegistroDeTabelas,
        private readonly transporte: Transporte,
        private readonly emissor: Emissor,
    ) { }

    private async registroDoAnexo(
        contexto: ContextoSync,
        tabela: DefinicaoTabela,
        anexo: Anexo,
    ): Promise<Record<string, unknown> | null> {
        const local = await lerRegistro<Record<string, unknown>>(contexto, tabela.nome, anexo.registroId);
        return local?.dados ?? null;
    }

    private async enviar(
        contexto: ContextoSync,
        anexo: Anexo,
    ): Promise<'enviado' | 'falhou' | 'parar-rede' | 'parar-sessao'> {
        const atual = this.transporte.entidadeAtual();
        if (atual === null || atual !== anexo.entidade) {
            await registrarFalhaAnexo(contexto, {
                id: anexo.id,
                erro: 'A sessão atual é de outra entidade.',
                contaTentativa: false,
                proximaTentativaEm: 0,
                estado: 'bloqueado',
            });
            return 'falhou';
        }

        const tabela = this.registro.obter(anexo.tabela);
        const definicao = tabela.anexos;
        if (!definicao) {
            await registrarFalhaAnexo(contexto, {
                id: anexo.id,
                erro: `Tabela "${tabela.nome}" não declara anexos.`,
                contaTentativa: false,
                proximaTentativaEm: 0,
                estado: 'bloqueado',
            });
            return 'falhou';
        }

        const registro = await this.registroDoAnexo(contexto, tabela, anexo);
        if (!registro) {
            await registrarFalhaAnexo(contexto, {
                id: anexo.id,
                erro: 'O registro do anexo não está no espelho local.',
                contaTentativa: false,
                proximaTentativaEm: 0,
                estado: 'bloqueado',
            });
            return 'falhou';
        }

        await marcarEstadoAnexo(contexto, anexo.id, 'enviando');

        try {
            const resposta = await this.transporte.enviarArquivo({
                rota: definicao.rota(registro),
                campoArquivo: definicao.campoArquivo,
                arquivo: { uri: anexo.caminho, nome: anexo.nomeArquivo, mime: anexo.mime },
                campos: {
                    ...(definicao.camposExtras?.(registro) ?? {}),
                    // Viaja junto para o servidor derivar identidade estável do
                    // anexo e não duplicar num reenvio tardio.
                    clienteChave: anexo.id,
                    ...(anexo.hash ? { clienteHash: anexo.hash } : {}),
                },
                chaveIdempotencia: anexo.id,
            });

            const atualizado = definicao.aplicarResposta?.(resposta);
            if (atualizado) {
                // A resposta do upload é um RECORTE (`{id, bem: {id, imagens}}`).
                // Gravá-la por cima apagaria nome, plaqueta e localização, e a
                // linha voltaria em branco para a tela.
                await gravarLote(contexto, tabela, [atualizado], { parcial: true });
                this.emissor.emitir('registro:alterado', {
                    tabela: tabela.nome,
                    id: anexo.registroId,
                    registro: atualizado,
                });
            }

            // Só agora: até aqui o arquivo local era a única cópia.
            await removerAnexo(contexto, anexo.id);
            descartarArquivo(anexo.caminho);
            return 'enviado';
        } catch (erro) {
            const falha = this.transporte.classificar(erro);

            // Sem resposta do servidor: seguro tentar de novo. Com resposta, o
            // arquivo pode ter sido gravado lá — não insiste às cegas.
            const podeRetentar = falha.semResposta;
            const conta = consomeTentativa(falha);
            const bloqueia = !podeRetentar || (conta && esgotouTentativas(anexo.tentativas + 1));

            await registrarFalhaAnexo(contexto, {
                id: anexo.id,
                erro: falha.mensagem,
                contaTentativa: conta,
                proximaTentativaEm: conta ? proximaTentativaEm(anexo.tentativas) : 0,
                estado: bloqueia ? 'bloqueado' : 'pendente',
            });

            if (bloqueia) {
                this.emissor.emitir('atencao', {
                    tipo: 'bloqueada',
                    detalhe: `Uma foto não pôde ser enviada: ${falha.mensagem}`,
                });
            }

            // Sessão recusada não é queda de rede: uma volta sozinha, a
            // outra exige alguém entrar de novo.
            if (!interrompeAFila(falha)) return 'falhou';
            return falha.tipo === 'autenticacao' ? 'parar-sessao' : 'parar-rede';
        }
    }

    private avisarEspaco(): void {
        const livre = espacoDisponivel();
        if (livre === null || livre > ESPACO_MINIMO_BYTES) return;
        this.emissor.emitir('atencao', {
            tipo: 'armazenamento',
            detalhe: 'O aparelho está quase sem espaço. Sincronize para liberar as fotos já enviadas.',
        });
    }

    async drenar(
        contexto: ContextoSync,
        orcamento: OrcamentoDrenagem = {},
    ): Promise<ResultadoDrenagemAnexos> {
        this.avisarEspaco();

        const limite = orcamento.limiteMs ? Date.now() + orcamento.limiteMs : Infinity;
        const prontos = await listarAnexosProntos(contexto);
        const alvo = orcamento.limiteItens ? prontos.slice(0, orcamento.limiteItens) : prontos;

        let enviados = 0;
        let falhas = 0;
        let interrompidaPor: ResultadoDrenagemAnexos['interrompidaPor'] = 'fim';

        for (const anexo of alvo) {
            if (orcamento.sinal?.aborted || Date.now() > limite) {
                interrompidaPor = 'orcamento';
                break;
            }

            const desfecho = await this.enviar(contexto, anexo);
            if (desfecho === 'enviado') enviados += 1;
            if (desfecho === 'falhou') falhas += 1;
            if (desfecho === 'parar-rede' || desfecho === 'parar-sessao') {
                interrompidaPor = desfecho === 'parar-sessao' ? 'sessao' : 'rede';
                break;
            }

            // A tela precisa poder dizer "enviando 42 de 300": em Expo Go a
            // drenagem só acontece com o app aberto, e o usuário tem que saber.
            this.emissor.emitir('fila:progresso', {
                enviadas: enviados,
                total: alvo.length,
                anexos: alvo.length - enviados,
            });
        }

        const contagem = await contarAnexos(contexto);
        return { enviados, falhas, restantes: contagem.pendentes, interrompidaPor };
    }
}

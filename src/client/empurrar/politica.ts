/**
 * O que acontece com uma pendência depois de uma falha.
 *
 * Só o que EXIGE o usuário trava: payload recusado, registro que sumiu,
 * conflito de versão. Erro do servidor (5xx) e erro desconhecido NÃO travam —
 * eles são corrigidos do lado de lá, por um deploy, e a fila precisa voltar
 * sozinha quando isso acontecer. Antes, cinco falhas de servidor viravam
 * "Falhou" para sempre, e a contagem do dia só subia se alguém achasse o botão
 * de reenviar. O backoff continua crescendo até o teto: é uma tentativa a cada
 * quinze minutos, não uma rajada.
 */
import { exigeOUsuario, type Falha } from '../../protocol/erros';

export type EstadoDaPendenciaAposFalha = 'pendente' | 'bloqueada' | 'conflito';
export type EstadoDoAnexoAposFalha = 'pendente' | 'bloqueado';

export const estadoDaPendenciaAposFalha = (falha: Falha): EstadoDaPendenciaAposFalha => {
    if (falha.tipo === 'conflito-versao') return 'conflito';
    if (exigeOUsuario(falha)) return 'bloqueada';
    return 'pendente';
};

/**
 * A foto segue a mesma regra. Reenviar depois de um 5xx era proibido por medo
 * de duplicata; hoje o servidor deriva a chave do upload do CONTEÚDO, então o
 * reenvio reescreve o mesmo objeto e a entrada repetida é ignorada.
 */
export const estadoDoAnexoAposFalha = (falha: Falha): EstadoDoAnexoAposFalha =>
    exigeOUsuario(falha) ? 'bloqueado' : 'pendente';

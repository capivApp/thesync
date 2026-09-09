import { describe, expect, it } from 'bun:test';

import type { Falha } from '../../protocol/erros';
import { estadoDoAnexoAposFalha, estadoDaPendenciaAposFalha } from './politica';

const falha = (tipo: Falha['tipo'], semResposta = false): Falha => ({ tipo, mensagem: tipo, semResposta });

describe('estadoDaPendenciaAposFalha', () => {
    it('conflito de versão vai para a tela de conflitos', () => {
        expect(estadoDaPendenciaAposFalha(falha('conflito-versao'))).toBe('conflito');
    });

    it('o que só o usuário resolve trava a pendência', () => {
        expect(estadoDaPendenciaAposFalha(falha('validacao'))).toBe('bloqueada');
        expect(estadoDaPendenciaAposFalha(falha('registro-sumiu'))).toBe('bloqueada');
    });

    it('erro do servidor NUNCA trava: o servidor pode ser corrigido, e a fila precisa voltar sozinha', () => {
        expect(estadoDaPendenciaAposFalha(falha('servidor'))).toBe('pendente');
        expect(estadoDaPendenciaAposFalha(falha('desconhecido'))).toBe('pendente');
    });

    it('rede e sessão só esperam', () => {
        expect(estadoDaPendenciaAposFalha(falha('rede', true))).toBe('pendente');
        expect(estadoDaPendenciaAposFalha(falha('autenticacao'))).toBe('pendente');
    });
});

describe('estadoDoAnexoAposFalha', () => {
    it('sem resposta, tenta de novo', () => {
        expect(estadoDoAnexoAposFalha(falha('rede', true))).toBe('pendente');
    });

    it('erro do servidor tenta de novo: a chave do upload vem do conteúdo, reenviar não duplica', () => {
        expect(estadoDoAnexoAposFalha(falha('servidor'))).toBe('pendente');
        expect(estadoDoAnexoAposFalha(falha('desconhecido'))).toBe('pendente');
    });

    it('o que só o usuário resolve trava a foto', () => {
        expect(estadoDoAnexoAposFalha(falha('validacao'))).toBe('bloqueado');
        expect(estadoDoAnexoAposFalha(falha('registro-sumiu'))).toBe('bloqueado');
    });
});

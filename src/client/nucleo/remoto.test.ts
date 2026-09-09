import { describe, expect, it } from 'bun:test';

import { isRetrocesso } from './remoto';

describe('isRetrocesso', () => {
    it('recusa registro mais antigo do que o que já está no espelho', () => {
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', '2026-09-09T09:59:00.000Z')).toBe(true);
    });

    it('aceita registro mais novo', () => {
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', '2026-09-09T10:00:01.000Z')).toBe(false);
    });

    it('aceita registro com o mesmo instante (reentrega do mesmo evento)', () => {
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', '2026-09-09T10:00:00.000Z')).toBe(false);
    });

    it('aplica quando qualquer um dos lados não sabe o instante', () => {
        expect(isRetrocesso(null, '2026-09-09T10:00:00.000Z')).toBe(false);
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', undefined)).toBe(false);
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', 'não é data')).toBe(false);
    });

    it('aceita instante numérico (epoch)', () => {
        expect(isRetrocesso('2026-09-09T10:00:00.000Z', Date.parse('2026-09-09T09:00:00.000Z'))).toBe(true);
    });
});

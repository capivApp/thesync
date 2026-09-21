/**
 * `expo-crypto` de mentira: o módulo real carrega o React Native, que não
 * existe fora do aparelho. A fila só precisa do `randomUUID`.
 */
import { mock } from 'bun:test';

mock.module('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));

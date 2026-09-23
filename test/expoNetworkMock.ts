/**
 * `expo-network` de mentira: o motor pergunta pela rede antes de drenar, e o
 * módulo real carrega o React Native. Nos testes a rede está sempre de pé.
 */
import { mock } from 'bun:test';

mock.module('expo-network', () => ({
    getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true }),
    addNetworkStateListener: () => ({ remove: () => undefined }),
}));

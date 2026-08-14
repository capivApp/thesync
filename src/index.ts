/**
 * Entrada neutra do pacote — só o contrato.
 *
 * O cliente (`@capivapp/thesync/client`) e o servidor
 * (`@capivapp/thesync/server`) são importados por suas próprias entradas,
 * porque cada um arrasta dependências que o outro não tem: um app Expo não
 * instala Express, e um backend não instala expo-sqlite.
 */
export * from './protocol/index';

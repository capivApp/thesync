/**
 * O arquivo, antes de qualquer rede.
 *
 * O seletor de imagem devolve a foto no CACHE, que o sistema apaga quando o
 * aparelho fica sem espaço — e o celular de campo vive sem espaço. Copiar para
 * o diretório de documentos é o que separa "a foto está garantida" de "a foto
 * provavelmente está lá".
 *
 * Quando a cópia falha, o arquivo do cache ainda é usado, mas a pendência fica
 * marcada como insegura. Uma perda possível anunciada é melhor do que uma perda
 * silenciosa.
 */
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

const PASTA = 'thesync-anexos';

export interface ArquivoGuardado {
    caminho: string;
    nome: string;
    bytes: number;
    /** `false` quando não foi possível tirar o arquivo do cache. */
    seguro: boolean;
}

const pasta = (): Directory => {
    const diretorio = new Directory(Paths.document, PASTA);
    diretorio.create({ intermediates: true, idempotent: true });
    return diretorio;
};

const extensaoDe = (mime: string): string => {
    const conhecidas: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/webp': '.webp',
        'image/heic': '.heic',
        'application/pdf': '.pdf',
    };
    return conhecidas[mime] ?? '';
};

/**
 * O nome sai do id do anexo, gerado ANTES da cópia. Assim um crash entre a
 * cópia e o enfileiramento deixa um arquivo rastreável, não um órfão anônimo.
 */
export const guardarArquivo = (
    idDoAnexo: string,
    uriOriginal: string,
    mime: string,
): ArquivoGuardado => {
    const nome = `${idDoAnexo}${extensaoDe(mime)}`;

    try {
        const destino = new File(pasta(), nome);
        const origem = new File(uriOriginal);
        origem.copy(destino);
        return { caminho: destino.uri, nome, bytes: destino.size ?? 0, seguro: true };
    } catch (erro) {
        console.warn('[thesync] não foi possível mover o anexo para o diretório do app:', erro);
        return { caminho: uriOriginal, nome, bytes: 0, seguro: false };
    }
};

/** Só depois da confirmação do servidor. Antes disso, é a única cópia. */
export const descartarArquivo = (caminho: string): void => {
    try {
        const arquivo = new File(caminho);
        if (!arquivo.exists) return;
        arquivo.delete();
    } catch (erro) {
        console.warn('[thesync] não foi possível apagar o anexo já enviado:', erro);
    }
};

export const novoIdDeAnexo = (): string => randomUUID();

/** Espaço livre, para avisar antes de o aparelho encher. */
export const espacoDisponivel = (): number | null => {
    try {
        return Paths.availableDiskSpace ?? null;
    } catch {
        return null;
    }
};

/** Soma dos anexos ainda no aparelho. */
export const espacoOcupado = (): number => {
    try {
        return pasta()
            .list()
            .reduce((total, item) => total + (item instanceof File ? (item.size ?? 0) : 0), 0);
    } catch {
        return 0;
    }
};

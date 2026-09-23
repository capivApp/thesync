/**
 * `expo-file-system` de mentira, só a fatia que os anexos usam.
 *
 * `arquivosNoDisco` é o disco: um teste que precisa saber se o motor apagou a
 * foto olha aqui.
 */
import { mock } from 'bun:test';

export const arquivosNoDisco = new Set<string>();

const buildUri = (partes: unknown[]): string =>
    partes.map((parte) => (typeof parte === 'string' ? parte : (parte as { uri: string }).uri)).join('/');

class File {
    readonly uri: string;
    readonly size = 0;

    constructor(...partes: unknown[]) {
        this.uri = buildUri(partes);
    }

    get exists(): boolean {
        return arquivosNoDisco.has(this.uri);
    }

    copy(destino: File): void {
        arquivosNoDisco.add(destino.uri);
    }

    delete(): void {
        arquivosNoDisco.delete(this.uri);
    }
}

class Directory {
    readonly uri: string;

    constructor(...partes: unknown[]) {
        this.uri = buildUri(partes);
    }

    create(): void {}

    list(): File[] {
        return [];
    }
}

mock.module('expo-file-system', () => ({
    File,
    Directory,
    Paths: { document: { uri: 'documentos' }, availableDiskSpace: Number.MAX_SAFE_INTEGER },
}));

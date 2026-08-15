# thesync

Motor de sincronização offline-first para aplicativos Expo com backend
Express + Prisma + PostgreSQL.

O app continua funcionando inteiro sem internet — lendo, contando, editando e
tirando fotos — e sobe tudo sozinho quando a rede volta. Nada do que o usuário
fez em campo se perde no caminho, nem vira lançamento duplicado.

```bash
bun add capivApp/thesync
# ou
npm i capivApp/thesync
```

---

## Por que existe

Já existem soluções ótimas de local-first, e nenhuma servia aqui:

| | Por que não |
|---|---|
| **ElectricSQL** | *"Electric does not do write-path sync"* — ele resolve a leitura. Nossos requisitos são todos de **escrita**. E o único modo dele com offline completo depende de PGlite, que não roda em React Native. |
| **TanStack DB + offline-transactions** | A arquitetura é a certa, e serviu de validação para esta. Mas a persistência dele no RN exige `op-sqlite` (**fora do Expo Go**) e nada nele trata upload de binário — que é a parte mais crítica de um app de campo. |
| **Prisma no React Native** | Early Access, módulo nativo, fora do Expo Go. |

O `thesync` roda em **Expo Go**: `expo-sqlite`, `expo-file-system`,
`expo-network` e `expo-crypto`, sem nenhum módulo nativo customizado.

---

## Como funciona

Uma regra, e o resto decorre dela:

```
o que a tela mostra  =  o que o servidor disse  +  o que ainda não subiu
```

- **O SQLite local é o registro durável.** Ele guarda a *verdade do servidor* —
  nunca a tela já editada.
- **A fila de saída (outbox) guarda o que o usuário fez.** Toda escrita passa
  por ela, inclusive online: um caminho de código só, a ordem das ações
  preservada, e nada se perde se o app for fechado no meio do envio.
- **A tela é a projeção das duas coisas.** Por isso a edição aparece na hora,
  sobrevive a um *force-stop*, e some da sobreposição no instante em que chega
  de verdade do servidor.

Anexos (fotos) têm fila própria: transporte diferente, custo de retry diferente
e um arquivo em disco que só pode ser apagado depois da confirmação. Eles nunca
travam a contagem atrás de um upload lento no 3G.

---

## Uso

### 1. Declare as tabelas

Uma tabela é **declarada, não programada**. A declaração diz de onde ler, para
onde escrever, como reconciliar exclusões e o que fazer quando dois aparelhos
editam a mesma coisa.

```ts
import { definirTabela, porChangeLog } from '@capivapp/thesync/client';

export const inventarioItem = definirTabela({
  nome: 'inventario_item',
  modo: 'leitura-escrita',
  chavePrimaria: 'id',

  leitura: {
    // Incremental: pede o que mudou desde o cursor, exclusões incluídas.
    // Trocar por porListaCompleta() ou viaAgregado() é uma linha — nem o
    // motor nem as telas sabem de onde o dado veio.
    estrategia: porChangeLog({
      rotaBase: '/patrimonio/api/v1/inventario-patrimonio-itens',
      filtros: (escopo) => ({ inventarioId: escopo }),
    }),
  },

  escrita: {
    atualizar: (campos, id) => ({
      metodo: 'PUT',
      rota: `/patrimonio/api/v1/inventario-patrimonio-itens/${id}`,
      corpo: campos,
    }),
  },

  conflito: 'campo-a-campo',
  descrever: (item) => `Item ${item.bem?.patrimonio_tag ?? item.id}`,
});
```

### 2. Ligue o motor

```ts
import { criarMotor } from '@capivapp/thesync/client';

export const motor = criarMotor({
  transporte: adaptadorHttp,          // sua camada HTTP, ver abaixo
  tabelas: [inventarioItem, localizacao, sublocalizacao],
});
```

### 3. Escreva pela fila, leia do espelho

```ts
// A edição vale na hora, mesmo sem rede.
await motor.enfileirar({
  tabela: 'inventario_item',
  id: item.id,
  campos: { status: 'ENCONTRADO', observacao: 'sala 12' },
});

// A foto é copiada para o diretório do app ANTES de qualquer tentativa de rede.
await motor.anexar({
  tabela: 'inventario_item',
  id: item.id,
  arquivo: { uri: foto.uri, mime: 'image/jpeg' },
});
```

### 4. Implemente o transporte

O motor não conhece o seu backend. Ele conhece uma interface:

```ts
import type { Transporte } from '@capivapp/thesync/protocol';
```

O que a sua implementação precisa fazer bem: distinguir **"não houve
resposta"** de **"o servidor recusou"**. É a partir disso que o motor decide se
gasta uma tentativa — e é o erro mais comum de fila offline. Cinco minutos de
túnel não podem queimar o limite de tentativas e fazer a tela mentir que a
contagem falhou.

### 5. Cadastro offline

```ts
// O id é decidido AQUI. Sem isso, cada registro criado sem rede ganharia um id
// provisório que precisaria ser trocado depois em toda referência enfileirada.
const { id } = await motor.criar(contexto, {
  tabela: 'localizacao',
  campos: { name: 'Almoxarifado central' },
});
```

Só funciona em tabela que declara `estrategiaId: 'id-do-cliente'` e cuja rota
de escrita aponte para o endpoint de upsert do servidor. Nas demais, quem
decide o id é o servidor e criar offline não seria seguro.

### 6. Lado servidor

```ts
import { rotasDeSync, changeLog } from '@capivapp/thesync/server';
```

Change log alimentado por trigger, idempotência durável, anexo idempotente por
hash de conteúdo e compare-and-swap por versão.

As rotas `/sync/*` são **exclusivas do app**: qualquer chamada com `Origin` ou
`Referer` é recusada, porque um `fetch` de página sempre carrega esse header
quando é cross-origin e a especificação impede o JavaScript de removê-lo. Veja
[docs/protocolo.md](docs/protocolo.md).

---

## Controle de entidade (multi-tenant)

Levado a sério em duas camadas, porque uma não substitui a outra:

- **Arquivo de banco por entidade** (`sync_<entidade>.db`) — trocar de entidade
  não mistura dados na leitura.
- **Coluna `entidade` em cada linha local**, conferida **no envio**. Sem isso,
  o cenário real acontece: alguém enfileira offline na prefeitura A, troca para
  a prefeitura B, reconecta — e a contagem de A entra em B, porque o header da
  requisição já é o de B e o servidor aceita.

---

## Documentação

| | |
|---|---|
| [docs/protocolo.md](docs/protocolo.md) | Cursor, envelopes, rotas e o change log |
| [docs/modelo-de-dados.md](docs/modelo-de-dados.md) | Tabelas locais e o ciclo de vida de uma mutação |
| [docs/conflitos.md](docs/conflitos.md) | Políticas de conflito e o que o usuário vê |
| [docs/decisoes.md](docs/decisoes.md) | Por que cada escolha, com o que foi descartado |

---

## Desenvolvimento

Instalação sempre direto do GitHub, sem registry. Para testar uma alteração num
app consumidor:

```bash
# aqui
# suba a versão em package.json, commit e push

# no app consumidor
# remova a trava do lock do @capivapp/thesync
bun pm cache rm          # ou: npm cache clean --force
bun install              # ou: npm i
```

O pacote é publicado como **TypeScript cru, sem build** — o Metro transforma
`node_modules` e resolve `.ts`; o Bun roda TS nativo. Um passo de build a menos
é um passo a menos para sair de sincronia com o fonte.

```bash
bun run typecheck
```

---

## Limitações conhecidas

- **Envio em segundo plano não está ligado.** Expo Go não roda JS headless, e a
  entrega atual mostra progresso com o app aberto. O motor já nasceu preparado:
  o drenador não depende de React nem de UI, todo o progresso vive no SQLite, e
  ele aceita um orçamento (`drenar({ limiteMs })`) do tamanho da janela de uma
  tarefa de fundo do Android. Ligar é gerar um dev build e registrar a tarefa.
- **Detecção de conflito depende do servidor.** Sem `version` na tabela, duas
  escritas simultâneas continuam em último-a-escrever-ganha. O pacote oferece o
  compare-and-swap; adotar é decisão de cada recurso.
- **Deduplicação de anexo em retry tardio não é resolvível só no cliente.**
  Precisa do lado servidor (chave derivada do conteúdo). Está em
  `@capivapp/thesync/server`.
- **`porChangeLog` exige PostgreSQL 13+** no servidor (`xid8`,
  `pg_visible_in_snapshot`). Sem ele, use `porListaCompleta` ou `viaAgregado`,
  que funcionam com qualquer backend — a troca é uma linha na declaração da
  tabela.

# Decisões de arquitetura

Cada seção registra o que foi decidido, **o que foi descartado** e por quê.
O valor está no descartado: sem ele, a próxima pessoa refaz o mesmo caminho.

---

## 1. Motor próprio em vez de solução pronta

**Descartado: ElectricSQL.** O banco até serve (é PostgreSQL), mas a
documentação é explícita:

> "Electric does not do write-path sync. It doesn't provide (or prescribe) a
> built-in solution for getting data back into Postgres from local apps and
> services."

Ele resolve o caminho de leitura. Todos os nossos requisitos são de escrita —
contagem e fotos. Dos quatro padrões de escrita que ele documenta, o único com
offline completo ("through the database") depende de PGlite, e *"PGlite doesn't
yet work in React Native"*.

Há ainda um problema de segurança: o tenant aqui é garantido por **RLS de
Postgres** (`SET LOCAL "my.company_id"`, política `entidade = current_setting(...)`
em dezenas de tabelas). O Electric lê o WAL com role própria e serve Shapes por
HTTP — o recorte por entidade viraria configuração de Shape mais um proxy de
autorização. É trocar uma garantia do banco por uma garantia de configuração.

**Descartado: TanStack DB 0.6 + `@tanstack/offline-transactions`.** A
arquitetura é a mesma que adotamos, e serviu de validação — o README dele
inclusive passa `idempotencyKey` na chamada de envio. Mas a persistência no
React Native usa `@op-engineering/op-sqlite`, que é módulo nativo e não roda em
Expo Go; nada nele trata upload multipart; e adotá-lo exigiria migrar a leitura
inteira do app de React Query para coleções TanStack DB.

**Descartado: Prisma no React Native.** Early Access, módulo nativo, fora do
Expo Go. E "sync de schema com Prisma" não se sustenta: quem aplica migration
no aparelho precisa embarcar o SQL no bundle e rodar no boot — que é o que
fazemos com `expo-sqlite` puro de qualquer jeito.

---

## 2. O watermark não é um timestamp

Esta é a decisão menos óbvia do projeto, e a que mais economiza tempo se for
lida antes de alguém "simplificar".

A ideia natural é `?updatedAt=greaterThan:<última sincronização>`. **Ela perde
linhas em silêncio**, por quatro motivos independentes:

1. **`updatedAt` é calculado no cliente Prisma**, não no banco — a coluna não
   tem `DEFAULT` no DDL. Com várias réplicas atrás do balanceador, o desvio de
   relógio entre pods faz uma linha gravada por um pod nascer com timestamp
   anterior ao watermark que o cliente recebeu de outro.
2. **Existe escrita crua com `NOW()`** na mesma tabela (o anexo de imagem). O
   `NOW()` do Postgres é o *início da transação* e é o relógio do *banco*. Duas
   fontes de tempo diferentes, uma delas retroativa, na mesma coluna.
3. **Sequências também não resolvem.** Qualquer número atribuído no `INSERT` é
   atribuído em ordem de **início**, não de **commit**.
4. **E esse é o problema de fundo.** O job que cria um inventário semeia
   milhares de itens numa transação **única** de até cinco minutos. Um cliente
   que sincroniza no minuto 1 avança o watermark para além daqueles números e
   **nunca mais vê aquelas linhas**.

**Adotado:** change log alimentado por trigger, com cursor
`(seq, xmin, snapshot)` e resgate por `pg_visible_in_snapshot`. A pergunta deixa
de ser *"o que mudou depois do instante W"* e passa a ser *"o que ficou visível
depois do snapshot S"* — a única que a MVCC responde sem furos. As linhas da
transação de cinco minutos entram no pull no exato instante do commit, por
menor que seja o `seq` delas.

Exige PostgreSQL ≥ 13 (`xid8`, `pg_current_xact_id`, `pg_visible_in_snapshot`).

---

## 3. `op` do log não é a verdade

O feed **hidrata** os ids pelo DAO do recurso e decide ali: linha ausente ou
desabilitada ⇒ `delete`; caso contrário ⇒ `upsert`.

Duas consequências boas de graça: N mudanças do mesmo registro colapsam em uma,
e o cliente nunca recebe estado intermediário — que é inútil para quem estava
offline. É também como o **tombstone** aparece sem quebrar nenhum consumidor
atual da API, que dependem do filtro implícito de "só habilitados".

---

## 4. Espelho linha-a-linha, não blob por coleção

**Descartado:** guardar o agregado inteiro num `TEXT` por coleção. Com milhares
de itens são megabytes reescritos a cada toque na tela, e diff sobre blob é
impossível.

**Descartado:** materializar uma tabela SQLite por entidade de negócio. O motor
deixaria de ser dirigido por schema (gerador de migration, mapeamento de tipos,
`ALTER` quando o servidor ganha coluna) e ganharia pouco — a tela renderiza o
registro inteiro de qualquer forma.

**Adotado:** uma tabela genérica de registros + colunas de índice **projetadas
pela declaração**. Carregar tudo e filtrar em memória é aceitável uma vez por
montagem de tela; o índice serve as consultas que não podem carregar tudo —
contadores, recortes, retomada depois de um *force-stop*.

---

## 5. Toda escrita passa pela fila, inclusive online

**Descartado:** decidir entre "manda agora" e "enfileira" conforme a
conectividade. Isso são dois caminhos de código, duas classes de bug, e a
conectividade mente (o Wi-Fi do cliente responde ao ping e não fala com a API).

**Adotado:** enfileira sempre, drena imediatamente quando dá. Um caminho só. E
uma propriedade que sai de graça: se o app morrer entre o toque do usuário e a
resposta do servidor, o registro da intenção já está em disco.

---

## 6. Uma identidade por mutação

O `id` da linha da fila **é** a chave de idempotência, gerado no enfileiramento
e reaproveitado em toda tentativa. Dois identificadores para a mesma coisa são
duas coisas para manter em sincronia, com zero benefício.

Corolário: quando o payload muda (coalescing de várias edições do mesmo
registro), a chave é **nova** — reaproveitar a antiga replicaria o payload
velho se o servidor ainda tivesse a resposta em cache.

---

## 7. Ordem por sequência, nunca por relógio

A fila ordena por `INTEGER PRIMARY KEY AUTOINCREMENT`. `Date.now()` anda para
trás quando o usuário corrige a hora ou o NTP sincroniza — e aí as ações do
usuário sobem fora de ordem. Custa nada agora e é irrecuperável depois.

Pelo mesmo motivo, o `updated_at` do espelho é sempre o do **servidor**. Relógio
de aparelho de campo desanda, e um cursor derivado dele corrompe em silêncio.

---

## 8. Um pacote com três entradas, não três pacotes

`npm i` e `bun add` por URL do GitHub instalam o **repositório**, e nenhum dos
dois resolve subdiretório de workspace. Como o protocolo precisa ser versionado
junto com as duas pontas — é a propriedade mais fácil de quebrar e a que só
falha em produção — o repositório é um só, e o `package.json` expõe
`./protocol`, `./client` e `./server`.

As dependências de cada lado são `peerDependencies` **opcionais**: o backend não
é cobrado pelas bibliotecas do Expo, e o app não é cobrado pelo Express.

---

## 9. Envio de fotos: UI agora, segundo plano depois

Expo Go não roda JS headless. A entrega mostra progresso com o app aberto.

Para que ligar o segundo plano depois **não** seja reescrita:

- o drenador não importa React, não lê store e não toca no cache de query — ele
  emite eventos, e a UI escuta;
- todo o progresso vive no SQLite, nunca em memória, para um processo que
  acorda do zero continuar de onde parou;
- os gatilhos ficam isolados: hoje ciclo de vida do app e conectividade;
  amanhã, uma tarefa de fundo chamando **o mesmo** drenador;
- o drenador aceita orçamento (`limiteMs`, `limiteBytes`), do tamanho da janela
  curta que o Android concede.

---

## 10. Anexo duplicado é problema do servidor

O middleware de idempotência do backend guarda as chaves num `Map` de memória
do processo e **apaga a chave quando a conexão morre antes da resposta** — que é
exatamente o cenário do celular em campo. Não há proteção nenhuma para um
reenvio que acontece horas depois.

No cliente dá para reduzir a janela (só retentar quando não houve resposta,
reconferir o registro antes) e eliminar o duplo-toque (hash local na captura).
Mas eliminar de verdade exige o servidor: a chave do objeto derivada do **hash
do conteúdo**, e inserção em conjunto no lugar de concatenação. Aí o reenvio
reescreve o mesmo objeto e não duplica a entrada.

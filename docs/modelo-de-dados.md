# Modelo de dados local

Um arquivo SQLite **por entidade** (`sync_<entidade>.db`), separado de qualquer
banco de sessão do app. Essa separação é deliberada: um `clear()` de sessão não
pode apagar a contagem que alguém passou o dia fazendo em campo.

Migrações por `PRAGMA user_version`, aplicadas na abertura.

---

## `registros` — o espelho

Guarda a **verdade do servidor**. Nunca a tela já editada.

```sql
CREATE TABLE registros (
  entidade    INTEGER NOT NULL,
  tabela      TEXT    NOT NULL,
  id          TEXT    NOT NULL,
  dados       TEXT    NOT NULL,   -- JSON do registro, como o servidor mandou
  updated_at  TEXT,               -- do SERVIDOR, nunca do relógio do aparelho
  origem      TEXT    NOT NULL,   -- 'servidor' | 'local'
  excluido    INTEGER NOT NULL DEFAULT 0,
  visto_em    INTEGER NOT NULL,   -- reconciliação por conjunto de ids
  baixado_em  INTEGER NOT NULL,
  PRIMARY KEY (entidade, tabela, id)
) WITHOUT ROWID;
```

Manter o espelho puro é o que torna tudo previsível: a tela é
`espelho + fila sobreposta`, e a fila é a única coisa que muda quando o usuário
toca. Se o espelho fosse contaminado com edições locais, o app perderia a
capacidade de perceber que divergiu do servidor.

## `indice_registros` — as colunas projetadas

```sql
CREATE TABLE indice_registros (
  tabela      TEXT NOT NULL,
  coluna      TEXT NOT NULL,
  id          TEXT NOT NULL,
  valor_texto TEXT,
  valor_num   REAL,
  PRIMARY KEY (tabela, coluna, id)
) WITHOUT ROWID;
```

Cada tabela declara até um punhado de colunas indexadas. Servem as consultas que
**não podem** carregar tudo: contadores, recortes por sublocalização, retomada
depois de um *force-stop*. Carregar o conjunto inteiro e filtrar em memória
continua valendo uma vez por montagem de tela.

Registro e índice são gravados na **mesma transação** — senão o índice mente.

## `sincronizacao_tabelas` — as marcas d'água

```sql
CREATE TABLE sincronizacao_tabelas (
  tabela            TEXT NOT NULL,
  escopo            TEXT NOT NULL DEFAULT '',   -- ex.: id do inventário
  cursor            TEXT,                        -- opaco, vindo do servidor
  cursor_pagina     TEXT,                        -- retomada da carga inicial
  carga_completa_em INTEGER,
  reconciliado_em   INTEGER,
  ultimo_erro       TEXT,
  PRIMARY KEY (tabela, escopo)
) WITHOUT ROWID;
```

`cursor_pagina` persistido a cada página é o que faz a carga inicial **retomar**
em vez de recomeçar quando o usuário mata o app no meio de um download de
milhares de linhas.

## `saida` — a fila de escritas

```sql
CREATE TABLE saida (
  id                   TEXT    PRIMARY KEY NOT NULL,  -- = chave de idempotência
  sequencia            INTEGER NOT NULL,              -- AUTOINCREMENT, nunca relógio
  entidade             INTEGER NOT NULL,
  tabela               TEXT    NOT NULL,
  registro_id          TEXT    NOT NULL,
  operacao             TEXT    NOT NULL,   -- criar | atualizar | remover
  payload              TEXT    NOT NULL,
  campos_alterados     TEXT    NOT NULL,   -- base do merge campo-a-campo
  base_updated_at      TEXT,               -- o que o usuário estava vendo
  depende_de           TEXT,               -- ids de outras mutações
  estado               TEXT    NOT NULL DEFAULT 'pendente',
  tentativas           INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em INTEGER NOT NULL DEFAULT 0,
  ultimo_erro          TEXT,
  ultimo_status_http   INTEGER,
  criado_em            INTEGER NOT NULL,
  atualizado_em        INTEGER NOT NULL
);
```

## `anexos` — a fila de arquivos

Separada da `saida` de propósito: transporte diferente (multipart), custo de
retry em megabytes, e um arquivo em disco que só pode ser apagado depois da
confirmação. Compartilham o escalonador, mas um upload lento no 3G **não pode**
segurar uma fila de contagens atrás dele.

```sql
CREATE TABLE anexos (
  id                   TEXT    PRIMARY KEY NOT NULL,
  entidade             INTEGER NOT NULL,
  tabela               TEXT    NOT NULL,
  registro_id          TEXT    NOT NULL,
  campo                TEXT    NOT NULL,
  caminho              TEXT    NOT NULL,   -- diretório do app, não o cache
  nome_arquivo         TEXT    NOT NULL,
  mime                 TEXT    NOT NULL,
  bytes                INTEGER NOT NULL,
  hash                 TEXT,               -- dedup na captura
  seguro               INTEGER NOT NULL DEFAULT 1,  -- 0 = ficou no cache
  estado               TEXT    NOT NULL DEFAULT 'pendente',
  tentativas           INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em INTEGER NOT NULL DEFAULT 0,
  ultimo_erro          TEXT,
  id_remoto            TEXT,
  criado_em            INTEGER NOT NULL
);
```

`caminho` aponta para o **diretório de documentos**, nunca para o cache: o
seletor de imagem devolve o arquivo no cache, que o sistema apaga quando o
aparelho fica sem espaço — e o celular de campo vive sem espaço. Quando a cópia
falha, `seguro = 0` marca o risco em vez de escondê-lo.

---

## Ciclo de vida de uma mutação

```
        toque do usuário
               │
               ▼
    ┌──────────────────────┐
    │ pendente             │  gravada em disco ANTES de qualquer rede
    └──────────┬───────────┘
               │  o drenador pega, na ordem da sequência
               ▼
    ┌──────────────────────┐
    │ enviando             │  ponto de recuperação se o app morrer agora
    └──────────┬───────────┘
               │
      ┌────────┼─────────────────────┬──────────────────────┐
      ▼        ▼                     ▼                      ▼
   sucesso   rede caiu            validação             versão velha
      │        │                     │                      │
      │        ▼                     ▼                      ▼
      │   volta a pendente       bloqueada              conflito
      │   SEM gastar tentativa   (aparece na tela)      (aparece na tela)
      ▼
  espelho atualizado, linha removida da fila,
  arquivo local apagado (se era anexo)
```

**Nenhum estado leva a "descartado" automaticamente.** Dado de campo não se joga
fora em silêncio: uma pendência que o motor não consegue mais enviar vira item
de tela, com o que ela representa em texto legível, e só o usuário decide.

### Estados

| estado | significado |
|---|---|
| `pendente` | esperando a vez ou o backoff |
| `enviando` | despachada; se o app morrer, é daqui que ela é recuperada |
| `bloqueada` | o servidor recusou por motivo que repetir não resolve |
| `conflito` | outra pessoa alterou o registro; precisa de decisão |

---

## Regras que não são negociáveis

- **Ordem por `sequencia`, nunca por relógio.** `Date.now()` anda para trás
  quando o NTP sincroniza, e aí as ações do usuário sobem fora de ordem.
- **`updated_at` é sempre o do servidor.** Relógio de aparelho de campo desanda.
- **Erro de rede não consome tentativa.** Cinco minutos de túnel não podem
  queimar o limite e fazer a tela mentir que a contagem falhou.
- **A entidade é conferida no envio.** Enfileirar na prefeitura A, trocar para a
  B e reconectar não pode mandar o dado de A para B — e mandaria, porque o
  header da requisição já seria o de B e o servidor aceitaria.
- **Sair da sessão não apaga o banco.** Apagar dado de campo no logout é a forma
  clássica de comer um dia de trabalho.
- **Gravação em lote numa transação só**, com statement preparado. Milhares de
  gravações soltas levam minutos, e o usuário mata o app no meio.

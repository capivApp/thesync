# Protocolo de sincronização

Contrato entre `@capivapp/thesync/client` e `@capivapp/thesync/server`.
Os tipos vivem em `@capivapp/thesync/protocol` e são compartilhados pelas duas
pontas — é por isso que elas moram no mesmo repositório.

---

## Cursor

Opaco para o cliente: ele guarda e devolve, nunca interpreta.

```
cursor = base64url(JSON.stringify({ v, e, s, x, p }))
```

| campo | significado |
|---|---|
| `v` | versão do formato (hoje `1`) |
| `e` | entidade dona do cursor |
| `s` | maior `seq` já consumido |
| `x` | `xmin` do snapshot em que o cursor foi emitido |
| `p` | `pg_current_snapshot()` serializado (`xmin:xmax:xip_list`) |

Duas regras que não são negociáveis:

1. **O servidor revalida `e`** contra a entidade da sessão e responde `400` se
   divergir. Opaco não é confiável — é a barreira contra alguém colar o cursor
   de outro tenant. O RLS já barra na consulta; esta é defesa em profundidade.
2. **Durante a paginação, só `s` avança.** `x` e `p` são preservados: é o
   snapshot antigo que garante o resgate das transações que ainda estavam em
   voo. Trocá-lo no meio perderia exatamente as linhas que o cursor existe para
   não perder. O cliente só persiste o cursor novo quando `hasMore` é `false`.

---

## `GET <recurso>/sync/changes?cursor=&limit=`

```jsonc
{
  "cursor": "<cursor novo>",
  "hasMore": false,
  "changes": [
    { "op": "upsert", "id": "uuid", "row": { /* projeção do sync */ } },
    { "op": "delete", "id": "uuid" }
  ]
}
```

Fluxo no servidor, dentro de uma transação em `RepeatableRead` para a paginação
ser estável:

1. Captura `pg_current_snapshot()` e seu `xmin` — uma vez, no início.
2. Se `cursor.s` for anterior à marca de poda, responde **`410 Gone`** com
   `{"code": "RESYNC_REQUIRED"}`. O cliente recarrega do zero.
3. Consulta o change log:

```sql
WHERE c.entidade = current_setting('my.company_id')::int
  AND c.tabela   = $tabela
  AND ( c.seq > $cursor_seq
     OR (c.xid >= $cursor_xmin::xid8
         AND NOT pg_visible_in_snapshot(c.xid, $cursor_snap)) )
ORDER BY c.seq
LIMIT $limit + 1
```

   O segundo ramo é o resgate: linhas de uma transação que ainda não tinha
   commitado quando o cursor foi emitido entram assim que ela commita, por menor
   que seja o `seq` delas.

4. **Hidrata pelo DAO do recurso** (`findMany({where: {id: {in: ids}}, select})`,
   sem o filtro implícito de habilitados) e decide a operação pelo **estado
   atual**, não pelo `op` gravado: ausente ou desabilitado ⇒ `delete`, senão
   ⇒ `upsert`.

A projeção do sync só pode **estreitar** o que a rota já expõe. O change log
guarda apenas `record_id` — nunca payload —, então mesmo uma falha nas camadas
anteriores vazaria um identificador, não dados.

---

## `GET <recurso>/sync/snapshot?cursor=<último id>&limit=`

Carga inicial, no padrão *snapshot + catch-up*:

1. Antes da primeira página, o cliente pede `sync/changes` com cursor vazio e
   recebe `cursor0` (só o snapshot, `changes: []`).
2. Pagina por **keyset na chave primária** (`id > :último ORDER BY id`):

```jsonc
{ "items": [ /* ... */ ], "nextId": "uuid", "hasMore": true }
```

3. Terminado o dump, roda `sync/changes` a partir de `cursor0`. O que mudou
   durante o dump é reentregue, e a gravação idempotente do cliente absorve.

Keyset e não `skip`/`take`: deslocamento sobre um conjunto sendo escrito **pula
linhas**, e o custo cresce a cada página. E não se segura transação entre
requisições HTTP — prenderia conexão do pool por minutos.

---

## Change log

```sql
CREATE TABLE public.sync_change_log (
  seq         BIGSERIAL   PRIMARY KEY,
  xid         xid8        NOT NULL DEFAULT pg_current_xact_id(),
  entidade    INT         NOT NULL,
  tabela      TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  op          CHAR(1)     NOT NULL,   -- I | U | D
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  modified_by TEXT
);

CREATE INDEX sync_change_log_pull_idx    ON sync_change_log (entidade, tabela, seq);
CREATE INDEX sync_change_log_catchup_idx ON sync_change_log (entidade, tabela, xid);
```

`clock_timestamp()` e não `now()`: `now()` é o início da transação e traria de
volta o problema que o cursor existe para resolver — ainda que aqui o campo seja
só diagnóstico.

Requer **PostgreSQL ≥ 13**.

### O trigger precisa de `SECURITY DEFINER`

```sql
CREATE FUNCTION public.sync_change_log_fn() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
```

Sem isso, o `INSERT` no log roda com a role da aplicação e passa pelo
`WITH CHECK` da política de RLS. Numa escrita em tabela **fora** do RLS — que
tem entidade global — o check falha e **a transação de negócio inteira aborta**.
Com `SECURITY DEFINER`, a escrita do log nunca falha, e a **leitura** continua
sob RLS, que é onde a proteção importa.

`SET search_path` não é opcional: `SECURITY DEFINER` sem ele é escalada de
privilégio clássica.

### Os triggers são registrados na inicialização, não só na migration

Uma migration que faz `DROP TRIGGER` em laço sobre o schema apaga triggers de
outras funcionalidades sem avisar — já aconteceu neste banco, e os triggers de
auditoria ficaram meses desligados sem ninguém notar. Os únicos que
sobreviveram foram os recriados no bootstrap.

Então: a função de registro roda no bootstrap, depois do `migrate deploy`, sobre
uma lista **explícita** de tabelas. E vale um teste de CI que verifica a
existência dos triggers em `pg_trigger` depois do bootstrap.

---

## Escrita

Toda escrita leva `x-idempotency-key` — a mesma em todas as tentativas da mesma
mutação.

O compare-and-swap é **opcional** e ativado por `If-Match: "<version>"`. Sem o
header, o comportamento é idêntico ao de hoje, o que permite que consumidores
antigos (o frontend web) continuem funcionando sem alteração. Com o header, o
servidor faz update condicional e responde **`409`** com o registro atual no
corpo, para o cliente montar a tela de conflito. A resposta de sucesso devolve
`ETag` com a nova versão.

### Idempotência durável

O registro da chave é gravado **na mesma transação** da escrita de negócio. É
por isso que é tabela e não cache externo: com cache existe a janela "commitou
no banco, perdeu no cache", que produz exatamente a duplicata que o mecanismo
deveria evitar.

| situação | resposta |
|---|---|
| chave nova | executa e grava status + corpo |
| mesma chave, mesmo dono, mesmo corpo, concluída | replay do status e do corpo |
| mesma chave, ainda em voo | `409` com `Retry-After` |
| mesma chave, corpo diferente | `422` — devolver a resposta antiga em silêncio seria o pior desfecho |
| mesma chave, dono diferente | `409` |

Retenção de 7 dias. A poda precisa rodar com escopo de tenant explícito: sob
RLS, um `DELETE` sem ele apaga **zero** linhas e o job "passa" para sempre.

---

## Anexos

`POST <rota do anexo>` em multipart. A chave do objeto no armazenamento é
derivada do **hash do conteúdo** já otimizado, e a entrada na coluna JSON é
inserida **em conjunto**, não concatenada:

- um reenvio reescreve o mesmo objeto — operação sem efeito;
- a entrada não duplica;
- e o comportamento que protege duas pessoas fotografando o mesmo bem ao mesmo
  tempo continua atômico.

É o que torna o retry tardio seguro. Nenhuma quantidade de cuidado no cliente
substitui isso.

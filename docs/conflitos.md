# Conflitos

Duas pessoas contando o mesmo bem ao mesmo tempo, cada uma no seu celular, uma
delas sem sinal há meia hora. É o caso normal de um inventário, não a exceção.

---

## O que torna a maioria dos conflitos inexistente

**Enviar só os campos que mudaram.**

Um formulário que envia o objeto inteiro no `PUT` faz quem salva por último
apagar o campo do outro — mesmo que os dois tenham mexido em coisas
diferentes. Com o diff contra o espelho, duas pessoas editando `status` e
`observacao` do mesmo item **ambas ganham**, e não há conflito nenhum para
resolver.

É por isso que `campos_alterados` existe na fila. A maior parte do trabalho de
conflito é evitá-lo.

---

## Políticas

Declaradas por tabela, porque a resposta certa depende do que o dado significa.

| política | quando usar | comportamento |
|---|---|---|
| `campo-a-campo` | o registro tem campos com donos diferentes na prática | só há conflito se os campos alterados se cruzarem |
| `servidor-vence` | o app não é a fonte da verdade daquele cadastro | a alteração local é descartada, com aviso |
| `cliente-vence` | o registro ainda é só do usuário (criado offline) | o local prevalece até existir no servidor |
| `manual` | não há resposta automática defensável | sempre vai para a tela |

Anexos não têm política: são **append-only**. Duas fotos do mesmo bem somam, não
competem.

---

## Detecção

Antes de enviar, o motor compara o `updated_at` do espelho com o
`base_updated_at` que a mutação guardou — o que o usuário estava vendo quando
tocou.

- **Iguais** ⇒ ninguém mexeu; envia.
- **Diferentes, e a política é `campo-a-campo`** ⇒ compara os campos que o
  servidor mudou com `campos_alterados`. Sem interseção, envia normalmente.
- **Diferentes com interseção**, ou política `servidor-vence` ⇒ vira `conflito`.

Isso é detecção **do lado do cliente** e tem um limite honesto: entre a checagem
e a chegada da requisição no servidor existe uma janela. Duas escritas no mesmo
instante continuam em último-a-escrever-ganha, e ninguém fica sabendo.

Fechar a janela exige o servidor: coluna `version` incrementada por trigger e
update condicional (`If-Match`). O pacote oferece; adotar é decisão de cada
recurso, e o comportamento sem o header continua idêntico ao de hoje — que é o
que permite adotar aos poucos, sem quebrar consumidores existentes.

---

## O que o usuário vê

Um conflito que só aparece num log não foi resolvido, foi escondido. Três
níveis, porque cada um pega um momento diferente:

1. **Indicador persistente** com pendentes, bloqueadas e conflitos. Não some
   sozinho, porque o problema não some sozinho.
2. **Marca no próprio item** da lista — quem está contando percebe ali, sem
   procurar.
3. **Tela de pendências**, em português de gente:

   > Você marcou **Encontrado** às 14:32.
   > Maria marcou **Não encontrado** às 14:35.
   > Ficou: **Não encontrado**.
   >
   > [ Reaplicar o meu ]  [ Manter como está ]

O texto de cada linha vem do `descrever()` da declaração da tabela. É o que
impede a tela de mostrar `inventario_item#a3f9-...` para alguém que só quer
saber de qual armário se trata.

---

## Falha permanente

Uma pendência que o servidor recusa por validação não fica tentando para sempre
— vira `bloqueada` e aparece na tela. Mas **nunca é apagada automaticamente**.

As ações disponíveis são: tentar de novo, editar e reenviar, ou descartar — e o
descartar mostra exatamente o que será perdido antes de confirmar.

Pelo mesmo motivo, sair da sessão com a fila cheia exige confirmação explícita.

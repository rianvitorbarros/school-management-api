# Mensalidades acadêmicas

`AcademicMonthlyFeePlan` é a tabela de preços do ensino regular por `school_id`,
`academicYear`, `level`, `grade` e `shift`. Não existe uma cópia para cada
turma paralela: 2º Ano A e 2º Ano B do mesmo turno leem a mesma configuração.
O turno permanece na chave porque a escola pode legitimamente cobrar valores
distintos para o mesmo ano escolar em horários diferentes.

O valor é persistido em centavos. `draftCents` é alterado pelo planejamento e
`publishedCents` só muda por publicação explícita. A rematrícula usa somente
o publicado para a série de destino da progressão e grava o preço, ano e versão
no pedido para preservar o que o responsável visualizou.

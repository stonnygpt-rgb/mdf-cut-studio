# Atualizador portátil Windows — v3.2.11

## Falha reproduzida

Na tentativa de atualizar para 3.2.10, `ultima-atualizacao.log` parou depois de
`Atualizador iniciado`, com READY gravado e sem registro de substituição.
Um teste isolado com o inicializador anterior reproduziu o sintoma: PowerShell
executou o início, mas não registrou a continuação após a saída do processo pai.
O teste não abriu nem alterou o perfil real do MDF Cut.

Também foi testado `detached:true` diretamente: neste Windows, PowerShell saiu
com código 0 sem executar o script. Portanto, mudar apenas esse sinalizador
não é a correção adotada.

## Implementação

- Electron executa um inicializador curto por `-File`, com saída em arquivo.
- O inicializador usa `ProcessStartInfo` / `UseShellExecute` para abrir um
  auxiliar oculto, com console e diretório de trabalho próprios, sem pipes
  conectados ao Electron. Caminhos são passados por variáveis de ambiente.
- O auxiliar copia o download para a pasta do EXE e confere SHA-256 **antes**
  de emitir READY. Falha de permissão, espaço ou integridade mantém o app aberto.
- Cada tentativa tem diretório e token exclusivos. Uma segunda instalação ou
  teste simultâneo é recusado no processo principal.
- Após o encerramento, `File.Replace` tenta a troca durante até 60 segundos.
  O original é preservado como `.mdfcut-previous-<token>`, sem apagar o destino
  antes da substituição. A operação requer suporte do sistema de arquivos.
- A nova execução usa a pasta do EXE como diretório de trabalho e não herda a
  localização temporária do portátil anterior.
- Só há registro de SUCESSO quando a nova versão confirma `did-finish-load`
  com o token, versão e caminho portátil esperados. O sinal fica em
  `Atualizacoes/instalacao-*/reinicio-confirmado.json`.
- Falha imediata de lançamento restaura e tenta abrir a versão anterior.
  Se houver lançamento sem confirmação em 60 segundos, o log registra
  `REINICIO NAO CONFIRMADO`; não há reversão de uma aplicação já iniciada.

O log principal continua em `%APPDATA%/MDF Cut Studio/Atualizacoes/ultima-atualizacao.log`.
Os detalhes do inicializador ficam em `instalacao-*/inicializador-saida.log`.
Downloads e executáveis anteriores são mantidos para diagnóstico/recuperação.

## Dados e interface

Permanecem os mesmos appId, productName, userData, origem `mdfcut://app`, chaves
de localStorage e formatos de OS/projeto. A única mudança no HTML é a versão.
Os testes usam perfis e EXEs pequenos criados em uma pasta temporária.
O atualizador não modifica clientes, OS, projetos, temas nem backups existentes.
O operador deve salvar a OS em edição antes de atualizar: este patch não muda
o comportamento de formulários ainda não salvos.

## Verificação reproduzível

Executar `npm test` no Windows. Não requer Electron instalado para os testes.
O teste usa Windows PowerShell 5.1 e compila dois pequenos programas .NET
temporários para exercitar a troca e a reabertura reais do arquivo.

Casos: saída do pai, confirmação de reinício, caminhos com espaços/acentos/
apóstrofo/&/colchetes, bloqueio temporário de arquivo, checksum inválido,
cancelamento, restauração após falha de lançamento, ausência de confirmação,
exclusão mútua e validação do reconhecimento da inicialização.
O checksum dos dados fictícios de OS é comparado após a instalação e a falha.
O workflow executa os testes antes de compilar/publicar o portátil.

Limites: os testes do auxiliar não substituem a validação do EXE Electron
empacotado com NSIS. O ciclo completo 3.2.11 → versão seguinte deve ser
confirmado no Windows 10/11. Não foram simulados desligamento durante a troca,
antivírus, unidade removível ou todas as políticas de execução corporativas.

## Como testar no aplicativo

1. Publicar v3.2.11 e aguardar EXE + SHA256SUMS.txt no Release.
2. Salvar a OS em edição e fazer o backup manual existente.
3. Fechar o app e substituir/abrir o portátil 3.2.11 manualmente uma vez.
   Uma atualização iniciada na versão antiga ainda executa o atualizador antigo.
4. Publicar uma versão seguinte de teste com os mesmos arquivos e só a versão
   incrementada. Não alterar o atualizador durante esse teste.
5. Na 3.2.11, usar Verificar atualizações → Baixar e instalar atualização.
6. Conferir que abriu automaticamente, mostra a nova versão e mantém as OS,
   clientes, projeto e tema. Conferir o registro SUCESSO no log.

Não considerar o botão `Testar inicializador` uma prova da troca completa:
ele continua sendo um teste sem instalação, apenas da inicialização/READY.

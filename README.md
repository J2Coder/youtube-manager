<img width="1200" height="500" alt="banner_gerenciador_youtube" src="https://github.com/user-attachments/assets/9cc3446c-da09-47e6-a793-62099e53e95f" />

# Gerenciador YouTube

Extensão para Chrome, Brave e Edge que permite gerenciar vídeos curtidos, a lista Assistir mais tarde, playlists e inscrições do YouTube.

Desenvolvido por [Jorge Wellington Gonçalves Barbosa](https://github.com/jorge-wellington).

## Funcionalidades

### Curtidos
Remove vídeos da lista "Gostei", com opções para selecionar quais vídeos serão removidos.

### Assistir mais tarde
Gerencia os vídeos salvos para assistir posteriormente.

### Playlists
Permite selecionar uma playlist da sua conta e remover vídeos dela.

### Inscrições
Lista os canais inscritos, permite pesquisar por nome e cancelar inscrições de vários canais selecionados.

## Filtros de remoção

Nas abas Curtidos, Mais tarde e Playlists, é possível escolher quais vídeos serão removidos.

- **Tudo:** remove os vídeos encontrados na lista.
- **Canal:** filtra os vídeos por canal.
- **Período:** seleciona vídeos com base na data de publicação.
- **Posição:** seleciona os primeiros ou últimos vídeos da lista.

O filtro de período utiliza a data de publicação do vídeo, não a data em que ele foi curtido ou salvo.

## Velocidade de execução

A extensão oferece quatro modos de execução:

- **Seguro:** remove um vídeo por vez, com pausas maiores.
- **Normal:** utiliza intervalos intermediários.
- **Turbo:** reduz o intervalo entre as operações.
- **MAX:** utiliza os menores intervalos configurados.

Velocidades maiores podem aumentar a probabilidade de falhas ou limitações impostas pelo YouTube. Para começar, recomenda-se utilizar o modo Seguro.

A remoção é executada na aba do YouTube. O popup pode ser fechado durante o processamento, desde que a aba utilizada permaneça aberta.

## Instalação

A instalação é feita manualmente, pelo modo de desenvolvedor do navegador.

1. Acesse este repositório e clique em `Code` e depois em `Download ZIP`.
2. Extraia o arquivo baixado.
3. Abra a página de extensões do navegador:
   - Chrome:    `chrome://extensions/`
   - Brave:     `brave://extensions/`
   - Edge:      `edge://extensions/`
4. Ative o modo do desenvolvedor.
5. Clique em `Carregar sem compactação`.
6. Selecione a pasta que contém diretamente o arquivo `manifest.json`.
7. Abra o YouTube e clique no ícone da extensão.

A extensão requer Chrome, Brave ou Edge (não testado nos demais navegadores).

Para atualizar a extensão após modificar os arquivos, acesse a página de extensões e clique em `Recarregar`.

## Estrutura do projeto

```text
icons/                 Ícones da extensão
popup/                 Interface do usuário
src/content.js         Leitura das listas e execução das operações
src/page-bridge.js     Comunicação com a página do YouTube
tests/engine.test.js   Testes do motor de processamento
manifest.json          Configuração da extensão
README.md              Documentação
```

## Permissões

A extensão utiliza as seguintes permissões e recursos do navegador:

- `activeTab` e `scripting`: permitem interagir com a aba atual após a ação do usuário.
- Content scripts no YouTube: permitem acessar os elementos necessários para gerenciar as listas.

As preferências de tema, velocidade e aba selecionada são armazenadas no `localStorage` do popup.

O projeto não utiliza telemetria nem envia dados para servidores de terceiros, conforme a implementação atual.

## Testes

O projeto inclui um teste automatizado que utiliza um ambiente simulado do YouTube.

Para executá-lo, instale o Node.js e rode:

```bash
node tests/engine.test.js
```

Os testes verificam a lógica do processamento, mas não garantem compatibilidade com todas as mudanças do YouTube.

## Limitações conhecidas

- A extensão utiliza endpoints internos do YouTube, que podem mudar sem aviso.
- O YouTube não informa quando um vídeo foi curtido. O filtro de período considera a data de publicação.
- O YouTube pode limitar operações realizadas em sequência.
- O funcionamento depende da estrutura atual das páginas e dos serviços do YouTube.

Recomenda-se testar primeiro com poucos vídeos e utilizar o modo Seguro.

## Problemas e sugestões

Se encontrar um problema:

1. Clique em `Copiar diagnóstico` no rodapé da extensão.
2. Acesse as [Issues do projeto](https://github.com/jorge-wellington/youtube-manager/issues).
3. Abra uma nova issue com a descrição do problema e as informações relevantes do diagnóstico.

Antes de compartilhar o diagnóstico, confira se ele não contém informações pessoais que você não deseja divulgar.

Nunca publique senhas, cookies ou tokens de sessão.

## Licença

Este projeto é de autoria de [Jorge Wellington Gonçalves Barbosa](https://github.com/jorge-wellington). Até que uma licença seja definida e publicada neste repositório, todos os direitos autorais são reservados.

A disponibilização pública do código não concede, por si só, autorização para copiar, modificar ou redistribuir o projeto.

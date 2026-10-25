# Limpeza de Listas do YouTube

Extensão (Manifest V3) para limpar suas listas do YouTube em poucos cliques. Feita por [J2Coder](https://github.com/J2Coder).

## O que faz

Ao clicar no ícone, o popup já abre com quatro abas:

| Aba | O que faz |
| --- | --- |
| **Curtidos** | Remove vídeos da lista "Gostei". |
| **Mais tarde** | Remove vídeos de "Assistir mais tarde". |
| **Playlists** | Remove vídeos de uma playlist sua (a aberta agora ou uma da sua conta). |
| **Inscrições** | Lista seus canais, busca por nome, mostra a contagem e cancela a inscrição nos marcados. |

Nas três primeiras abas você escolhe **o que remover**: Tudo, por Canal, por Período (publicados há mais de / nos últimos X dias, semanas, meses ou anos) ou por Posição (os N primeiros ou os N últimos da lista). A velocidade tem quatro modos: Seguro, Normal, Turbo e MAX.

A remoção roda dentro da aba do YouTube: dá para fechar o popup, minimizar o navegador ou trocar de aba, desde que a aba do YouTube continue aberta.

## Instalar para testar (sem empacotar)

1. Extraia o ZIP. Vai surgir a pasta `limpeza-youtube`.
2. Abra `chrome://extensions` (ou `brave://extensions`) e ligue o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `limpeza-youtube`.
4. Clique no ícone da extensão em qualquer página de `youtube.com`. Ela se conecta à aba automaticamente.

Ao atualizar os arquivos, clique em **Recarregar** no cartão da extensão. Ao abrir o popup, ela se conecta à aba atual; se o YouTube ainda estiver carregando, use F5 e tente novamente.

Requer Chrome/Brave/Edge 111 ou mais novo (por causa de `"world": "MAIN"` nos content scripts). Firefox não foi testado.

## Estrutura

```
manifest.json          configuração e permissões
popup/                 interface (HTML, CSS e JS)
src/content.js         motor: lê listas, remove, conferência, inscrições
src/page-bridge.js     entrega ao motor a configuração pública do YouTube (ytcfg)
icons/                 ícones
tests/engine.test.js   teste do motor contra um YouTube simulado
```

## Permissões

- `activeTab` e `scripting`: permitem conectar a extensão à aba atual do YouTube quando você clica no ícone.
- Content scripts em `youtube.com` e seus subdomínios: necessários para falar com o YouTube usando a sua sessão.

Nada é enviado para servidores de terceiros. Não há telemetria. Os únicos dados guardados (tema, velocidade e aba escolhida) ficam no `localStorage` do popup.

## Testes

```
node tests/engine.test.js
```

Usa um YouTube simulado. Confirma a lógica, mas **não** garante que o YouTube real responda no mesmo formato.

## Limitações conhecidas

- Usa endpoints internos do YouTube, que não são públicos e podem mudar sem aviso.
- O YouTube não informa **quando você curtiu**; o filtro de período usa a data de publicação do vídeo.
- Vídeos privados, apagados ou de outra pessoa podem não sair; o painel avisa quantos.
- Cancelar inscrições em massa pode ser limitado pelo YouTube. Comece com poucos canais.

## Problemas

Clique em **Copiar diagnóstico** no rodapé do popup (não inclui senhas nem dados de login) e abra uma issue em https://github.com/J2Coder com o texto copiado.

## Licença

A definir pelo autor.

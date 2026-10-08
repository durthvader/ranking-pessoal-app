import { h } from '../util.js';
import { evalSettings } from '../store.js';
import { isGuest } from '../access.js';

export function renderMethod(app, root) {
  if (isGuest(app.access)) {
    root.append(h('h1', null, 'Como funciona sua avaliação'),
      h('p', null, 'Escolha a foto que você prefere em cada dupla. Use Tela cheia para comparar com mais detalhe e Rever depois quando não quiser decidir agora.'),
      h('p', null, 'Seu ranking usa apenas suas escolhas. Ele muda conforme você avalia mais participantes; posições com poucas comparações ainda têm maior incerteza.'),
      h('p', null, 'Você pode desfazer ou corrigir suas escolhas no Histórico. O administrador mantém as participantes e as fotos do catálogo compartilhado.'));
    return;
  }
  const s = app.state ? evalSettings(app.state) : null;
  const margem = s?.freezeMargin ?? 5, maxV = s?.freezeMaxWins ?? 4; // regra de congelamento
  const m = app.engine?.model;
  const P = (...t) => h('p', null, ...t);
  const F = (t) => h('div', { class: 'formula' }, t);
  root.append(h('div', { class: 'method', style: { maxWidth: '820px' } },
    h('h1', null, 'Como o ranking é calculado'),
    P('O app estima a sua preferência visual entre as participantes cadastradas, com as fotos usadas e os votos da avaliação ativa. Só os seus votos entram no cálculo. Nomes, fama e opiniões externas ficam de fora, e o app não faz nenhuma avaliação automática de beleza.'),

    h('h2', null, '1. Modelo de Bradley–Terry'),
    P('Cada participante i tem um parâmetro s_i que representa a sua preferência estimada. A chance de você escolher i quando ela aparece com j é:'),
    F('P(i escolhida em vez de j) = 1 / (1 + exp(−(s_i − s_j)))'),
    P('Todas começam com o mesmo prior gaussiano N(0, σ²): a mesma pontuação inicial (zero) e a mesma incerteza. O app calcula a estimativa de máxima posterior com o histórico completo de votos válidos da avaliação, por Newton com gradiente conjugado, e recalcula depois de cada voto, correção ou troca de foto.'),
    P('A log-posterior é estritamente côncava. Por isso a estimativa existe, é única e é finita, inclusive para participantes só com vitórias ou só com derrotas. O modelo já considera a força das adversárias (vencer uma participante forte move mais a estimativa), então o app não usa pesos manuais extras.'),

    h('h2', null, '2. Desvio padrão do prior (σ)'),
    P(`Modo ${s?.sigmaMode === 'fixo' ? 'atual: fixo' : 'atual: automático'}. No modo automático (padrão), a partir de 300 escolhas o app escolhe o σ que maximiza a evidência aproximada dos votos (Bayes empírico com aproximação de Laplace) e refaz essa estimativa quando os votos crescem 3%. Antes de 300 escolhas, e no modo fixo, usa o valor configurado (padrão 1,5).`),
    m ? P(`σ em uso agora: ${m.sigmaUsed?.toFixed(2)}.`) : null,
    P('Nas simulações, a ordem geral quase não mudou com σ entre 0,5 e 5, e o σ automático acompanhou a dispersão real das preferências simuladas (por exemplo, 0,93 para dispersão real 0,98 com 4.000 escolhas). O σ muda a largura das faixas: com σ fixo diferente da dispersão real, a faixa de 90% cobriu entre 73% e 99% das posições reais; com σ automático, entre 90% e 92%. Com preferências muito próximas, um σ grande demais também piorou o acerto da 1ª colocada.'),

    h('h2', null, '3. Índice de preferência em escala Elo'),
    F('R_i = 1500 + (400 / ln 10) × (s_i − média(s))'),
    P('Nessa escala, a chance estimada de i vencer j é 1 / (1 + 10^((R_j − R_i)/400)). Diferença de 100 pontos: 64%; 200 pontos: 76%; 400 pontos: 91%. A média das estimativas é zero, então a média dos índices é 1500.'),

    h('h2', null, '4. Incerteza da pontuação e da posição'),
    P('O app aproxima a posterior por uma normal multivariada centrada na estimativa, com covariância igual à inversa da Hessiana (aproximação de Laplace). O ± do índice é a faixa de 90% (1,645 desvios) já centrada na média.'),
    P(`Para a posição, o app sorteia ${s?.mcSamples ?? 1000} conjuntos de pontuações de todas as participantes ao mesmo tempo, preservando as correlações entre elas, ordena cada sorteio e registra a posição de cada participante. A faixa provável de posição vai do percentil 5 ao 95. A chance de 1º lugar é a fração de sorteios em que a participante ficou em primeiro, considerando todas as participantes.`),
    P('Hipóteses: suas escolhas seguem o modelo de Bradley–Terry e são independentes entre si, dados os parâmetros. Aproximações: a posterior real é assimétrica quando há poucas comparações, e o Monte Carlo tem erro de cerca de 1,5 ponto percentual para chances perto de 50%. As chances mostradas são estimativas condicionadas ao modelo e aos votos.'),
    P('Limite medido: para as participantes que estão de fato entre as 20 primeiras, a faixa de 90% acertou a posição real em 56% a 88% dos casos com 4.000 escolhas, conforme o cenário. O prior aproxima do centro quem tem preferência extrema enquanto há poucos votos, então as líderes reais tendem a aparecer um pouco abaixo de onde estão.'),

    h('h2', null, '5. Escolha dos pares'),
    P(`Cobertura: cada participante recebe pelo menos ${s?.coverageMin ?? 6} comparações válidas contra adversárias variadas, com sorteio reproduzível (semente da avaliação + número do confronto). O sorteio junta participantes com menos comparações, evita repetir adversária e prefere ligar partes diferentes da rede de comparações, que fica conectada.`),
    P('Fase adaptativa, inspirada no sistema suíço: o app considera pares próximos na estimativa atual, algumas adversárias distantes sorteadas e todas as candidatas ao 1º lugar. Cada par recebe uma pontuação:'),
    F('pontuação = informação esperada × importância × penalidades\nimportância = 1 + wTop·(chance de 1º das duas) + wUnder·(falta de comparações) + wCross·(faixas diferentes)'),
    P('A informação esperada (BALD) mede quanto o resultado deve reduzir a incerteza sobre a diferença entre as duas. Ela é alta quando a ordem ainda é incerta e baixa quando a ordem já está clara ou quando as duas já foram muito comparadas. As penalidades reduzem pares repetidos, pares vistos há pouco e pares adiados, e a mesma participante não aparece em confrontos seguidos. O par sai de um sorteio ponderado entre os 6 melhores.'),
    P(`Pesos atuais: wTop = ${s?.wTop ?? 6}, wUnder = ${s?.wUnder ?? 1.5}, wCross = ${s?.wCross ?? 0.3}. Nas simulações, wTop = 6 acertou a 1ª colocada em 73% das execuções, contra 52% com wTop = 3, com a ordem geral praticamente igual (Spearman 0,810 contra 0,819). Os pesos de pouco avaliadas e de faixas tiveram efeito pequeno.`),
    P('Faixas (grupos high/low): a lista é dividida por posição estimada em faixas mais estreitas no topo. Elas são provisórias, mudam a cada cálculo e aparecem no chaveamento. As faixas não eliminam ninguém; a única saída dos confrontos por desempenho é o congelamento, descrito a seguir.'),
    P(s?.freezeEnabled === false ? 'Congelamento: desligado nesta avaliação.' : `Congelamento: quem chega a ${margem} derrotas a mais que vitórias, com até ${maxV} vitórias (placares como 0-${margem}, 1-${margem + 1} ou ${maxV}-${maxV + margem}, ou piores), sai dos novos confrontos. Os votos dela continuam no cálculo, então quem a venceu mantém essas vitórias, e ela segue no ranking. Uma vez congelada, não volta pelos votos seguintes; a contagem recomeça se a foto principal mudar depois do congelamento. Na própria avaliação, o dono do app também pode descongelar pela ficha da participante. A regra usa só votos já dados, então o cálculo continua válido; o custo é que a posição das congeladas deixa de ser refinada.`),

    h('h2', null, '6. Dúvidas, revisão e auditoria'),
    P('"Rever depois" registra uma abstenção: não conta como vitória, derrota ou empate e não muda pontuações. O par continua disponível, com frequência menor a cada adiamento, e as duas participantes ficam marcadas com ordem incerta.'),
    P(`Revisão do 1º lugar: os pares vêm das líderes, de quem tem 1% ou mais de chance estimada de 1º, de quem tem a posição 1 dentro da faixa provável e de participantes pouco avaliadas cuja faixa plausível alcança a líder. A etapa começa sozinha em ${Math.round((s?.reviewFrom ?? 0.75) * 100)}% do orçamento, com ${Math.round((s?.reviewShare ?? 0.5) * 100)}% dos pares vindos da revisão, e também pode ser pedida em Votar → Mais. Esses votos entram no histórico como os demais; a liderança continua calculada pelo conjunto dos votos.`),
    P('Congelamento do catálogo: o administrador pode aplicar suas congeladas a todas as contas. Elas saem dos novos confrontos, inclusive de convidados que ainda não votaram, e os votos anteriores continuam no cálculo. A troca de foto não libera esse congelamento; o administrador usa “Descongelar para todos” na ficha da participante.'),
    P('Auditoria: repete pares já vistos, separados por outros confrontos e com lados sorteados de novo. Os votos de auditoria ficam guardados à parte e medem consistência; por padrão não entram no cálculo como evidência nova.'),
    P('Sinais de mudança de preferência: concordância das auditorias (na mesma sessão e em sessões diferentes), ciclos (A > B, B > C, C > A) e sessões cujas escolhas concordam menos que o esperado com uma estimativa feita sem elas. Quando esses sinais aparecem, nenhuma ordem única reproduz todas as escolhas; o ranking mostra a ordem que melhor resume o conjunto, e as faixas de posição ficam mais largas.'),

    h('h2', null, '7. Garantias, aproximações e medições'),
    h('ul', null,
      h('li', null, 'Garantias matemáticas: estimativa única e finita; média das estimativas igual a zero; equivalência exata entre a escala Elo e o modelo; a escolha adaptativa dos pares usa só votos anteriores e não invalida a verossimilhança.'),
      h('li', null, 'Aproximações: faixas de índice e de posição, chances de 1º lugar e top 10 (Laplace + Monte Carlo); σ automático (evidência de Laplace).'),
      h('li', null, 'Medições: vêm de simulações com 500 participantes sintéticas (docs/RESULTADOS_SIMULACAO.md). Com 4.000 escolhas e a configuração padrão, a líder estimada foi a 1ª verdadeira em 50% a 92% das execuções, conforme o cenário (71% na média de seis cenários). Sem a etapa de revisão, a média foi 51%; com pares sorteados no lugar do pareamento adaptativo, 15%. A chance de 1º lugar mostrada pelo app ficou próxima da frequência observada: quando ela estava entre 80% e 95%, a líder era a 1ª verdadeira em 86% dos casos.')),
  ));
}

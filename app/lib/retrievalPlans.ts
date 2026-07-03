// Pre-computed retrieval plans for PromptBoard questions.
// Eliminates the LLM planning call (~500ms) and optionally the reranker (~300ms)
// for known questions, saving ~800ms latency and ~2k tokens per request.

export interface PrecomputedPlan {
  queries: string[];     // 3 optimized search queries
  category: string;      // "stats" | "fixtures" | "playerPerformance" | etc.
  skipRerank: boolean;   // true when category+league is tight enough
}

export const RETRIEVAL_PLANS: Map<string, PrecomputedPlan> = new Map([

  // === EPL STANDINGS & TEAM STATS ===

  ["What are the current EPL standings with points and goal difference?", {
    queries: [
      "Premier League 2025-26 standings top teams points goal difference",
      "№ Team M W D L G GA PTS xG xGA xPTS Arsenal Liverpool Manchester City",
      "EPL table positions current season standings ranking",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which EPL teams lead in xG versus actual goals scored this season?", {
    queries: [
      "Premier League 2025-26 xG versus actual goals scored overperformance",
      "№ Team M W D L G GA PTS xG xGA xPTS expected goals difference",
      "EPL teams xG actual goals gap finishing efficiency",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which EPL teams are most overperforming their xPTS this season?", {
    queries: [
      "Premier League 2025-26 teams overperforming xPTS expected points",
      "№ Team M W D L G GA PTS xG xGA xPTS points above expected",
      "EPL xPTS overperformance lucky teams standings gap",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which clubs are leading the EPL title race right now?", {
    queries: [
      "Premier League 2025-26 title race top teams standings points",
      "№ Team M W D L G GA PTS xG xGA xPTS Arsenal Liverpool Manchester City Chelsea",
      "EPL title contenders top of table current season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which EPL teams are in the relegation zone and by how much?", {
    queries: [
      "Premier League 2025-26 relegation zone bottom teams points",
      "№ Team M W D L G GA PTS xG xGA xPTS bottom three relegation",
      "EPL relegation battle survival points gap safety",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which EPL team has the best defensive record so far this season?", {
    queries: [
      "Premier League 2025-26 best defensive record fewest goals conceded",
      "№ Team M W D L G GA PTS xG xGA xPTS lowest goals against",
      "EPL defense clean sheets goals conceded ranking",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["How does the EPL top four look by xPTS compared to actual points?", {
    queries: [
      "Premier League 2025-26 top four xPTS versus actual points comparison",
      "№ Team M W D L G GA PTS xG xGA xPTS Arsenal Liverpool Manchester City Chelsea",
      "EPL top 4 expected points gap overperformance underperformance",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which EPL team has the best home record this season?", {
    queries: [
      "TEAM_FORM_HOME_5 Premier League home form 2025-26 wins points",
      "Mode: Home | Last 5 Matches Played Wins Draws Losses Points Form #league/premier-league",
      "Premier League home record standings wins goals #type/form-home",
    ],
    category: "stats",
    skipRerank: false,
  }],

  // === EPL PLAYER PERFORMANCE ===

  ["Who are the top scorers in the EPL this season?", {
    queries: [
      "Premier League 2025-26 top scorers goals leading goalscorers",
      "Player Team Apps Goals Assists xG xA Salah Haaland Isak Palmer",
      "EPL golden boot race top scorer goals this season",
    ],
    category: "playerPerformance",
    skipRerank: true,
  }],

  ["Which EPL players have the most assists this season?", {
    queries: [
      "Premier League 2025-26 most assists playmakers creators",
      "Player Team Apps Goals Assists xG xA top assists providers",
      "EPL assist leaders chances created key passes this season",
    ],
    category: "playerPerformance",
    skipRerank: true,
  }],

  ["Which EPL strikers are most outperforming their xG this season?", {
    queries: [
      "Premier League 2025-26 strikers outperforming xG goals above expected",
      "Player Team Apps Goals xG difference overperformance finishing",
      "EPL forwards xG overperformance clinical finishing this season",
    ],
    category: "playerPerformance",
    skipRerank: true,
  }],

  ["Which EPL attackers are most underperforming their xG this season?", {
    queries: [
      "Premier League 2025-26 attackers underperforming xG goals below expected",
      "Player Team Apps Goals xG difference underperformance missed chances",
      "EPL forwards xG underperformance wasteful finishing this season",
    ],
    category: "playerPerformance",
    skipRerank: true,
  }],

  ["Which EPL midfielders are creating the most chances this season?", {
    queries: [
      "Premier League 2025-26 midfielders most chances created key passes",
      "Player Team Apps Goals Assists xG xA midfield creators",
      "EPL creative midfielders chance creation playmaking this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Who leads the EPL in progressive passes this season?", {
    queries: [
      "Premier League 2025-26 progressive passes leaders ball progression",
      "Player Team progressive passes forward passing EPL",
      "EPL progressive pass leaders midfielders defenders this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which EPL players have the most shots on target this season?", {
    queries: [
      "Premier League 2025-26 most shots on target shooting accuracy",
      "Player Team Apps Goals xG shots on target shooting",
      "EPL shooting leaders shots on target accuracy this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which EPL goalkeeper has the most clean sheets this season?", {
    queries: [
      "Premier League 2025-26 goalkeeper most clean sheets shutouts",
      "Goalkeeper Team clean sheets saves goals conceded EPL",
      "EPL goalkeeper rankings clean sheets best keeper this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Who leads the EPL in successful dribbles this season?", {
    queries: [
      "Premier League 2025-26 successful dribbles take-ons ball carrying",
      "Player Team dribbles successful take-ons EPL wingers",
      "EPL dribbling leaders most successful take-ons this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which EPL players have the most yellow cards this season?", {
    queries: [
      "Premier League 2025-26 most yellow cards bookings discipline",
      "Player Team yellow cards fouls bookings discipline EPL",
      "EPL yellow card leaders most booked players this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  // === EPL FIXTURES ===

  ["What are the upcoming EPL fixtures this gameweek?", {
    queries: [
      "MATCH_FIXTURE Premier League upcoming fixture 2025-26 #league/premier-league",
      "Teams: fixture upcoming Kickoff #type/fixture Premier League Gameweek",
      "Premier League next matches schedule gameweek fixtures upcoming",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["What were the EPL results from the most recent gameweek?", {
    queries: [
      "MATCH_RESULT Premier League result Score 2025-26 #league/premier-league",
      "Teams: Score: Premier League result Gameweek #type/result",
      "Premier League latest results scores gameweek match outcomes",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["What are Arsenal's next five EPL fixtures?", {
    queries: [
      "MATCH_FIXTURE Arsenal fixture upcoming 2025-26 #team/arsenal #league/premier-league",
      "Teams: Arsenal vs fixture upcoming Premier League Kickoff",
      "Arsenal next matches opponents Premier League schedule upcoming",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["What are Manchester City's upcoming EPL fixtures?", {
    queries: [
      "MATCH_FIXTURE Manchester City fixture upcoming 2025-26 #team/manchester-city #league/premier-league",
      "Teams: Manchester City vs fixture upcoming Premier League Kickoff",
      "Man City next matches opponents Premier League schedule upcoming",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["Which EPL teams have a run of home fixtures coming up?", {
    queries: [
      "MATCH_FIXTURE Premier League fixture upcoming home 2025-26 #league/premier-league",
      "Teams: vs fixture upcoming home Premier League Gameweek #type/fixture",
      "Premier League home fixture schedule upcoming matches teams",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  // === EPL FORM & ANALYSIS ===

  ["Which EPL clubs have the toughest fixture run-in this month?", {
    queries: [
      "MATCH_FIXTURE Premier League fixture upcoming 2025-26 #league/premier-league Arsenal Liverpool Manchester City Chelsea",
      "Teams: vs fixture upcoming Premier League Gameweek big six opponents #type/fixture",
      "Premier League fixtures schedule remaining opponents tough run-in",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["Which EPL teams have the most favourable remaining fixtures?", {
    queries: [
      "MATCH_FIXTURE Premier League fixture upcoming 2025-26 #league/premier-league remaining schedule",
      "Teams: vs fixture upcoming Premier League Gameweek opponents #type/fixture",
      "Premier League upcoming fixtures remaining matches schedule opponents",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["Which EPL teams are in the best form over their last five games?", {
    queries: [
      "TEAM_FORM Premier League form 2025-26 Played Wins Points #league/premier-league",
      "Mode: Overall | Last 5 Matches Form: W Wins Draws Losses Points #type/form-overall",
      "Premier League form table last 5 matches wins points teams 2025-26",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["Which EPL teams have the worst recent form over the last five games?", {
    queries: [
      "TEAM_FORM Premier League form 2025-26 Played Losses Points #league/premier-league",
      "Mode: Overall | Last 5 Matches Form: L Wins Draws Losses Points #type/form-overall",
      "Premier League worst form last 5 matches losses poor run teams 2025-26",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["Which EPL teams have the strongest second-half scoring record?", {
    queries: [
      "Premier League second half scoring record goals after halftime 2025-26",
      "EPL teams most goals second half late goals scoring pattern",
      "Premier League second half performance goals timing teams",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["Which EPL clubs have the strongest pressing metrics this season?", {
    queries: [
      "Premier League pressing metrics PPDA high press intensity 2025-26",
      "EPL teams pressing stats tackles interceptions recoveries",
      "Premier League pressing high press aggressive teams this season",
    ],
    category: "stats",
    skipRerank: false,
  }],

  // === OTHER BIG FIVE LEAGUES (STATS) ===

  ["What are the current La Liga standings this season?", {
    queries: [
      "La Liga 2025-26 standings table teams points current season",
      "№ Team M W D L G GA PTS xG xGA xPTS Real Madrid Barcelona Atletico",
      "La Liga table positions rankings current standings",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which La Liga teams lead in xG this season?", {
    queries: [
      "La Liga 2025-26 xG expected goals leaders top teams",
      "№ Team M W D L G GA PTS xG xGA xPTS La Liga",
      "La Liga xG leaders expected goals attack efficiency this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["How do Real Madrid and Barcelona compare in La Liga this season?", {
    queries: [
      "Real Madrid Barcelona La Liga 2025-26 comparison stats head to head",
      "№ Team M W D L G GA PTS xG xGA xPTS Real Madrid Barcelona",
      "Real Madrid vs Barcelona La Liga standings comparison this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["What are the current Serie A standings this season?", {
    queries: [
      "Serie A 2025-26 standings table teams points current season",
      "№ Team M W D L G GA PTS xG xGA xPTS Inter Milan Juventus Napoli",
      "Serie A table positions rankings current standings",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which Serie A club leads in xPTS this season?", {
    queries: [
      "Serie A 2025-26 xPTS expected points leaders top clubs",
      "№ Team M W D L G GA PTS xG xGA xPTS Serie A",
      "Serie A xPTS leaders expected points overperformance this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["How do Inter Milan and Juventus compare in Serie A this season?", {
    queries: [
      "Inter Milan Juventus Serie A 2025-26 comparison stats standings",
      "№ Team M W D L G GA PTS xG xGA xPTS Inter Milan Juventus",
      "Inter vs Juventus Serie A comparison head to head this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["What are the current Bundesliga standings this season?", {
    queries: [
      "Bundesliga 2025-26 standings table teams points current season",
      "№ Team M W D L G GA PTS xG xGA xPTS Bayern Munich Dortmund Leverkusen",
      "Bundesliga table positions rankings current standings",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which Bundesliga teams have the best attack by xG this season?", {
    queries: [
      "Bundesliga 2025-26 best attack xG expected goals leaders",
      "№ Team M W D L G GA PTS xG xGA xPTS Bundesliga attack",
      "Bundesliga xG attack leaders most expected goals this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["What are the current Ligue 1 standings this season?", {
    queries: [
      "Ligue 1 2025-26 standings table teams points current season",
      "№ Team M W D L G GA PTS xG xGA xPTS PSG Monaco Marseille",
      "Ligue 1 table positions rankings current standings",
    ],
    category: "stats",
    skipRerank: true,
  }],

  ["Which Ligue 1 teams are overperforming their xPTS this season?", {
    queries: [
      "Ligue 1 2025-26 overperforming xPTS expected points above",
      "№ Team M W D L G GA PTS xG xGA xPTS Ligue 1 overperformance",
      "Ligue 1 xPTS overperformers points above expected this season",
    ],
    category: "stats",
    skipRerank: true,
  }],

  // === CHAMPIONS LEAGUE ===

  ["What are the latest Champions League results and standings?", {
    queries: [
      "MATCH_RESULT Champions League result Score 2025-26 #league/uefa-champions-league",
      "Teams: Score: Champions League UEFA result #type/result",
      "Champions League latest results scores standings current season",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["Who are the top scorers in the UEFA Champions League this season?", {
    queries: [
      "Champions League 2025-26 top scorers goals leading goalscorers UEFA",
      "Player Team Goals Assists Champions League UCL scorers",
      "UEFA Champions League golden boot top scorer this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which teams are favourites to win the Champions League this season?", {
    queries: [
      "Champions League 2025-26 Real Madrid Manchester City Arsenal Bayern Munich Liverpool",
      "№ Team M W D L G GA PTS Champions League UEFA standings",
      "Champions League strongest teams contenders favourites current season",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["What are the biggest Champions League fixtures coming up?", {
    queries: [
      "MATCH_FIXTURE Champions League fixture upcoming 2025-26 #league/uefa-champions-league",
      "Teams: vs fixture upcoming Champions League UEFA Kickoff #type/fixture",
      "Champions League upcoming fixtures matches schedule dates",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  // === AFCON & AFRICAN FOOTBALL ===

  ["What are the current AFCON group standings?", {
    queries: [
      "AFCON Africa Cup of Nations group standings table points",
      "AFCON group stage standings teams points wins draws losses",
      "Africa Cup of Nations current group tables rankings",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["What are the upcoming AFCON fixtures?", {
    queries: [
      "AFCON Africa Cup of Nations upcoming fixtures schedule matches",
      "MATCH_FIXTURE AFCON Africa Cup fixture upcoming Teams #type/fixture",
      "Africa Cup of Nations upcoming games schedule matches dates",
    ],
    category: "fixtures",
    skipRerank: false,
  }],

  ["Who were the top scorers at the last AFCON tournament?", {
    queries: [
      "AFCON top scorers goals Africa Cup of Nations tournament",
      "Africa Cup of Nations leading goalscorers golden boot",
      "AFCON top scorer goals tournament leading players",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which African national teams are in the best current form?", {
    queries: [
      "African national teams best form recent results international",
      "Africa football national teams form wins rankings FIFA",
      "Best African teams current form international results",
    ],
    category: "analysis",
    skipRerank: false,
  }],

  ["Which African players are performing best in Europe this season?", {
    queries: [
      "African players performing best Europe top leagues 2025-26",
      "Player Team Goals Assists African players EPL La Liga Serie A",
      "Best African players European leagues performance this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  // === CROSS-LEAGUE & MISC ===

  ["Compare Mohamed Salah and Erling Haaland's stats this season.", {
    queries: [
      "Mohamed Salah Erling Haaland comparison stats 2025-26 season",
      "Player Team Apps Goals Assists xG xA Salah Liverpool Haaland Manchester City",
      "Salah vs Haaland Premier League stats comparison goals assists",
    ],
    category: "playerPerformance",
    skipRerank: true,
  }],

  ["Who are the best U21 performers in the EPL this season?", {
    queries: [
      "Premier League 2025-26 best U21 young players performers under 21",
      "EPL young players U21 goals assists performances breakout",
      "Premier League best young talent under-21 performers this season",
    ],
    category: "playerPerformance",
    skipRerank: false,
  }],

  ["Which EPL team has scored the most goals from set pieces?", {
    queries: [
      "Premier League 2025-26 most goals from set pieces corners free kicks",
      "EPL set piece goals corners free kicks headed goals teams",
      "Premier League set piece scoring leaders teams this season",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["Which clubs across Europe have the highest xG per game this season?", {
    queries: [
      "European clubs highest xG per game 2025-26 big five leagues",
      "№ Team M xG xGA xPTS per game top clubs Europe",
      "Best attacking teams Europe xG per match EPL La Liga Serie A Bundesliga Ligue 1",
    ],
    category: "stats",
    skipRerank: false,
  }],

  ["What is the latest news from the EPL this week?", {
    queries: [
      "Premier League latest news this week EPL updates stories",
      "EPL news transfers injuries updates Premier League this week",
      "Premier League latest stories headlines news this week",
    ],
    category: "news",
    skipRerank: false,
  }],

  ["What are the biggest football stories in Africa this week?", {
    queries: [
      "African football latest news stories this week updates",
      "Africa football news transfers CAF AFCON stories this week",
      "Biggest African football stories headlines news this week",
    ],
    category: "news",
    skipRerank: false,
  }],
]);

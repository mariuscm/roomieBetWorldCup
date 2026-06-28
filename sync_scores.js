import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  getDocs, 
  doc, 
  writeBatch, 
  increment,
  query,
  where
} from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Load local .env if it exists
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, "utf8");
  envConfig.split("\n").forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || "";
      if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
        value = value.substring(1, value.length - 1);
      } else if (value.length > 0 && value.charAt(0) === "'" && value.charAt(value.length - 1) === "'") {
        value = value.substring(1, value.length - 1);
      }
      if (!process.env[key]) {
        process.env[key] = value.trim();
      }
    }
  });
}

// Firebase web config matching src/firebase.js
const firebaseConfig = {
  projectId: "roomiebet-2026-mcm",
  appId: "1:748284716767:web:c760bdbf996a17413e6b6a",
  storageBucket: "roomiebet-2026-mcm.firebasestorage.app",
  apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY,
  authDomain: "roomiebet-2026-mcm.firebaseapp.com",
  messagingSenderId: "748284716767"
};

if (!firebaseConfig.apiKey) {
  console.error("❌ Error: Firebase API Key is missing. Please set VITE_FIREBASE_API_KEY in your .env file or environment variables.");
  process.exit(1);
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Team mapping dictionary to normalize ESPN display names to database names (lowercase values)
const teamNameMapping = {
  "united states": "usa",
  "bosnia and herzegovina": "bosnia & herzegovina",
  "bosnia & herzegovina": "bosnia & herzegovina",
  "bosnia-herzegovina": "bosnia & herzegovina",
  "congo dr": "dr congo",
  "dr congo": "dr congo",
  "côte d'ivoire": "ivory coast",
  "cote d'ivoire": "ivory coast",
  "ivory coast": "ivory coast",
  "czechia": "czech republic",
  "czech republic": "czech republic",
  "cape verde": "cape verde",
  "cabo verde": "cape verde",
  "turkiye": "turkey"
};

const normalizeTeamName = (name) => {
  if (!name) return "";
  // Strip accents, convert to lowercase, normalize "and" to "&" and clean spacing
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\band\b/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  
  return teamNameMapping[normalized] || normalized;
};

// Team Flags mapping
const teamFlags = {
  "mexico": "🇲🇽",
  "south korea": "🇰🇷",
  "czech republic": "🇨🇿",
  "south africa": "🇿🇦",
  "canada": "🇨🇦",
  "qatar": "🇶🇦",
  "switzerland": "🇨🇭",
  "bosnia & herzegovina": "🇧🇦",
  "bosnia-herzegovina": "🇧🇦",
  "brazil": "🇧🇷",
  "haiti": "🇭🇹",
  "scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "morocco": "🇲🇦",
  "usa": "🇺🇸",
  "australia": "🇦🇺",
  "turkey": "🇹🇷",
  "paraguay": "🇵🇾",
  "germany": "🇩🇪",
  "ivory coast": "🇨🇮",
  "ecuador": "🇪🇨",
  "curacao": "🇨🇼",
  "netherlands": "🇳🇱",
  "sweden": "🇸🇪",
  "tunisia": "🇹🇳",
  "japan": "🇯🇵",
  "belgium": "🇧🇪",
  "iran": "🇮🇷",
  "new zealand": "🇳🇿",
  "egypt": "🇪🇬",
  "spain": "🇪🇸",
  "saudi arabia": "🇸🇦",
  "uruguay": "🇺🇾",
  "cape verde": "🇨🇻",
  "france": "🇫🇷",
  "iraq": "🇮🇶",
  "norway": "🇳🇴",
  "senegal": "🇸🇳",
  "argentina": "🇦🇷",
  "austria": "🇦🇹",
  "jordan": "🇯🇴",
  "algeria": "🇩🇿",
  "portugal": "🇵🇹",
  "uzbekistan": "🇺🇿",
  "colombia": "🇨🇴",
  "dr congo": "🇨🇩",
  "england": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  "ghana": "🇬🇭",
  "panama": "🇵🇦",
  "croatia": "🇭🇷"
};

// Fetch Game Summary sub-scores (90m, 120m, shootouts)
async function fetchSummaryScores(eventId, homeId, awayId) {
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary?event=${eventId}`);
    if (!res.ok) throw new Error(`Summary API failed with status ${res.status}`);
    const data = await res.json();
    const competitors = data.header?.competitions?.[0]?.competitors || [];
    
    const home = competitors.find(c => c.id === homeId);
    const away = competitors.find(c => c.id === awayId);
    
    if (!home || !away) {
      console.warn(`⚠️ Competitors not found in summary for event ${eventId}`);
      return null;
    }
    
    const parseLinescoreSum = (linescores, count) => {
      let sum = 0;
      for (let i = 0; i < count; i++) {
        if (linescores[i] && linescores[i].displayValue !== undefined) {
          sum += parseInt(linescores[i].displayValue, 10) || 0;
        }
      }
      return sum;
    };

    const homeLines = home.linescores || [];
    const awayLines = away.linescores || [];

    const homeScore90 = parseLinescoreSum(homeLines, 2);
    const awayScore90 = parseLinescoreSum(awayLines, 2);

    // Score after 120 minutes is the sum of 4 periods if extra time was played, otherwise matches the 90m score
    const homeScore120 = homeLines.length >= 4 ? parseLinescoreSum(homeLines, 4) : homeScore90;
    const awayScore120 = awayLines.length >= 4 ? parseLinescoreSum(awayLines, 4) : awayScore90;

    let shootoutWinner = null;
    let homeShootoutScore = null;
    let awayShootoutScore = null;

    if (home.shootoutScore !== undefined || away.shootoutScore !== undefined) {
      homeShootoutScore = home.shootoutScore !== undefined ? parseInt(home.shootoutScore, 10) : 0;
      awayShootoutScore = away.shootoutScore !== undefined ? parseInt(away.shootoutScore, 10) : 0;
      shootoutWinner = home.winner ? "home" : "away";
    }

    return {
      homeScore90,
      awayScore90,
      homeScore120,
      awayScore120,
      homeShootoutScore,
      awayShootoutScore,
      shootoutWinner
    };
  } catch (err) {
    console.error(`❌ Failed to fetch summary scores for event ${eventId}:`, err);
    return null;
  }
}

async function syncScores() {
  const dryRun = process.argv.includes("--commit") ? false : true;
  console.log("=========================================");
  console.log(`⚽ World Cup Score Sync (Dry-Run: ${dryRun})`);
  console.log("=========================================");

  try {
    // 1. Authenticate as admin first (required by Firestore rules to read/write matches)
    const password = process.env.ADMIN_PASSWORD || process.argv.find(arg => arg.startsWith("--password="))?.split("=")[1];
    if (!password) {
      throw new Error("Missing ADMIN_PASSWORD environment variable or --password=<value> argument. Required to read or write database.");
    }
    console.log("Authenticating as mariuscm@gmail.com...");
    await signInWithEmailAndPassword(auth, "mariuscm@gmail.com", password);
    console.log("Authenticated successfully!");

    const getESPNFormatDate = (date) => {
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      return `${yyyy}${mm}${dd}`;
    };

    // 2. Fetch ESPN live score feed
    console.log("Fetching live scores from ESPN (yesterday, today, and next 7 days)...");
    const now = new Date();
    const dates = [];
    for (let i = -1; i <= 7; i++) {
      dates.push(getESPNFormatDate(new Date(now.getTime() + i * 24 * 60 * 60 * 1000)));
    }

    const results = await Promise.all(
      dates.map(dateStr => 
        fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateStr}`)
          .then(res => {
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return res.json();
          })
          .catch(err => {
            console.error(`Failed to fetch ESPN for date ${dateStr}:`, err);
            return { events: [] };
          })
      )
    );

    const events = results.flatMap(data => data.events || []);
    if (events.length === 0) {
      console.log("No events found in ESPN feed.");
      return;
    }
    console.log(`Found ${events.length} match events across 9 days in ESPN scoreboard.`);

    // 3. Fetch matches from Firestore
    console.log("Reading matches database...");
    const matchesSnap = await getDocs(collection(db, "matches"));
    const dbMatches = matchesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const batch = writeBatch(db);
    let updateCount = 0;

    for (const event of events) {
      const competition = event.competitions && event.competitions[0];
      if (!competition) continue;

      const status = competition.status && competition.status.type;
      if (!status) continue;

      const competitors = competition.competitors || [];
      const homeCompetitor = competitors.find(c => c.homeAway === "home");
      const awayCompetitor = competitors.find(c => c.homeAway === "away");
      if (!homeCompetitor || !awayCompetitor) continue;

      const espnHomeName = normalizeTeamName(homeCompetitor.team.displayName);
      const espnAwayName = normalizeTeamName(awayCompetitor.team.displayName);
      
      // Find the corresponding database match
      const dbMatch = dbMatches.find(m => {
        if (m.espnEventId && m.espnEventId === event.id) return true;
        return normalizeTeamName(m.homeTeam) === espnHomeName && 
               normalizeTeamName(m.awayTeam) === espnAwayName;
      });

      if (!dbMatch) {
        console.log(`⚠️ Match not found in local DB: ${homeCompetitor.team.displayName} vs ${awayCompetitor.team.displayName} (Mapped: ${espnHomeName} vs ${espnAwayName})`);
        continue;
      }

      // 4. Resolve team placeholders if event ID matches but team names differ
      const realHomeTeam = homeCompetitor.team.displayName;
      const realAwayTeam = awayCompetitor.team.displayName;
      if (dbMatch.espnEventId === event.id && (dbMatch.homeTeam !== realHomeTeam || dbMatch.awayTeam !== realAwayTeam)) {
        const homeNorm = normalizeTeamName(realHomeTeam);
        const awayNorm = normalizeTeamName(realAwayTeam);
        const homeFlag = teamFlags[homeNorm] || "🏳️";
        const awayFlag = teamFlags[awayNorm] || "🏳️";

        console.log(`🔄 Resolving placeholders: ${dbMatch.homeTeam} vs ${dbMatch.awayTeam} -> ${realHomeTeam} vs ${realAwayTeam}`);

        dbMatch.homeTeam = realHomeTeam;
        dbMatch.awayTeam = realAwayTeam;
        dbMatch.homeFlag = homeFlag;
        dbMatch.awayFlag = awayFlag;

        if (!dryRun) {
          const matchRef = doc(db, "matches", dbMatch.id);
          batch.update(matchRef, {
            homeTeam: realHomeTeam,
            awayTeam: realAwayTeam,
            homeFlag: homeFlag,
            awayFlag: awayFlag
          });
        }
        updateCount++;
      }

      // Map ESPN states ('pre' -> scheduled, 'in' -> live, 'post' -> completed)
      let newStatus = "scheduled";
      if (status.state === "in") {
        newStatus = "live";
      } else if (status.state === "post" || status.completed) {
        newStatus = "completed";
      }

      // If scheduled, keep scores null (ESPN defaults scheduled score fields to 0)
      const homeScoreVal = newStatus === "scheduled" ? null : (homeCompetitor.score !== undefined ? parseInt(homeCompetitor.score) : null);
      const awayScoreVal = newStatus === "scheduled" ? null : (awayCompetitor.score !== undefined ? parseInt(awayCompetitor.score) : null);

      const statusChanged = dbMatch.status !== newStatus;
      const scoreChanged = dbMatch.homeScore !== homeScoreVal || dbMatch.awayScore !== awayScoreVal;

      if (statusChanged || scoreChanged) {
        console.log(`\n✨ Match Update Detected: ${dbMatch.homeTeam} vs ${dbMatch.awayTeam}`);
        console.log(`   [OLD] Status: ${dbMatch.status}, Score: ${dbMatch.homeScore}-${dbMatch.awayScore}`);
        console.log(`   [NEW] Status: ${newStatus}, Score: ${homeScoreVal}-${awayScoreVal}`);

        if (!dryRun) {
          const matchRef = doc(db, "matches", dbMatch.id);
          
          if (newStatus === "completed" && dbMatch.status !== "completed") {
            console.log(`   🔒 Locking scores & calculating player points for ${dbMatch.homeTeam} vs ${dbMatch.awayTeam}...`);
            
            let shootoutWinner = null;
            let homeShootoutScore = null;
            let awayShootoutScore = null;
            let homeScore90 = null;
            let awayScore90 = null;
            let homeScore120 = null;
            let awayScore120 = null;
            
            const isKnockout = dbMatch.stage === "knockout";
            
            if (isKnockout) {
              console.log(`     Fetching detailed summary scores for knockout match (event: ${dbMatch.espnEventId})...`);
              const summaryScores = await fetchSummaryScores(dbMatch.espnEventId || event.id, homeCompetitor.id, awayCompetitor.id);
              if (summaryScores) {
                homeScore90 = summaryScores.homeScore90;
                awayScore90 = summaryScores.awayScore90;
                homeScore120 = summaryScores.homeScore120;
                awayScore120 = summaryScores.awayScore120;
                homeShootoutScore = summaryScores.homeShootoutScore;
                awayShootoutScore = summaryScores.awayShootoutScore;
                shootoutWinner = summaryScores.shootoutWinner;
                console.log(`     Summary: 90': ${homeScore90}-${awayScore90} | 120': ${homeScore120}-${awayScore120} | Pens: ${shootoutWinner} (${homeShootoutScore}-${awayShootoutScore})`);
              } else {
                console.warn(`     Summary fetch failed. Fallback: assuming match completed in 90m.`);
                homeScore90 = homeScoreVal;
                awayScore90 = awayScoreVal;
                homeScore120 = homeScoreVal;
                awayScore120 = awayScoreVal;
              }
            }

            const matchUpdate = {
              status: "completed",
              homeScore: homeScoreVal,
              awayScore: awayScoreVal
            };
            
            if (isKnockout) {
              matchUpdate.homeScore90 = homeScore90;
              matchUpdate.awayScore90 = awayScore90;
              matchUpdate.homeScore120 = homeScore120;
              matchUpdate.awayScore120 = awayScore120;
              matchUpdate.homeShootoutScore = homeShootoutScore;
              matchUpdate.awayShootoutScore = awayShootoutScore;
              matchUpdate.shootoutWinner = shootoutWinner;
            }
            
            batch.update(matchRef, matchUpdate);

            // Fetch and evaluate guesses
            const guessesQuery = query(collection(db, "guesses"), where("matchId", "==", dbMatch.id));
            const guessesSnap = await getDocs(guessesQuery);
            
            console.log(`   👥 Evaluating ${guessesSnap.docs.length} user predictions...`);
            for (const guessDoc of guessesSnap.docs) {
              const guessData = guessDoc.data();
              let pointsEarned = 0;

              if (isKnockout) {
                // Knockout Scoring Logic
                const homeGuess90 = guessData.homeGuess90 !== undefined ? guessData.homeGuess90 : guessData.homeGuess;
                const awayGuess90 = guessData.awayGuess90 !== undefined ? guessData.awayGuess90 : guessData.awayGuess;
                const homeGuess120 = guessData.homeGuess120 !== undefined ? guessData.homeGuess120 : homeGuess90;
                const awayGuess120 = guessData.awayGuess120 !== undefined ? guessData.awayGuess120 : awayGuess90;
                const shootoutWinnerGuess = guessData.shootoutWinnerGuess || null;
                const homeShootoutGuess = guessData.homeShootoutGuess !== undefined ? guessData.homeShootoutGuess : null;
                const awayShootoutGuess = guessData.awayShootoutGuess !== undefined ? guessData.awayShootoutGuess : null;

                const isCorrect90 = homeGuess90 === homeScore90 && awayGuess90 === awayScore90;
                const isDraw90 = homeScore90 === awayScore90;
                const isGuessDraw90 = homeGuess90 === awayGuess90;

                const isCorrect120 = isDraw90 && isGuessDraw90 && (homeGuess120 === homeScore120 && awayGuess120 === awayScore120);
                const isDraw120 = isDraw90 && (homeScore120 === awayScore120);
                const isGuessDraw120 = isGuessDraw90 && (homeGuess120 === awayGuess120);

                const isCorrectWinner = isDraw120 && isGuessDraw120 && (shootoutWinnerGuess === shootoutWinner);
                const isCorrectShootoutScore = isDraw120 && isGuessDraw120 && 
                                              (homeShootoutGuess === homeShootoutScore && awayShootoutGuess === awayShootoutScore);

                if (isCorrect90) pointsEarned += 1.0;
                if (isCorrect120) pointsEarned += 1.0;
                if (isCorrectWinner) pointsEarned += 0.5;
                if (isCorrectShootoutScore) pointsEarned += 1.5;

                console.log(`     User ${guessData.userId}: Guess90: ${homeGuess90}-${awayGuess90} (${isCorrect90 ? '✔' : '❌'}), Guess120: ${homeGuess120}-${awayGuess120} (${isCorrect120 ? '✔' : '❌'}), PenWinner: ${shootoutWinnerGuess} (${isCorrectWinner ? '✔' : '❌'}), PenScore: ${homeShootoutGuess}-${awayShootoutGuess} (${isCorrectShootoutScore ? '✔' : '❌'}) => +${pointsEarned} pts`);
              } else {
                // Group Stage Logic (Standard)
                const isCorrect = guessData.homeGuess === homeScoreVal && guessData.awayGuess === awayScoreVal;
                pointsEarned = isCorrect ? 1 : 0;
                console.log(`     User ${guessData.userId}: Guess: ${guessData.homeGuess}-${guessData.awayGuess} (${isCorrect ? '✔' : '❌'}) => +${pointsEarned} pts`);
              }

              batch.update(doc(db, "guesses", guessDoc.id), { pointsEarned });

              if (pointsEarned > 0) {
                const userRef = doc(db, "users", guessData.userId);
                const pointsUpdate = {
                  points: increment(pointsEarned)
                };
                if (isKnockout) {
                  pointsUpdate.knockoutPoints = increment(pointsEarned);
                } else {
                  pointsUpdate.groupPoints = increment(pointsEarned);
                }
                batch.update(userRef, pointsUpdate);
              }
            }
          } else {
            // Live or scheduled updates (no points locking needed yet)
            batch.update(matchRef, {
              status: newStatus,
              homeScore: homeScoreVal,
              awayScore: awayScoreVal
            });
          }
        }
        updateCount++;
      }
    }

    if (updateCount > 0 && !dryRun) {
      console.log(`\nCommitting ${updateCount} matches to database...`);
      await batch.commit();
      console.log("✔ Score sync database updates completed!");
    } else {
      console.log(`\nNo commits executed. Total updates detected: ${updateCount}`);
    }
  } catch (err) {
    console.error("❌ Sync Error:", err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

syncScores();

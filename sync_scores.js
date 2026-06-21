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

// Firebase web config matching src/firebase.js
const firebaseConfig = {
  projectId: "roomiebet-2026-mcm",
  appId: "1:748284716767:web:c760bdbf996a17413e6b6a",
  storageBucket: "roomiebet-2026-mcm.firebasestorage.app",
  apiKey: "AIzaSyBfzmfZvpA09gyXBcAg0mbmNwSqy4s6IAA",
  authDomain: "roomiebet-2026-mcm.firebaseapp.com",
  messagingSenderId: "748284716767"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Team mapping dictionary to normalize ESPN display names to database names (lowercase values)
const teamNameMapping = {
  "united states": "usa",
  "bosnia and herzegovina": "bosnia & herzegovina",
  "bosnia & herzegovina": "bosnia & herzegovina",
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

    // 2. Fetch ESPN live score feed
    console.log("Fetching live scores from ESPN...");
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard");
    if (!res.ok) throw new Error(`ESPN API returned status ${res.status}`);
    const data = await res.json();
    
    const events = data.events || [];
    if (events.length === 0) {
      console.log("No events found in ESPN feed.");
      return;
    }
    console.log(`Found ${events.length} match events in ESPN scoreboard.`);

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
        return normalizeTeamName(m.homeTeam) === espnHomeName && 
               normalizeTeamName(m.awayTeam) === espnAwayName;
      });

      if (!dbMatch) {
        console.log(`⚠️ Match not found in local DB: ${homeCompetitor.team.displayName} vs ${awayCompetitor.team.displayName} (Mapped: ${espnHomeName} vs ${espnAwayName})`);
        continue;
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
            // Lock score and update points for correct guesses
            console.log(`   🔒 Locking scores & calculating player points for ${dbMatch.homeTeam} vs ${dbMatch.awayTeam}...`);
            batch.update(matchRef, {
              status: "completed",
              homeScore: homeScoreVal,
              awayScore: awayScoreVal
            });

            const guessesQuery = query(collection(db, "guesses"), where("matchId", "==", dbMatch.id));
            const guessesSnap = await getDocs(guessesQuery);
            
            console.log(`   👥 Evaluating ${guessesSnap.docs.length} user predictions...`);
            for (const guessDoc of guessesSnap.docs) {
              const guessData = guessDoc.data();
              const isCorrect = guessData.homeGuess === homeScoreVal && guessData.awayGuess === awayScoreVal;
              const pointsEarned = isCorrect ? 1 : 0;

              batch.update(doc(db, "guesses", guessDoc.id), { pointsEarned });

              if (isCorrect) {
                console.log(`     🎉 Point earned by User: ${guessData.userId}`);
                batch.update(doc(db, "users", guessData.userId), {
                  points: increment(1)
                });
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

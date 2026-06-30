<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { version } from '../package.json'
import changelog from '../changelog.json'
import { auth, db } from './firebase'
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail
} from 'firebase/auth'
import { 
  collection, 
  doc, 
  addDoc,
  setDoc, 
  getDoc,
  getDocs,
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  updateDoc, 
  deleteDoc,
  writeBatch,
  increment,
  Timestamp
} from 'firebase/firestore'

// App State
const user = ref(null)
const userProfile = ref(null)
const matches = ref([])
const allGuesses = ref([])
const expandedMatches = ref({})
const predictionInputs = ref({})
const leaderboard = ref([])
const leaderboardFilter = ref('overall') // 'overall' | 'group' | 'knockout'
const knockoutStageEnabled = ref(false)
const showGroupMatchesHistory = ref(false)
let settingsUnsub = null
const collapsedDays = ref({})
const hasScrolledToCurrent = ref(false)
const activeTab = ref('matches') // 'matches' | 'leaderboard' | 'admin'
const activeAdminSubTab = ref('users') // 'users' | 'scores' | 'setup'

const showUserMenu = ref(false)
const userMenuRef = ref(null)
const scoringRulesDialogRef = ref(null)
const versionHistoryDialogRef = ref(null)
const dontShowRulesAgain = ref(localStorage.getItem('dontShowKnockoutRulesAgain') === 'true')

const formattedChangelog = computed(() => {
  return changelog.map(item => {
    const isHeader = item.startsWith('--- ')
    const text = isHeader ? item.replace(/---/g, '').trim() : item
    return { isHeader, text }
  })
})

const showVersionHistory = () => {
  versionHistoryDialogRef.value?.showModal()
}

const closeVersionHistory = () => {
  versionHistoryDialogRef.value?.close()
}

const handleShowVersionHistoryClick = () => {
  showUserMenu.value = false
  showVersionHistory()
}

const handleVersionHistoryBackdropClick = (event) => {
  const dialog = versionHistoryDialogRef.value
  if (event.target !== dialog) return
  const rect = dialog.getBoundingClientRect()
  const isDialogContent = (
    rect.top <= event.clientY &&
    event.clientY <= rect.top + rect.height &&
    rect.left <= event.clientX &&
    event.clientX <= rect.left + rect.width
  )
  if (!isDialogContent) {
    dialog.close()
  }
}

const showScoringRules = () => {
  dontShowRulesAgain.value = localStorage.getItem('dontShowKnockoutRulesAgain') === 'true'
  scoringRulesDialogRef.value?.showModal()
}

const closeScoringRules = () => {
  if (dontShowRulesAgain.value) {
    localStorage.setItem('dontShowKnockoutRulesAgain', 'true')
  } else {
    localStorage.removeItem('dontShowKnockoutRulesAgain')
  }
  scoringRulesDialogRef.value?.close()
}

const handleShowScoringRulesClick = () => {
  showUserMenu.value = false
  showScoringRules()
}

const handleDialogBackdropClick = (event) => {
  const dialog = scoringRulesDialogRef.value
  if (event.target !== dialog) return
  const rect = dialog.getBoundingClientRect()
  const isDialogContent = (
    rect.top <= event.clientY &&
    event.clientY <= rect.top + rect.height &&
    rect.left <= event.clientX &&
    event.clientX <= rect.left + rect.width
  )
  if (!isDialogContent) {
    if (dontShowRulesAgain.value) {
      localStorage.setItem('dontShowKnockoutRulesAgain', 'true')
    } else {
      localStorage.removeItem('dontShowKnockoutRulesAgain')
    }
    dialog.close()
  }
}

const toggleUserMenu = (event) => {
  event.stopPropagation()
  showUserMenu.value = !showUserMenu.value
}

const closeUserMenu = () => {
  showUserMenu.value = false
}


// Simulation State (strictly client-side for localhost testing)
const isSimulating = ref(false)
const simulatedMatchId = ref(null)
const simulatedHomeScore = ref(null)
const simulatedAwayScore = ref(null)
const simulatedStatus = ref(null)
const simulatorIntervalId = ref(null)
const simulatorMessage = ref('')
const isLocalhost = computed(() => typeof window !== 'undefined' && window.location.hostname === 'localhost')

// ESPN live scores state & polling
const espnLiveScores = ref({})
let espnPollIntervalId = null
let hasFetchedLiveScoresInitial = false

// Version checking state
const showUpdateBanner = ref(false)
const remoteVersion = ref('')
const showChangelog = ref(false)
const remoteChangelog = ref([])
const latestRemoteChangelog = computed(() => {
  if (!remoteChangelog.value || remoteChangelog.value.length === 0) return []
  const latest = []
  let headerCount = 0
  for (const item of remoteChangelog.value) {
    if (item.startsWith('--- ')) {
      headerCount++
      if (headerCount > 1) break
      continue // Skip the header line itself inside the toast for a cleaner bullet points list
    }
    if (headerCount === 1) {
      latest.push(item)
    }
  }
  return latest.length > 0 ? latest : remoteChangelog.value
})
let versionCheckIntervalId = null

let lastVersionCheckTime = 0

async function checkAppVersion() {
  const now = Date.now()
  // Throttle to at most once every 30 seconds to avoid server spam
  if (now - lastVersionCheckTime < 30000) return
  lastVersionCheckTime = now

  try {
    const response = await fetch(`/version.json?t=${now}`)
    if (response.ok) {
      const data = await response.json()
      if (data.version) {
        remoteVersion.value = data.version
        remoteChangelog.value = data.changelog || []
        if (data.version !== version) {
          showUpdateBanner.value = true
        } else {
          showUpdateBanner.value = false
        }
      }
    }
  } catch (error) {
    console.debug('App version check skipped or failed:', error)
  }
}

const handleActivity = () => {
  checkAppVersion()
}

function triggerReload() {
  window.location.reload()
}

const clientTeamNameMapping = {
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
  "turkiye": "turkey",
  "türkiye": "turkey"
}

const normalizeNameForClient = (name) => {
  if (!name) return ""
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\band\b/g, "&")
    .trim()
}

const getNormalizedTeamName = (name) => {
  const norm = normalizeNameForClient(name)
  return clientTeamNameMapping[norm] || norm
}

const getESPNFormatDate = (date) => {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

const fetchESPNLiveScores = async () => {
  try {
    const now = new Date()
    const dates = [
      getESPNFormatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000)), // yesterday
      getESPNFormatDate(now),                                          // today
      getESPNFormatDate(new Date(now.getTime() + 24 * 60 * 60 * 1000))  // tomorrow
    ]
    
    const results = await Promise.all(
      dates.map(dateStr => 
        fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${dateStr}`)
          .then(res => {
            if (!res.ok) throw new Error(`Status ${res.status}`)
            return res.json()
          })
          .catch(err => {
            console.error(`Failed to fetch ESPN for date ${dateStr}:`, err)
            return { events: [] }
          })
      )
    )
    
    const events = results.flatMap(data => data.events || [])
    const newLiveScores = {}
    
    events.forEach(event => {
      const competition = event.competitions?.[0]
      if (!competition) return
      
      const homeCompetitor = competition.competitors?.find(c => c.homeAway === "home")
      const awayCompetitor = competition.competitors?.find(c => c.homeAway === "away")
      if (!homeCompetitor || !awayCompetitor) return
      
      const espnHomeTeam = homeCompetitor.team?.displayName
      const espnAwayTeam = awayCompetitor.team?.displayName
      
      const homeNorm = getNormalizedTeamName(espnHomeTeam)
      const awayNorm = getNormalizedTeamName(espnAwayTeam)
      
      const matchedLocalMatch = matches.value.find(m => {
        if (m.espnEventId && m.espnEventId === event.id) {
          return true
        }
        const localHomeNorm = getNormalizedTeamName(m.homeTeam)
        const localAwayNorm = getNormalizedTeamName(m.awayTeam)
        return localHomeNorm === homeNorm && localAwayNorm === awayNorm
      })
      
      if (matchedLocalMatch) {
        const rawStatus = event.status?.type?.state // 'pre' | 'in' | 'post'
        let mappedStatus = 'scheduled'
        if (rawStatus === 'in') {
          mappedStatus = 'live'
        } else if (rawStatus === 'post') {
          mappedStatus = 'completed'
        }
        
        const homeScore = homeCompetitor.score !== undefined ? Number(homeCompetitor.score) : null
        const awayScore = awayCompetitor.score !== undefined ? Number(awayCompetitor.score) : null
        
        if (mappedStatus !== 'scheduled') {
          newLiveScores[matchedLocalMatch.id] = {
            homeScore,
            awayScore,
            status: mappedStatus
          }
        }
      }
    })
    
    espnLiveScores.value = newLiveScores
  } catch (err) {
    console.error("ESPN live score client-side fetch failed: ", err)
  }
}

const processedMatches = computed(() => {
  let baseMatches = matches.value
  
  if (isSimulating.value && simulatedMatchId.value) {
    baseMatches = matches.value.map(match => {
      if (match.id === simulatedMatchId.value) {
        return {
          ...match,
          homeScore: simulatedHomeScore.value,
          awayScore: simulatedAwayScore.value,
          status: simulatedStatus.value
        }
      }
      return match
    })
  }
  
  return baseMatches.map(match => {
    const liveUpdate = espnLiveScores.value[match.id]
    if (liveUpdate && match.status !== 'completed') {
      return {
        ...match,
        homeScore: liveUpdate.homeScore,
        awayScore: liveUpdate.awayScore,
        status: liveUpdate.status
      }
    }
    return match
  })
})

const isAdminUser = computed(() => {
  return user.value && user.value.email === 'mariuscm@gmail.com'
})

const visibleMatches = computed(() => {
  if (knockoutStageEnabled.value) {
    if (showGroupMatchesHistory.value) {
      return processedMatches.value
    }
    return processedMatches.value.filter(m => m.stage === 'knockout')
  }
  return processedMatches.value.filter(m => m.stage !== 'knockout')
})

const pendingCompletedMatches = computed(() => {
  const list = []
  processedMatches.value.forEach(pm => {
    const dbMatch = matches.value.find(m => m.id === pm.id)
    if (pm.status === 'completed' && dbMatch && dbMatch.status !== 'completed') {
      list.push(pm)
    }
  })
  return list
})

const getPendingPointsForUser = (userId) => {
  let extraPoints = 0
  pendingCompletedMatches.value.forEach(match => {
    const guess = allGuesses.value.find(g => g.matchId === match.id && g.userId === userId)
    if (guess && guess.homeGuess !== null && guess.awayGuess !== null) {
      const isCorrect = Number(guess.homeGuess) === Number(match.homeScore) && 
                        Number(guess.awayGuess) === Number(match.awayScore)
      if (isCorrect) {
        extraPoints++
      }
    }
  })
  return extraPoints
}

const processedUserProfile = computed(() => {
  if (!userProfile.value) return null
  let extra = getPendingPointsForUser(userProfile.value.uid)
  
  if (isSimulating.value && simulatedMatchId.value && simulatedStatus.value === 'completed') {
    const guess = userGuesses.value[simulatedMatchId.value]
    const isCorrect = guess && Number(guess.homeGuess) === Number(simulatedHomeScore.value) && Number(guess.awayGuess) === Number(simulatedAwayScore.value)
    if (isCorrect) {
      extra += 1
    }
  }
  
  return {
    ...userProfile.value,
    points: (userProfile.value.points || 0) + extra
  }
})

const processedLeaderboard = computed(() => {
  const activePlayers = leaderboard.value.filter(player => player.disabled !== true && player.status !== 'disabled')
  const mapped = activePlayers.map(player => {
    let pendingGroup = 0
    let pendingKnockout = 0
    
    pendingCompletedMatches.value.forEach(match => {
      if (match.stage === 'knockout') {
        // Skip client-side calculation for knockout matches to avoid incorrect/incomplete points
        return
      }
      const guess = allGuesses.value.find(g => g.matchId === match.id && g.userId === player.uid)
      if (guess && guess.homeGuess !== null && guess.awayGuess !== null) {
        const isCorrect = Number(guess.homeGuess) === Number(match.homeScore) && 
                          Number(guess.awayGuess) === Number(match.awayScore)
        if (isCorrect) {
          pendingGroup += 1
        }
      }
    })

    let simGroup = 0
    let simKnockout = 0
    if (isSimulating.value && simulatedMatchId.value && simulatedStatus.value === 'completed') {
      const match = matches.value.find(m => m.id === simulatedMatchId.value)
      const guess = allGuesses.value.find(g => g.matchId === simulatedMatchId.value && g.userId === player.uid)
      const isCorrect = guess && Number(guess.homeGuess) === Number(simulatedHomeScore.value) && Number(guess.awayGuess) === Number(simulatedAwayScore.value)
      if (isCorrect) {
        if (match && match.stage === 'knockout') {
          simKnockout += 1
        } else {
          simGroup += 1
        }
      }
    }

    const groupPts = (player.groupPoints !== undefined ? player.groupPoints : (player.points || 0)) + pendingGroup + simGroup
    const knockoutPts = (player.knockoutPoints !== undefined ? player.knockoutPoints : 0) + pendingKnockout + simKnockout
    const overallPts = (player.points || 0) + pendingGroup + pendingKnockout + simGroup + simKnockout

    return {
      ...player,
      groupPointsDisplay: groupPts,
      knockoutPointsDisplay: knockoutPts,
      pointsDisplay: overallPts
    }
  })
  
  if (leaderboardFilter.value === 'group') {
    return [...mapped].sort((a, b) => b.groupPointsDisplay - a.groupPointsDisplay)
  } else if (leaderboardFilter.value === 'knockout') {
    return [...mapped].sort((a, b) => b.knockoutPointsDisplay - a.knockoutPointsDisplay)
  } else {
    return [...mapped].sort((a, b) => b.pointsDisplay - a.pointsDisplay)
  }
})

const startSimulation = () => {
  if (isSimulating.value) return
  
  const upcomingMatch = matches.value.find(m => m.status === 'scheduled')
  if (!upcomingMatch) {
    simulatorMessage.value = 'No scheduled matches found to simulate.'
    return
  }
  
  isSimulating.value = true
  simulatedMatchId.value = upcomingMatch.id
  simulatedHomeScore.value = 0
  simulatedAwayScore.value = 0
  simulatedStatus.value = 'live'
  simulatorMessage.value = `Live: ${upcomingMatch.homeTeam} 0 - 0 ${upcomingMatch.awayTeam}`
  
  let step = 0
  simulatorIntervalId.value = setInterval(() => {
    step++
    if (step === 1) {
      simulatedHomeScore.value = 1
      simulatorMessage.value = `Goal! ${upcomingMatch.homeTeam} scores! (1 - 0)`
    } else if (step === 2) {
      simulatedAwayScore.value = 1
      simulatorMessage.value = `Goal! ${upcomingMatch.awayTeam} responds! (1 - 1)`
    } else if (step === 3) {
      simulatedHomeScore.value = 2
      simulatorMessage.value = `Goal! ${upcomingMatch.homeTeam} scores again! (2 - 1)`
    } else if (step === 4) {
      simulatedStatus.value = 'completed'
      simulatorMessage.value = `FT: ${upcomingMatch.homeTeam} 2 - 1 ${upcomingMatch.awayTeam} (Simulation complete)`
    } else if (step >= 5) {
      clearInterval(simulatorIntervalId.value)
      simulatorIntervalId.value = null
    }
  }, 5000)
}

const stopSimulation = () => {
  if (simulatorIntervalId.value) {
    clearInterval(simulatorIntervalId.value)
    simulatorIntervalId.value = null
  }
  isSimulating.value = false
  simulatedMatchId.value = null
  simulatedHomeScore.value = null
  simulatedAwayScore.value = null
  simulatedStatus.value = null
  simulatorMessage.value = 'Simulation stopped.'
}

const userGuesses = computed(() => {
  const guessesObj = {}
  matches.value.forEach(match => {
    guessesObj[match.id] = { homeGuess: null, awayGuess: null, pointsEarned: null }
  })
  allGuesses.value.forEach(guess => {
    if (guess.userId === user.value?.uid) {
      guessesObj[guess.matchId] = { ...guess }
    }
  })
  
  // Dynamic client-side score evaluation for completed matches
  processedMatches.value.forEach(match => {
    if (match.status === 'completed') {
      const guess = guessesObj[match.id]
      if (guess && guess.homeGuess !== null && guess.awayGuess !== null && guess.pointsEarned === null) {
        if (match.stage === 'knockout') {
          // Skip client-side calculation for knockout matches to avoid incorrect/incomplete points
          return
        } else {
          const isCorrect = Number(guess.homeGuess) === Number(match.homeScore) && 
                            Number(guess.awayGuess) === Number(match.awayScore)
          guess.pointsEarned = isCorrect ? 1 : 0
        }
      }
    }
  })
  
  if (isSimulating.value && simulatedMatchId.value && simulatedStatus.value === 'completed') {
    const guess = guessesObj[simulatedMatchId.value]
    if (guess && guess.homeGuess !== null && guess.awayGuess !== null) {
      const isCorrect = Number(guess.homeGuess) === Number(simulatedHomeScore.value) && Number(guess.awayGuess) === Number(simulatedAwayScore.value)
      guessesObj[simulatedMatchId.value] = {
        ...guess,
        pointsEarned: isCorrect ? 1 : 0
      }
    }
  }
  return guessesObj
})

const getGuessesForMatch = (matchId) => {
  const finalLeaderboard = processedLeaderboard.value
  const match = processedMatches.value.find(m => m.id === matchId)
  
  return finalLeaderboard
    .filter(player => player.uid !== user.value?.uid)
    .map(player => {
      const guess = allGuesses.value.find(g => g.matchId === matchId && g.userId === player.uid)
      let pointsEarned = guess?.pointsEarned
      
      if (isSimulating.value && matchId === simulatedMatchId.value && simulatedStatus.value === 'completed') {
        const homeFinal = Number(simulatedHomeScore.value)
        const awayFinal = Number(simulatedAwayScore.value)
        const isCorrect = guess && Number(guess.homeGuess) === homeFinal && Number(guess.awayGuess) === awayFinal
        pointsEarned = isCorrect ? 1 : 0
      } else if (match && match.status === 'completed' && pointsEarned === null) {
        if (match.stage === 'knockout') {
          // Keep null for knockout matches until locked
          pointsEarned = null
        } else if (guess && guess.homeGuess !== null && guess.awayGuess !== null) {
          const isCorrect = Number(guess.homeGuess) === Number(match.homeScore) && 
                            Number(guess.awayGuess) === Number(match.awayScore)
          pointsEarned = isCorrect ? 1 : 0
        }
      }
      
      return {
        uid: player.uid,
        playerName: player.displayName,
        homeGuess: guess?.homeGuess,
        awayGuess: guess?.awayGuess,
        homeGuess90: guess?.homeGuess90,
        awayGuess90: guess?.awayGuess90,
        homeGuess120: guess?.homeGuess120,
        awayGuess120: guess?.awayGuess120,
        shootoutWinnerGuess: guess?.shootoutWinnerGuess,
        homeShootoutGuess: guess?.homeShootoutGuess,
        awayShootoutGuess: guess?.awayShootoutGuess,
        pointsEarned: pointsEarned
      }
    })
}

const getOtherGuessesCount = (matchId) => {
  return allGuesses.value.filter(g => g.matchId === matchId && g.userId !== user.value?.uid).length
}

const getPlayerRank = (player) => {
  let points = player.pointsDisplay || 0
  if (leaderboardFilter.value === 'group') {
    points = player.groupPointsDisplay || 0
  } else if (leaderboardFilter.value === 'knockout') {
    points = player.knockoutPointsDisplay || 0
  }
  
  const higherCount = processedLeaderboard.value.filter(p => {
    let pPts = p.pointsDisplay || 0
    if (leaderboardFilter.value === 'group') {
      pPts = p.groupPointsDisplay || 0
    } else if (leaderboardFilter.value === 'knockout') {
      pPts = p.knockoutPointsDisplay || 0
    }
    return pPts > points
  }).length
  
  return higherCount + 1
}


const isPredictionSaved = (matchId) => {
  const guess = userGuesses.value[matchId]
  const input = predictionInputs.value[matchId]
  if (!guess || !input) return false
  if (guess.homeGuess === null || guess.awayGuess === null || guess.homeGuess === undefined || guess.awayGuess === undefined) return false
  if (input.homeGuess === null || input.awayGuess === null || input.homeGuess === undefined || input.awayGuess === undefined) return false
  
  const standardMatch = Number(guess.homeGuess) === Number(input.homeGuess) && Number(guess.awayGuess) === Number(input.awayGuess)
  
  const match = matches.value.find(m => m.id === matchId)
  if (match && match.stage === 'knockout') {
    if (Number(input.homeGuess) === Number(input.awayGuess)) {
      const homeG120 = guess.homeGuess120 !== undefined ? guess.homeGuess120 : guess.homeGuess;
      const awayG120 = guess.awayGuess120 !== undefined ? guess.awayGuess120 : guess.awayGuess;
      const inputHome120 = input.homeGuess120 !== undefined ? input.homeGuess120 : input.homeGuess;
      const inputAway120 = input.awayGuess120 !== undefined ? input.awayGuess120 : input.awayGuess;
      
      const etMatch = Number(homeG120) === Number(inputHome120) && Number(awayG120) === Number(inputAway120)
      if (!etMatch) return false
      
      if (Number(inputHome120) === Number(inputAway120)) {
        if (guess.shootoutWinnerGuess !== input.shootoutWinnerGuess) return false
        
        const homePen = guess.homeShootoutGuess !== undefined && guess.homeShootoutGuess !== null ? guess.homeShootoutGuess : '';
        const awayPen = guess.awayShootoutGuess !== undefined && guess.awayShootoutGuess !== null ? guess.awayShootoutGuess : '';
        const inputHomePen = input.homeShootoutGuess !== undefined && input.homeShootoutGuess !== null ? input.homeShootoutGuess : '';
        const inputAwayPen = input.awayShootoutGuess !== undefined && input.awayShootoutGuess !== null ? input.awayShootoutGuess : '';
        if (String(homePen) !== String(inputHomePen) || String(awayPen) !== String(inputAwayPen)) return false
      }
    }
  }
  
  return standardMatch
}

watch(matches, (newMatches) => {
  newMatches.forEach(match => {
    if (!predictionInputs.value[match.id]) {
      predictionInputs.value[match.id] = { 
        homeGuess: null, 
        awayGuess: null,
        homeGuess120: null,
        awayGuess120: null,
        shootoutWinnerGuess: '',
        homeShootoutGuess: '',
        awayShootoutGuess: ''
      }
    }
  })
  
  if (newMatches && newMatches.length > 0 && !hasFetchedLiveScoresInitial) {
    hasFetchedLiveScoresInitial = true
    fetchESPNLiveScores()
  }
}, { deep: true })

watch(knockoutStageEnabled, (enabled) => {
  if (!enabled && leaderboardFilter.value === 'knockout') {
    leaderboardFilter.value = 'overall'
  }
})

// Date helpers for grouping matches
const getLocalDateString = (timestamp) => {
  if (!timestamp) return ''
  const dateObj = timestamp.toDate ? timestamp.toDate() : new Date(timestamp)
  return dateObj.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

const getGroupElementId = (day) => {
  return 'group-' + day.replace(/[^a-zA-Z0-9]/g, '_')
}

const emojiToCountryCode = (emoji) => {
  if (!emoji || emoji.length < 4) return ''
  try {
    const codePointZero = emoji.codePointAt(0)
    const codePointOne = emoji.codePointAt(2)
    if (
      codePointZero >= 0x1F1E6 && codePointZero <= 0x1F1FF &&
      codePointOne >= 0x1F1E6 && codePointOne <= 0x1F1FF
    ) {
      const char1 = String.fromCharCode(codePointZero - 0x1F1E6 + 65)
      const char2 = String.fromCharCode(codePointOne - 0x1F1E6 + 65)
      return (char1 + char2).toLowerCase()
    }
  } catch (e) {
    console.error('Error parsing flag emoji:', e)
  }
  return ''
}

const formatTime = (timestamp) => {
  if (!timestamp) return ''
  const dateObj = timestamp.toDate ? timestamp.toDate() : new Date(timestamp)
  return dateObj.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })
}

const groupedMatches = computed(() => {
  const groupsMap = {}
  visibleMatches.value.forEach(match => {
    const dayKey = getLocalDateString(match.date)
    if (!groupsMap[dayKey]) {
      groupsMap[dayKey] = []
    }
    groupsMap[dayKey].push(match)
  })
  
  return Object.keys(groupsMap).map(day => ({
    day,
    matches: groupsMap[day]
  }))
})

const toggleDay = (day) => {
  if (collapsedDays.value[day] === undefined) {
    const group = groupedMatches.value.find(g => g.day === day)
    collapsedDays.value[day] = !isDayAllCompleted(group)
  } else {
    collapsedDays.value[day] = !collapsedDays.value[day]
  }
}

const isDayAllCompleted = (group) => {
  if (!group || !group.matches || group.matches.length === 0) return false
  return group.matches.every(m => m.status === 'completed')
}

const isDayCollapsed = (group) => {
  if (!group) return false
  if (collapsedDays.value[group.day] !== undefined) {
    return collapsedDays.value[group.day]
  }
  return isDayAllCompleted(group)
}

const scrollToCurrentDay = () => {
  if (processedMatches.value.length === 0) return

  // 1. Try to find the first live match
  const liveMatch = processedMatches.value.find(m => m.status === 'live')
  if (liveMatch) {
    const dayKey = getLocalDateString(liveMatch.date)
    collapsedDays.value[dayKey] = false
    
    nextTick(() => {
      setTimeout(() => {
        const el = document.getElementById(`match-${liveMatch.id}`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }, 50)
    })
    return
  }

  // 2. Try to find the first upcoming scheduled match
  const scheduledMatches = processedMatches.value.filter(m => m.status === 'scheduled')
  const nextMatch = scheduledMatches[0]

  if (nextMatch) {
    const dayKey = getLocalDateString(nextMatch.date)
    collapsedDays.value[dayKey] = false

    // Check if there are any completed matches on the SAME day as the next match
    const dayMatches = processedMatches.value.filter(m => getLocalDateString(m.date) === dayKey)
    const hasCompletedMatchesOnDay = dayMatches.some(m => m.status === 'completed')

    if (hasCompletedMatchesOnDay) {
      // Scroll directly to the match card itself
      nextTick(() => {
        setTimeout(() => {
          const el = document.getElementById(`match-${nextMatch.id}`)
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }, 50)
      })
    } else {
      // Scroll to the day header
      nextTick(() => {
        setTimeout(() => {
          const el = document.getElementById(getGroupElementId(dayKey))
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }, 50)
      })
    }
    return
  }

  // 3. Fallback: Scroll to today's day header or first group
  const todayStr = getLocalDateString(new Date())
  let targetGroup = groupedMatches.value.find(g => g.day === todayStr)

  if (!targetGroup) {
    targetGroup = groupedMatches.value.find(g => !isDayAllCompleted(g))
  }

  if (!targetGroup) {
    targetGroup = groupedMatches.value[0]
  }

  if (!targetGroup) return

  collapsedDays.value[targetGroup.day] = false

  nextTick(() => {
    setTimeout(() => {
      const elementId = getGroupElementId(targetGroup.day)
      const el = document.getElementById(elementId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }, 50)
  })
}

watch(matches, (newVal) => {
  if (newVal && newVal.length > 0 && user.value && !hasScrolledToCurrent.value && activeTab.value === 'matches') {
    hasScrolledToCurrent.value = true
    nextTick(() => {
      setTimeout(() => {
        scrollToCurrentDay()
      }, 150)
    })
  }
}, { immediate: true })

const handleMatchesTabClick = () => {
  activeTab.value = 'matches'
  showGroupMatchesHistory.value = false
  nextTick(() => {
    setTimeout(() => {
      scrollToCurrentDay()
    }, 150)
  })
}

const handleLeaderboardTabClick = () => {
  activeTab.value = 'leaderboard'
  nextTick(() => {
    window.scrollTo(0, 0)
  })
}

const handleAdminTabClick = () => {
  activeTab.value = 'admin'
  nextTick(() => {
    window.scrollTo(0, 0)
  })
}

// Auth Form State
const isLogin = ref(true)
const isForgotPassword = ref(false)
const resetSent = ref(false)
const email = ref('')
const password = ref('')
const displayName = ref('')
const authError = ref('')
const authSuccess = ref('')
const authLoading = ref(false)

// Admin Form State
const newHomeTeam = ref('')
const newAwayTeam = ref('')
const newHomeFlag = ref('🏳️')
const newAwayFlag = ref('🏳️')
const newMatchDate = ref('')
const adminError = ref('')
const adminSuccess = ref('')
const adminScores = ref({}) // key: matchId -> { homeScore, awayScore }
const showClearConfirm = ref({}) // key: matchId -> boolean

// Realtime subscriptions cleanup
let matchesUnsub = null
let guessesUnsub = null
let leaderboardUnsub = null
let userProfileUnsub = null

// Seed matches
const defaultMatches = [
  {
    homeTeam: "Mexico",
    homeFlag: "🇲🇽",
    awayTeam: "South Africa",
    awayFlag: "🇿🇦",
    date: Timestamp.fromDate(new Date("2026-06-11T19:00:00.000Z")),
    homeScore: 2,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "South Korea",
    homeFlag: "🇰🇷",
    awayTeam: "Czech Republic",
    awayFlag: "🇨🇿",
    date: Timestamp.fromDate(new Date("2026-06-12T02:00:00.000Z")),
    homeScore: 2,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Czech Republic",
    homeFlag: "🇨🇿",
    awayTeam: "South Africa",
    awayFlag: "🇿🇦",
    date: Timestamp.fromDate(new Date("2026-06-18T16:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Mexico",
    homeFlag: "🇲🇽",
    awayTeam: "South Korea",
    awayFlag: "🇰🇷",
    date: Timestamp.fromDate(new Date("2026-06-19T01:00:00.000Z")),
    homeScore: 1,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "Czech Republic",
    homeFlag: "🇨🇿",
    awayTeam: "Mexico",
    awayFlag: "🇲🇽",
    date: Timestamp.fromDate(new Date("2026-06-25T01:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "South Africa",
    homeFlag: "🇿🇦",
    awayTeam: "South Korea",
    awayFlag: "🇰🇷",
    date: Timestamp.fromDate(new Date("2026-06-25T01:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Canada",
    homeFlag: "🇨🇦",
    awayTeam: "Bosnia & Herzegovina",
    awayFlag: "🇧🇦",
    date: Timestamp.fromDate(new Date("2026-06-12T19:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Qatar",
    homeFlag: "🇶🇦",
    awayTeam: "Switzerland",
    awayFlag: "🇨🇭",
    date: Timestamp.fromDate(new Date("2026-06-13T19:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Switzerland",
    homeFlag: "🇨🇭",
    awayTeam: "Bosnia & Herzegovina",
    awayFlag: "🇧🇦",
    date: Timestamp.fromDate(new Date("2026-06-18T19:00:00.000Z")),
    homeScore: 4,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Canada",
    homeFlag: "🇨🇦",
    awayTeam: "Qatar",
    awayFlag: "🇶🇦",
    date: Timestamp.fromDate(new Date("2026-06-18T22:00:00.000Z")),
    homeScore: 6,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "Switzerland",
    homeFlag: "🇨🇭",
    awayTeam: "Canada",
    awayFlag: "🇨🇦",
    date: Timestamp.fromDate(new Date("2026-06-24T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Bosnia & Herzegovina",
    homeFlag: "🇧🇦",
    awayTeam: "Qatar",
    awayFlag: "🇶🇦",
    date: Timestamp.fromDate(new Date("2026-06-24T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Brazil",
    homeFlag: "🇧🇷",
    awayTeam: "Morocco",
    awayFlag: "🇲🇦",
    date: Timestamp.fromDate(new Date("2026-06-13T22:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Haiti",
    homeFlag: "🇭🇹",
    awayTeam: "Scotland",
    awayFlag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    date: Timestamp.fromDate(new Date("2026-06-14T01:00:00.000Z")),
    homeScore: 0,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Scotland",
    homeFlag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    awayTeam: "Morocco",
    awayFlag: "🇲🇦",
    date: Timestamp.fromDate(new Date("2026-06-19T22:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Brazil",
    homeFlag: "🇧🇷",
    awayTeam: "Haiti",
    awayFlag: "🇭🇹",
    date: Timestamp.fromDate(new Date("2026-06-20T00:30:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Scotland",
    homeFlag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
    awayTeam: "Brazil",
    awayFlag: "🇧🇷",
    date: Timestamp.fromDate(new Date("2026-06-24T22:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Morocco",
    homeFlag: "🇲🇦",
    awayTeam: "Haiti",
    awayFlag: "🇭🇹",
    date: Timestamp.fromDate(new Date("2026-06-24T22:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "USA",
    homeFlag: "🇺🇸",
    awayTeam: "Paraguay",
    awayFlag: "🇵🇾",
    date: Timestamp.fromDate(new Date("2026-06-13T01:00:00.000Z")),
    homeScore: 4,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Australia",
    homeFlag: "🇦🇺",
    awayTeam: "Turkey",
    awayFlag: "🇹🇷",
    date: Timestamp.fromDate(new Date("2026-06-14T04:00:00.000Z")),
    homeScore: 2,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "USA",
    homeFlag: "🇺🇸",
    awayTeam: "Australia",
    awayFlag: "🇦🇺",
    date: Timestamp.fromDate(new Date("2026-06-19T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Turkey",
    homeFlag: "🇹🇷",
    awayTeam: "Paraguay",
    awayFlag: "🇵🇾",
    date: Timestamp.fromDate(new Date("2026-06-20T03:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Turkey",
    homeFlag: "🇹🇷",
    awayTeam: "USA",
    awayFlag: "🇺🇸",
    date: Timestamp.fromDate(new Date("2026-06-26T02:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Paraguay",
    homeFlag: "🇵🇾",
    awayTeam: "Australia",
    awayFlag: "🇦🇺",
    date: Timestamp.fromDate(new Date("2026-06-26T02:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Germany",
    homeFlag: "🇩🇪",
    awayTeam: "Curaçao",
    awayFlag: "🇨🇼",
    date: Timestamp.fromDate(new Date("2026-06-14T17:00:00.000Z")),
    homeScore: 7,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Ivory Coast",
    homeFlag: "🇨🇮",
    awayTeam: "Ecuador",
    awayFlag: "🇪🇨",
    date: Timestamp.fromDate(new Date("2026-06-14T23:00:00.000Z")),
    homeScore: 1,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "Germany",
    homeFlag: "🇩🇪",
    awayTeam: "Ivory Coast",
    awayFlag: "🇨🇮",
    date: Timestamp.fromDate(new Date("2026-06-20T20:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Ecuador",
    homeFlag: "🇪🇨",
    awayTeam: "Curaçao",
    awayFlag: "🇨🇼",
    date: Timestamp.fromDate(new Date("2026-06-21T00:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Curaçao",
    homeFlag: "🇨🇼",
    awayTeam: "Ivory Coast",
    awayFlag: "🇨🇮",
    date: Timestamp.fromDate(new Date("2026-06-25T20:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Ecuador",
    homeFlag: "🇪🇨",
    awayTeam: "Germany",
    awayFlag: "🇩🇪",
    date: Timestamp.fromDate(new Date("2026-06-25T20:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Netherlands",
    homeFlag: "🇳🇱",
    awayTeam: "Japan",
    awayFlag: "🇯🇵",
    date: Timestamp.fromDate(new Date("2026-06-14T20:00:00.000Z")),
    homeScore: 2,
    awayScore: 2,
    status: "completed"
  },
  {
    homeTeam: "Sweden",
    homeFlag: "🇸🇪",
    awayTeam: "Tunisia",
    awayFlag: "🇹🇳",
    date: Timestamp.fromDate(new Date("2026-06-15T02:00:00.000Z")),
    homeScore: 5,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Netherlands",
    homeFlag: "🇳🇱",
    awayTeam: "Sweden",
    awayFlag: "🇸🇪",
    date: Timestamp.fromDate(new Date("2026-06-20T17:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Tunisia",
    homeFlag: "🇹🇳",
    awayTeam: "Japan",
    awayFlag: "🇯🇵",
    date: Timestamp.fromDate(new Date("2026-06-21T04:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Japan",
    homeFlag: "🇯🇵",
    awayTeam: "Sweden",
    awayFlag: "🇸🇪",
    date: Timestamp.fromDate(new Date("2026-06-25T23:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Tunisia",
    homeFlag: "🇹🇳",
    awayTeam: "Netherlands",
    awayFlag: "🇳🇱",
    date: Timestamp.fromDate(new Date("2026-06-25T23:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Belgium",
    homeFlag: "🇧🇪",
    awayTeam: "Egypt",
    awayFlag: "🇪🇬",
    date: Timestamp.fromDate(new Date("2026-06-15T19:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Iran",
    homeFlag: "🇮🇷",
    awayTeam: "New Zealand",
    awayFlag: "🇳🇿",
    date: Timestamp.fromDate(new Date("2026-06-16T01:00:00.000Z")),
    homeScore: 2,
    awayScore: 2,
    status: "completed"
  },
  {
    homeTeam: "Belgium",
    homeFlag: "🇧🇪",
    awayTeam: "Iran",
    awayFlag: "🇮🇷",
    date: Timestamp.fromDate(new Date("2026-06-21T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "New Zealand",
    homeFlag: "🇳🇿",
    awayTeam: "Egypt",
    awayFlag: "🇪🇬",
    date: Timestamp.fromDate(new Date("2026-06-22T01:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Egypt",
    homeFlag: "🇪🇬",
    awayTeam: "Iran",
    awayFlag: "🇮🇷",
    date: Timestamp.fromDate(new Date("2026-06-27T03:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "New Zealand",
    homeFlag: "🇳🇿",
    awayTeam: "Belgium",
    awayFlag: "🇧🇪",
    date: Timestamp.fromDate(new Date("2026-06-27T03:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Spain",
    homeFlag: "🇪🇸",
    awayTeam: "Cape Verde",
    awayFlag: "🇨🇻",
    date: Timestamp.fromDate(new Date("2026-06-15T16:00:00.000Z")),
    homeScore: 0,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "Saudi Arabia",
    homeFlag: "🇸🇦",
    awayTeam: "Uruguay",
    awayFlag: "🇺🇾",
    date: Timestamp.fromDate(new Date("2026-06-15T22:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Spain",
    homeFlag: "🇪🇸",
    awayTeam: "Saudi Arabia",
    awayFlag: "🇸🇦",
    date: Timestamp.fromDate(new Date("2026-06-21T16:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Uruguay",
    homeFlag: "🇺🇾",
    awayTeam: "Cape Verde",
    awayFlag: "🇨🇻",
    date: Timestamp.fromDate(new Date("2026-06-21T22:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Cape Verde",
    homeFlag: "🇨🇻",
    awayTeam: "Saudi Arabia",
    awayFlag: "🇸🇦",
    date: Timestamp.fromDate(new Date("2026-06-27T00:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Uruguay",
    homeFlag: "🇺🇾",
    awayTeam: "Spain",
    awayFlag: "🇪🇸",
    date: Timestamp.fromDate(new Date("2026-06-27T00:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "France",
    homeFlag: "🇫🇷",
    awayTeam: "Senegal",
    awayFlag: "🇸🇳",
    date: Timestamp.fromDate(new Date("2026-06-16T19:00:00.000Z")),
    homeScore: 3,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Iraq",
    homeFlag: "🇮🇶",
    awayTeam: "Norway",
    awayFlag: "🇳🇴",
    date: Timestamp.fromDate(new Date("2026-06-16T22:00:00.000Z")),
    homeScore: 1,
    awayScore: 4,
    status: "completed"
  },
  {
    homeTeam: "France",
    homeFlag: "🇫🇷",
    awayTeam: "Iraq",
    awayFlag: "🇮🇶",
    date: Timestamp.fromDate(new Date("2026-06-22T21:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Norway",
    homeFlag: "🇳🇴",
    awayTeam: "Senegal",
    awayFlag: "🇸🇳",
    date: Timestamp.fromDate(new Date("2026-06-23T00:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Norway",
    homeFlag: "🇳🇴",
    awayTeam: "France",
    awayFlag: "🇫🇷",
    date: Timestamp.fromDate(new Date("2026-06-26T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Senegal",
    homeFlag: "🇸🇳",
    awayTeam: "Iraq",
    awayFlag: "🇮🇶",
    date: Timestamp.fromDate(new Date("2026-06-26T19:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Argentina",
    homeFlag: "🇦🇷",
    awayTeam: "Algeria",
    awayFlag: "🇩🇿",
    date: Timestamp.fromDate(new Date("2026-06-17T01:00:00.000Z")),
    homeScore: 3,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "Austria",
    homeFlag: "🇦🇹",
    awayTeam: "Jordan",
    awayFlag: "🇯🇴",
    date: Timestamp.fromDate(new Date("2026-06-17T04:00:00.000Z")),
    homeScore: 3,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Argentina",
    homeFlag: "🇦🇷",
    awayTeam: "Austria",
    awayFlag: "🇦🇹",
    date: Timestamp.fromDate(new Date("2026-06-22T17:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Jordan",
    homeFlag: "🇯🇴",
    awayTeam: "Algeria",
    awayFlag: "🇩🇿",
    date: Timestamp.fromDate(new Date("2026-06-23T03:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Algeria",
    homeFlag: "🇩🇿",
    awayTeam: "Austria",
    awayFlag: "🇦🇹",
    date: Timestamp.fromDate(new Date("2026-06-28T02:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Jordan",
    homeFlag: "🇯🇴",
    awayTeam: "Argentina",
    awayFlag: "🇦🇷",
    date: Timestamp.fromDate(new Date("2026-06-28T02:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Portugal",
    homeFlag: "🇵🇹",
    awayTeam: "DR Congo",
    awayFlag: "🇨🇩",
    date: Timestamp.fromDate(new Date("2026-06-17T17:00:00.000Z")),
    homeScore: 1,
    awayScore: 1,
    status: "completed"
  },
  {
    homeTeam: "Uzbekistan",
    homeFlag: "🇺🇿",
    awayTeam: "Colombia",
    awayFlag: "🇨🇴",
    date: Timestamp.fromDate(new Date("2026-06-18T02:00:00.000Z")),
    homeScore: 1,
    awayScore: 3,
    status: "completed"
  },
  {
    homeTeam: "Portugal",
    homeFlag: "🇵🇹",
    awayTeam: "Uzbekistan",
    awayFlag: "🇺🇿",
    date: Timestamp.fromDate(new Date("2026-06-23T17:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Colombia",
    homeFlag: "🇨🇴",
    awayTeam: "DR Congo",
    awayFlag: "🇨🇩",
    date: Timestamp.fromDate(new Date("2026-06-24T02:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Colombia",
    homeFlag: "🇨🇴",
    awayTeam: "Portugal",
    awayFlag: "🇵🇹",
    date: Timestamp.fromDate(new Date("2026-06-27T23:30:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "DR Congo",
    homeFlag: "🇨🇩",
    awayTeam: "Uzbekistan",
    awayFlag: "🇺🇿",
    date: Timestamp.fromDate(new Date("2026-06-27T23:30:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "England",
    homeFlag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    awayTeam: "Croatia",
    awayFlag: "🇭🇷",
    date: Timestamp.fromDate(new Date("2026-06-17T20:00:00.000Z")),
    homeScore: 4,
    awayScore: 2,
    status: "completed"
  },
  {
    homeTeam: "Ghana",
    homeFlag: "🇬🇭",
    awayTeam: "Panama",
    awayFlag: "🇵🇦",
    date: Timestamp.fromDate(new Date("2026-06-17T23:00:00.000Z")),
    homeScore: 1,
    awayScore: 0,
    status: "completed"
  },
  {
    homeTeam: "England",
    homeFlag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    awayTeam: "Ghana",
    awayFlag: "🇬🇭",
    date: Timestamp.fromDate(new Date("2026-06-23T20:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Panama",
    homeFlag: "🇵🇦",
    awayTeam: "Croatia",
    awayFlag: "🇭🇷",
    date: Timestamp.fromDate(new Date("2026-06-23T23:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Panama",
    homeFlag: "🇵🇦",
    awayTeam: "England",
    awayFlag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
    date: Timestamp.fromDate(new Date("2026-06-27T21:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  },
  {
    homeTeam: "Croatia",
    homeFlag: "🇭🇷",
    awayTeam: "Ghana",
    awayFlag: "🇬🇭",
    date: Timestamp.fromDate(new Date("2026-06-27T21:00:00.000Z")),
    homeScore: null,
    awayScore: null,
    status: "scheduled"
  }
]

// Auth handlers
const handleAuth = async () => {
  authError.value = ''
  authSuccess.value = ''
  authLoading.value = true
  try {
    if (isLogin.value) {
      await signInWithEmailAndPassword(auth, email.value, password.value)
    } else {
      if (!displayName.value.trim()) {
        throw new Error('Please enter a display name.')
      }
      const userCredential = await createUserWithEmailAndPassword(auth, email.value, password.value)
      await updateProfile(userCredential.user, { displayName: displayName.value })
      
      // Initialize user in Firestore
      await setDoc(doc(db, 'users', userCredential.user.uid), {
        uid: userCredential.user.uid,
        displayName: displayName.value,
        email: email.value,
        points: 0,
        groupPoints: 0,
        knockoutPoints: 0
      })
    }
    // Reset forms
    email.value = ''
    password.value = ''
    displayName.value = ''
  } catch (err) {
    authError.value = err.message
  } finally {
    authLoading.value = false
  }
}

const handleResetPassword = async () => {
  authError.value = ''
  authSuccess.value = ''
  if (!email.value) {
    authError.value = 'Please enter your email address.'
    return
  }
  authLoading.value = true
  try {
    await sendPasswordResetEmail(auth, email.value)
    resetSent.value = true
    authSuccess.value = 'Password reset email sent! Check your inbox (foarte probabil spam folder 🤓 ).'
    email.value = ''
  } catch (err) {
    if (err.code === 'auth/user-not-found' || err.message?.includes('user-not-found')) {
      authError.value = 'This email address is not registered.'
    } else {
      authError.value = err.message
    }
  } finally {
    authLoading.value = false
  }
}

const handleLogout = async () => {
  try {
    await signOut(auth)
    // Clear user-specific subscriptions
    if (guessesUnsub) guessesUnsub()
    if (userProfileUnsub) userProfileUnsub()
    userProfile.value = null
    allGuesses.value = []
    predictionInputs.value = {}
    expandedMatches.value = {}
    collapsedDays.value = {}
    adminScores.value = {}
  } catch (err) {
    console.error('Logout error:', err)
  }
}

// Check match start
const matchHasStarted = (matchDate) => {
  if (!matchDate) return false
  const dateObj = matchDate.toDate ? matchDate.toDate() : new Date(matchDate)
  return dateObj <= new Date()
}

// Format date
const formatDate = (matchDate) => {
  if (!matchDate) return ''
  const dateObj = matchDate.toDate ? matchDate.toDate() : new Date(matchDate)
  return dateObj.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// Sync default extra time score to the regular time score if regular time is a draw
const syncDefaultExtraTime = (matchId) => {
  const input = predictionInputs.value[matchId]
  if (!input) return
  
  const h = input.homeGuess
  const a = input.awayGuess
  
  if (typeof h === 'number' && typeof a === 'number' && h === a) {
    input.homeGuess120 = h
    input.awayGuess120 = a
  } else {
    input.homeGuess120 = null
    input.awayGuess120 = null
    input.shootoutWinnerGuess = ''
    input.homeShootoutGuess = ''
    input.awayShootoutGuess = ''
  }
}

const isExtraTimeValid = (matchId) => {
  const input = predictionInputs.value[matchId]
  if (!input) return false
  
  const h90 = input.homeGuess
  const a90 = input.awayGuess
  const h120 = input.homeGuess120
  const a120 = input.awayGuess120
  
  if (h90 === null || a90 === null || h90 === undefined || a90 === undefined || h90 === '' || a90 === '') return false
  if (h120 === null || a120 === null || h120 === undefined || a120 === undefined || h120 === '' || a120 === '') return false
  
  const h90Num = parseFloat(h90)
  const a90Num = parseFloat(a90)
  const h120Num = parseFloat(h120)
  const a120Num = parseFloat(a120)
  
  if (isNaN(h90Num) || isNaN(a90Num) || isNaN(h120Num) || isNaN(a120Num)) return false
  if (!Number.isInteger(h120Num) || !Number.isInteger(a120Num)) return false
  
  return h120Num >= h90Num && a120Num >= a90Num
}

const triggerClearConfirm = (matchId, val) => {
  showClearConfirm.value[matchId] = val
}

const clearGuess = async (matchId) => {
  const match = matches.value.find(m => m.id === matchId)
  if (!match || matchHasStarted(match.date)) return

  try {
    const guessId = `${user.value.uid}_${matchId}`
    const guessRef = doc(db, 'guesses', guessId)
    
    await deleteDoc(guessRef)

    predictionInputs.value[matchId] = {
      homeGuess: null,
      awayGuess: null,
      homeGuess120: null,
      awayGuess120: null,
      shootoutWinnerGuess: '',
      homeShootoutGuess: '',
      awayShootoutGuess: ''
    }
    
    showClearConfirm.value[matchId] = false
    adminSuccess.value = 'Predictions cleared!'
    setTimeout(() => adminSuccess.value = '', 3000)
  } catch (err) {
    adminError.value = `Failed to clear predictions: ${err.message}`
    setTimeout(() => adminError.value = '', 4000)
  }
}

const flagToCode = (flag) => {
  if (!flag) return ''
  if (flag === '🏴\u200d󠁢󠁳󠁣󠁴󠁿') return 'SCT'
  if (flag === '🏴\u200d󠁢󠁥󠁮󠁧󠁿') return 'ENG'
  if (flag === '🏴\u200d󠁢󠁷󠁬󠁳󠁿') return 'WLS'
  
  const chars = [...flag]
  const code = chars.map(char => {
    const cp = char.codePointAt(0)
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) {
      return String.fromCharCode(cp - 0x1F1E6 + 65)
    }
    return ''
  }).join('')
  return code
}

const formatFriendPredictionSegments = (pred, match) => {
  if (!pred) return [{ text: 'No prediction', isCorrect: false, isTextMuted: true }]
  
  const h90 = pred.homeGuess90 !== undefined ? pred.homeGuess90 : pred.homeGuess
  const a90 = pred.awayGuess90 !== undefined ? pred.awayGuess90 : pred.awayGuess
  
  if (h90 === null || h90 === undefined || h90 === '') {
    return [{ text: 'No prediction', isCorrect: false, isTextMuted: true }]
  }

  const segments = []
  
  // Helpers to resolve match scores safely
  const matchH90 = match.homeScore90 !== undefined && match.homeScore90 !== null ? match.homeScore90 : match.homeScore
  const matchA90 = match.awayScore90 !== undefined && match.awayScore90 !== null ? match.awayScore90 : match.awayScore
  const matchH120 = match.homeScore120 !== undefined && match.homeScore120 !== null ? match.homeScore120 : match.homeScore
  const matchA120 = match.awayScore120 !== undefined && match.awayScore120 !== null ? match.awayScore120 : match.awayScore

  // Component A: 90m Score
  const compA = `${h90}-${a90}`
  const isCorrectA = match.status === 'completed' && Number(h90) === Number(matchH90) && Number(a90) === Number(matchA90)
  segments.push({ text: compA, isCorrect: isCorrectA })
    
  if (match.stage !== 'knockout') {
    return segments
  }
  
  // If 90m is NOT a draw, don't show the extra time/shootout components and slashes
  if (Number(h90) !== Number(a90)) {
    return segments
  }
  
  // Component B: 120m Score
  let compB = '-'
  let isCorrectB = false
  if (pred.homeGuess120 !== null && pred.homeGuess120 !== undefined && pred.homeGuess120 !== '') {
    compB = `${pred.homeGuess120}-${pred.awayGuess120}`
    isCorrectB = match.status === 'completed' && Number(pred.homeGuess120) === Number(matchH120) && Number(pred.awayGuess120) === Number(matchA120)
  }
  
  segments.push({ text: ' / ', isSeparator: true })
  segments.push({ text: compB, isCorrect: isCorrectB })
  
  // If 120m is decisive (NOT a draw), don't show the shootout components and slashes
  if (pred.homeGuess120 !== null && pred.homeGuess120 !== undefined && pred.homeGuess120 !== '') {
    if (Number(pred.homeGuess120) !== Number(pred.awayGuess120)) {
      return segments
    }
  }
  
  // Component C: Shootout Winner Flag and Two Letter Code
  let compC = '-'
  let isCorrectC = false
  if (Number(pred.homeGuess120) === Number(pred.awayGuess120) && pred.homeGuess120 !== null && pred.homeGuess120 !== undefined && pred.homeGuess120 !== '') {
    if (pred.shootoutWinnerGuess) {
      const winnerFlag = pred.shootoutWinnerGuess === 'home' ? match.homeFlag : match.awayFlag
      const winnerCode = flagToCode(winnerFlag)
      compC = winnerFlag ? `${winnerFlag} ${winnerCode}` : '-'
      isCorrectC = match.status === 'completed' && pred.shootoutWinnerGuess === match.shootoutWinner
    }
  }
  
  segments.push({ text: ' / ', isSeparator: true })
  segments.push({ text: compC, isCorrect: isCorrectC })
  
  // Component D: Shootout score
  let compD = '-'
  let isCorrectD = false
  if (Number(pred.homeGuess120) === Number(pred.awayGuess120) && pred.homeGuess120 !== null && pred.homeGuess120 !== undefined && pred.homeGuess120 !== '') {
    if (pred.homeShootoutGuess !== null && pred.homeShootoutGuess !== undefined && pred.homeShootoutGuess !== '') {
      compD = `${pred.homeShootoutGuess}-${pred.awayShootoutGuess}`
      isCorrectD = match.status === 'completed' && Number(pred.homeShootoutGuess) === Number(match.homeShootoutScore) && Number(pred.awayShootoutGuess) === Number(match.awayShootoutScore)
    }
  }
  
  segments.push({ text: ' / ', isSeparator: true })
  segments.push({ text: compD, isCorrect: isCorrectD })
  
  return segments
}

// User Guesses Submission
const submitGuess = async (matchId) => {
  const guess = predictionInputs.value[matchId]
  if (!guess || guess.homeGuess === undefined || guess.awayGuess === undefined || guess.homeGuess === null || guess.awayGuess === null) {
    return
  }
  
  const match = matches.value.find(m => m.id === matchId)
  const isKnockout = match && match.stage === 'knockout'

  const homeVal = parseFloat(guess.homeGuess)
  const awayVal = parseFloat(guess.awayGuess)

  // Validate inputs
  const validateScore = (val) => Number.isInteger(val) && val >= 0
  if (!validateScore(homeVal) || !validateScore(awayVal)) {
    adminError.value = 'Predictions must be whole numbers.'
    setTimeout(() => adminError.value = '', 4000)
    return
  }

  const homeG90 = parseInt(guess.homeGuess)
  const awayG90 = parseInt(guess.awayGuess)

  let homeG120 = null
  let awayG120 = null
  let shootoutWinnerGuess = null
  let homeShootoutGuess = null
  let awayShootoutGuess = null

  if (isKnockout) {
    if (homeG90 === awayG90) {
      const home120Val = guess.homeGuess120 !== undefined && guess.homeGuess120 !== null && guess.homeGuess120 !== '' ? parseFloat(guess.homeGuess120) : homeVal
      const away120Val = guess.awayGuess120 !== undefined && guess.awayGuess120 !== null && guess.awayGuess120 !== '' ? parseFloat(guess.awayGuess120) : awayVal

      if (!validateScore(home120Val) || !validateScore(away120Val)) {
        adminError.value = 'Extra time scores must be whole numbers.'
        setTimeout(() => adminError.value = '', 4000)
        return
      }
      if (home120Val < homeVal || away120Val < awayVal) {
        adminError.value = 'Extra time goals cannot be less than 90 minutes goals!'
        setTimeout(() => adminError.value = '', 4000)
        return
      }

      homeG120 = (guess.homeGuess120 !== undefined && guess.homeGuess120 !== null && guess.homeGuess120 !== '') ? parseInt(guess.homeGuess120) : homeG90
      awayG120 = (guess.awayGuess120 !== undefined && guess.awayGuess120 !== null && guess.awayGuess120 !== '') ? parseInt(guess.awayGuess120) : awayG90
      
      if (homeG120 === awayG120) {
        shootoutWinnerGuess = guess.shootoutWinnerGuess || null
        if (!shootoutWinnerGuess) {
          adminError.value = 'Please select a shootout winner.'
          setTimeout(() => adminError.value = '', 4000)
          return
        }

        const hasHomePen = guess.homeShootoutGuess !== undefined && guess.homeShootoutGuess !== null && guess.homeShootoutGuess !== ''
        const hasAwayPen = guess.awayShootoutGuess !== undefined && guess.awayShootoutGuess !== null && guess.awayShootoutGuess !== ''

        if (hasHomePen || hasAwayPen) {
          if (!hasHomePen || !hasAwayPen) {
            adminError.value = 'Please enter shootout scores for both teams, or leave both empty.'
            setTimeout(() => adminError.value = '', 4000)
            return
          }

          const penHomeVal = parseFloat(guess.homeShootoutGuess)
          const penAwayVal = parseFloat(guess.awayShootoutGuess)
          if (!validateScore(penHomeVal) || !validateScore(penAwayVal)) {
            adminError.value = 'Shootout scores must be whole numbers.'
            setTimeout(() => adminError.value = '', 4000)
            return
          }

          homeShootoutGuess = parseInt(guess.homeShootoutGuess)
          awayShootoutGuess = parseInt(guess.awayShootoutGuess)

          if (homeShootoutGuess === awayShootoutGuess) {
            adminError.value = 'Shootout score cannot be a draw!'
            setTimeout(() => adminError.value = '', 4000)
            return
          }

          if (shootoutWinnerGuess === 'home' && homeShootoutGuess < awayShootoutGuess) {
            adminError.value = `Shootout score must favor the selected winner (${match.homeTeam}).`
            setTimeout(() => adminError.value = '', 4000)
            return
          }
          if (shootoutWinnerGuess === 'away' && awayShootoutGuess < homeShootoutGuess) {
            adminError.value = `Shootout score must favor the selected winner (${match.awayTeam}).`
            setTimeout(() => adminError.value = '', 4000)
            return
          }
        }
      }
    }
  }
  
  try {
    const guessId = `${user.value.uid}_${matchId}`
    const guessData = {
      userId: user.value.uid,
      matchId: matchId,
      homeGuess: homeG90,
      awayGuess: awayG90,
      homeGuess90: homeG90,
      awayGuess90: awayG90,
      homeGuess120: homeG120,
      awayGuess120: awayG120,
      shootoutWinnerGuess: shootoutWinnerGuess,
      homeShootoutGuess: homeShootoutGuess,
      awayShootoutGuess: awayShootoutGuess,
      pointsEarned: null,
      submittedAt: Timestamp.now()
    }
    await setDoc(doc(db, 'guesses', guessId), guessData)

    // Update local state to reflect saved/cleared properties
    predictionInputs.value[matchId].homeGuess120 = homeG120
    predictionInputs.value[matchId].awayGuess120 = awayG120
    predictionInputs.value[matchId].shootoutWinnerGuess = shootoutWinnerGuess || ''
    predictionInputs.value[matchId].homeShootoutGuess = homeShootoutGuess !== null ? homeShootoutGuess : ''
    predictionInputs.value[matchId].awayShootoutGuess = awayShootoutGuess !== null ? awayShootoutGuess : ''

    adminSuccess.value = 'Guess saved!'
    setTimeout(() => adminSuccess.value = '', 3000)
  } catch (err) {
    console.error('Error saving guess:', err)
  }
}

// Admin Match Addition
const addMatch = async () => {
  adminError.value = ''
  adminSuccess.value = ''
  if (!newHomeTeam.value || !newAwayTeam.value || !newMatchDate.value) {
    adminError.value = 'Please fill out all match details.'
    return
  }

  try {
    await addDoc(collection(db, 'matches'), {
      homeTeam: newHomeTeam.value,
      awayTeam: newAwayTeam.value,
      homeFlag: newHomeFlag.value,
      awayFlag: newAwayFlag.value,
      date: Timestamp.fromDate(new Date(newMatchDate.value)),
      homeScore: null,
      awayScore: null,
      status: 'scheduled'
    })
    
    adminSuccess.value = 'Match added successfully!'
    newHomeTeam.value = ''
    newAwayTeam.value = ''
    newHomeFlag.value = '🏳️'
    newAwayFlag.value = '🏳️'
    newMatchDate.value = ''
  } catch (err) {
    adminError.value = err.message
  }
}

// Delete User Data permanently
const deleteUserData = async (uid) => {
  if (!confirm("Are you sure you want to permanently delete this user's profile and prediction data? This cannot be undone.")) return
  adminError.value = ''
  adminSuccess.value = ''
  try {
    await deleteDoc(doc(db, 'users', uid))
    
    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('userId', '==', uid)))
    const batch = writeBatch(db)
    guessesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })
    await batch.commit()
    
    adminSuccess.value = 'User profile and all guesses permanently deleted!'
  } catch (err) {
    adminError.value = err.message
  }
}

// Toggle User status (Leaderboard visibility)
const toggleUserDisabledState = async (uid, isCurrentlyDisabled) => {
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const userRef = doc(db, 'users', uid)
    await updateDoc(userRef, {
      disabled: !isCurrentlyDisabled
    })
    adminSuccess.value = `User status successfully updated!`
  } catch (err) {
    adminError.value = err.message
  }
}

const seedTestFriendPredictions = async () => {
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const matchId = "test-friends-match-1"
    
    await setDoc(doc(db, "matches", matchId), {
      homeTeam: "Spain",
      awayTeam: "Germany",
      homeFlag: "🇪🇸",
      awayFlag: "🇩🇪",
      stage: "knockout",
      status: "completed",
      date: Timestamp.fromDate(new Date(Date.now() - 3 * 3600 * 1000)), // 3 hours ago
      homeScore: 2,
      awayScore: 2,
      homeScore90: 2,
      awayScore90: 2,
      homeScore120: 2,
      awayScore120: 2,
      shootoutWinner: "home",
      homeShootoutScore: 5,
      awayShootoutScore: 4
    })

    const testUsers = [
      { uid: "test_user_a", displayName: "Alice (Test)", points: 5, groupPoints: 5, knockoutPoints: 0 },
      { uid: "test_user_b", displayName: "Bob (Test)", points: 10, groupPoints: 8, knockoutPoints: 2 },
      { uid: "test_user_c", displayName: "Charlie (Test)", points: 3, groupPoints: 3, knockoutPoints: 0 }
    ]
    for (const tu of testUsers) {
      await setDoc(doc(db, "users", tu.uid), tu, { merge: true })
    }

    const guesses = [
      {
        id: `test_user_a_${matchId}`,
        userId: "test_user_a",
        playerName: "Alice (Test)",
        matchId: matchId,
        homeGuess: 3,
        awayGuess: 1,
        homeGuess120: null,
        awayGuess120: null,
        shootoutWinnerGuess: "",
        homeShootoutGuess: "",
        awayShootoutGuess: "",
        pointsEarned: 0
      },
      {
        id: `test_user_b_${matchId}`,
        userId: "test_user_b",
        playerName: "Bob (Test)",
        matchId: matchId,
        homeGuess: 2,
        awayGuess: 2,
        homeGuess120: 2,
        awayGuess120: 2,
        shootoutWinnerGuess: "home",
        homeShootoutGuess: 5,
        awayShootoutGuess: 4,
        pointsEarned: 4
      },
      {
        id: `test_user_c_${matchId}`,
        userId: "test_user_c",
        playerName: "Charlie (Test)",
        matchId: matchId,
        homeGuess: 2,
        awayGuess: 2,
        homeGuess120: 4,
        awayGuess120: 4,
        shootoutWinnerGuess: "home",
        homeShootoutGuess: "",
        awayShootoutGuess: "",
        pointsEarned: 1.5
      }
    ]
    for (const g of guesses) {
      await setDoc(doc(db, "guesses", g.id), g, { merge: true })
    }

    adminSuccess.value = "Test match Spain vs Germany and predictions seeded successfully! Look for it on the Matches tab."
    setTimeout(() => adminSuccess.value = "", 5000)
  } catch (err) {
    adminError.value = `Failed to seed test predictions: ${err.message}`
    setTimeout(() => adminError.value = "", 5000)
  }
}

const cleanTestData = async () => {
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const matchId = "test-friends-match-1"
    
    // 1. Delete test match
    await deleteDoc(doc(db, "matches", matchId))
    
    // 2. Delete test users
    const testUsers = ["test_user_a", "test_user_b", "test_user_c"]
    for (const uid of testUsers) {
      await deleteDoc(doc(db, "users", uid))
    }
    
    // 3. Delete guesses for test match and test users
    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('matchId', '==', matchId)))
    const batch = writeBatch(db)
    guessesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })
    await batch.commit()
    
    adminSuccess.value = "Test match, test users, and test predictions removed successfully!"
    setTimeout(() => adminSuccess.value = "", 5000)
  } catch (err) {
    adminError.value = "Error cleaning test data: " + err.message
    setTimeout(() => adminError.value = "", 5000)
  }
}

// Admin Seed matches in Firestore database
const seedDatabase = async () => {
  const confirmation = prompt('WARNING: Seeding the database will delete ALL existing predictions/guesses and reset user scores to 0. This action is irreversible. To proceed, please type "SEED" in uppercase:')
  if (confirmation !== 'SEED') {
    return
  }
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const batch = writeBatch(db)
    
    const matchesSnap = await getDocs(collection(db, 'matches'))
    matchesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })

    const guessesSnap = await getDocs(collection(db, 'guesses'))
    guessesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })

    const usersSnap = await getDocs(collection(db, 'users'))
    usersSnap.docs.forEach((uDoc) => {
      batch.update(uDoc.ref, { points: 0, groupPoints: 0, knockoutPoints: 0 })
    })

    defaultMatches.forEach((match) => {
      const matchRef = doc(collection(db, 'matches'))
      batch.set(matchRef, match)
    })

    await batch.commit()
    adminSuccess.value = 'Database re-seeded with matches!'
  } catch (err) {
    adminError.value = err.message
  }
}

const seedRoundOf32Matches = async () => {
  const confirmation = prompt('WARNING: This will append the 16 Round of 32 matches to your matches collection and initialize users\' group stage points. Type "KNOCKOUT" to proceed:')
  if (confirmation !== 'KNOCKOUT') {
    return
  }
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const flagMap = {
      "South Africa": "🇿🇦",
      "Canada": "🇨🇦",
      "Brazil": "🇧🇷",
      "Japan": "🇯🇵",
      "Germany": "🇩🇪",
      "Paraguay": "🇵🇾",
      "Netherlands": "🇳🇱",
      "Morocco": "🇲🇦",
      "Ivory Coast": "🇨🇮",
      "Norway": "🇳🇴",
      "France": "🇫🇷",
      "Sweden": "🇸🇪",
      "Mexico": "🇲🇽",
      "Belgium": "🇧🇪",
      "United States": "🇺🇸",
      "Bosnia-Herzegovina": "🇧🇦",
      "Bosnia & Herzegovina": "🇧🇦",
      "Spain": "🇪🇸",
      "Switzerland": "🇨🇭",
      "Australia": "🇦🇺",
      "Egypt": "🇪🇬",
      "Argentina": "🇦🇷",
      "Cape Verde": "🇨🇻"
    };

    const getFlag = (teamName) => {
      return flagMap[teamName] || "🏳️";
    };

    const roundOf32Matches = [
      { homeTeam: "South Africa", awayTeam: "Canada", date: "2026-06-28T19:00:00Z", espnEventId: "760486" },
      { homeTeam: "Brazil", awayTeam: "Japan", date: "2026-06-29T17:00:00Z", espnEventId: "760487" },
      { homeTeam: "Germany", awayTeam: "Paraguay", date: "2026-06-29T20:30:00Z", espnEventId: "760489" },
      { homeTeam: "Netherlands", awayTeam: "Morocco", date: "2026-06-30T01:00:00Z", espnEventId: "760488" },
      { homeTeam: "Ivory Coast", awayTeam: "Norway", date: "2026-06-30T17:00:00Z", espnEventId: "760490" },
      { homeTeam: "France", awayTeam: "Sweden", date: "2026-06-30T21:00:00Z", espnEventId: "760492" },
      { homeTeam: "Mexico", awayTeam: "Third Place Group C/E/F/H/I", date: "2026-07-01T01:00:00Z", espnEventId: "760491" },
      { homeTeam: "Group L Winner", awayTeam: "Third Place Group E/H/I/J/K", date: "2026-07-01T16:00:00Z", espnEventId: "760495" },
      { homeTeam: "Belgium", awayTeam: "Third Place Group A/E/H/I/J", date: "2026-07-01T20:00:00Z", espnEventId: "760493" },
      { homeTeam: "United States", awayTeam: "Bosnia-Herzegovina", date: "2026-07-02T00:00:00Z", espnEventId: "760494" },
      { homeTeam: "Spain", awayTeam: "Group J 2nd Place", date: "2026-07-02T19:00:00Z", espnEventId: "760497" },
      { homeTeam: "Group K 2nd Place", awayTeam: "Group L 2nd Place", date: "2026-07-02T23:00:00Z", espnEventId: "760496" },
      { homeTeam: "Switzerland", awayTeam: "Third Place Group E/F/G/I/J", date: "2026-07-03T03:00:00Z", espnEventId: "760498" },
      { homeTeam: "Australia", awayTeam: "Egypt", date: "2026-07-03T18:00:00Z", espnEventId: "760499" },
      { homeTeam: "Argentina", awayTeam: "Cape Verde", date: "2026-07-03T22:00:00Z", espnEventId: "760500" },
      { homeTeam: "Group K Winner", awayTeam: "Third Place Group D/E/I/J/L", date: "2026-07-04T01:30:00Z", espnEventId: "760501" }
    ];

    const batch = writeBatch(db)

    // 1. Initialize settings/app (disabled by default)
    const settingsRef = doc(db, "settings", "app")
    batch.set(settingsRef, { knockoutStageEnabled: false }, { merge: true })

    // 2. Migrate existing users schemas
    const usersSnap = await getDocs(collection(db, "users"))
    let userMigrationCount = 0
    usersSnap.forEach((userDoc) => {
      const data = userDoc.data()
      if (data.groupPoints === undefined || data.knockoutPoints === undefined) {
        batch.update(userDoc.ref, {
          groupPoints: data.points !== undefined ? data.points : 0,
          knockoutPoints: 0
        })
        userMigrationCount++
      }
    })

    // 3. Seed matches safely
    const matchesSnap = await getDocs(collection(db, "matches"))
    const existingMatches = matchesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))

    let matchesAddedCount = 0
    for (const newMatch of roundOf32Matches) {
      const isDuplicate = existingMatches.some(m => m.espnEventId === newMatch.espnEventId)
      if (!isDuplicate) {
        const matchRef = doc(collection(db, "matches"))
        batch.set(matchRef, {
          homeTeam: newMatch.homeTeam,
          awayTeam: newMatch.awayTeam,
          homeFlag: getFlag(newMatch.homeTeam),
          awayFlag: getFlag(newMatch.awayTeam),
          date: Timestamp.fromDate(new Date(newMatch.date)),
          homeScore: null,
          awayScore: null,
          status: "scheduled",
          stage: "knockout",
          espnEventId: newMatch.espnEventId,
          homeScore90: null,
          awayScore90: null,
          homeScore120: null,
          awayScore120: null,
          homeShootoutScore: null,
          awayShootoutScore: null,
          shootoutWinner: null
        })
        matchesAddedCount++
      } else {
        const existing = existingMatches.find(m => m.espnEventId === newMatch.espnEventId)
        if (existing.stage !== "knockout") {
          batch.update(doc(db, "matches", existing.id), { stage: "knockout" })
        }
      }
    }

    await batch.commit()
    adminSuccess.value = `Successfully imported ${matchesAddedCount} Round of 32 matches and migrated ${userMigrationCount} users!`
    setTimeout(() => adminSuccess.value = '', 5000)
  } catch (err) {
    adminError.value = `Failed to seed Round of 32: ${err.message}`
    setTimeout(() => adminError.value = '', 5000)
  }
}

const showShootoutInputs = (matchId) => {
  const score = adminScores.value[matchId]
  if (!score) return false
  const homeScoreRaw = parseFloat(score.homeScore)
  const awayScoreRaw = parseFloat(score.awayScore)
  
  if (isNaN(homeScoreRaw) || isNaN(awayScoreRaw)) return false

  const raw120Home = score.homeScore120 !== undefined && score.homeScore120 !== null && score.homeScore120 !== '' ? parseFloat(score.homeScore120) : homeScoreRaw
  const raw120Away = score.awayScore120 !== undefined && score.awayScore120 !== null && score.awayScore120 !== '' ? parseFloat(score.awayScore120) : awayScoreRaw
  
  return raw120Home === raw120Away
}

// Admin Complete Match & Distribute Points
const completeMatch = async (matchId) => {
  adminError.value = ''
  adminSuccess.value = ''
  const score = adminScores.value[matchId]
  if (!score || score.homeScore === undefined || score.awayScore === undefined || score.homeScore === null || score.awayScore === null) {
    adminError.value = 'Please enter final scores before locking.'
    return
  }

  const match = matches.value.find(m => m.id === matchId)
  if (!match) return

  const isKnockout = match.stage === 'knockout'

  const homeScoreRaw = parseFloat(score.homeScore)
  const awayScoreRaw = parseFloat(score.awayScore)

  const validateScore = (val) => Number.isInteger(val) && val >= 0
  if (!validateScore(homeScoreRaw) || !validateScore(awayScoreRaw)) {
    adminError.value = 'Scores must be whole numbers.'
    return
  }

  const homeScoreVal = parseInt(score.homeScore)
  const awayScoreVal = parseInt(score.awayScore)

  let homeScore90 = homeScoreVal
  let awayScore90 = awayScoreVal
  let homeScore120 = homeScoreVal
  let awayScore120 = awayScoreVal
  let homeShootoutScore = null
  let awayShootoutScore = null
  let shootoutWinner = null

  if (isKnockout) {
    const raw90Home = score.homeScore90 !== undefined && score.homeScore90 !== null && score.homeScore90 !== '' ? parseFloat(score.homeScore90) : homeScoreRaw
    const raw90Away = score.awayScore90 !== undefined && score.awayScore90 !== null && score.awayScore90 !== '' ? parseFloat(score.awayScore90) : awayScoreRaw
    const raw120Home = score.homeScore120 !== undefined && score.homeScore120 !== null && score.homeScore120 !== '' ? parseFloat(score.homeScore120) : homeScoreRaw
    const raw120Away = score.awayScore120 !== undefined && score.awayScore120 !== null && score.awayScore120 !== '' ? parseFloat(score.awayScore120) : awayScoreRaw

    if (!validateScore(raw90Home) || !validateScore(raw90Away) || !validateScore(raw120Home) || !validateScore(raw120Away)) {
      adminError.value = 'Knockout scores must be whole numbers.'
      return
    }

    homeScore90 = parseInt(raw90Home)
    awayScore90 = parseInt(raw90Away)
    homeScore120 = parseInt(raw120Home)
    awayScore120 = parseInt(raw120Away)
    
    if (homeScore120 === awayScore120) {
      shootoutWinner = score.shootoutWinner || null
      if (!shootoutWinner) {
        adminError.value = 'Match ended in draw after 120m. Please select a shootout winner.'
        return
      }

      const hasHomePen = score.homeShootoutScore !== undefined && score.homeShootoutScore !== null && score.homeShootoutScore !== ''
      const hasAwayPen = score.awayShootoutScore !== undefined && score.awayShootoutScore !== null && score.awayShootoutScore !== ''

      if (!hasHomePen || !hasAwayPen) {
        adminError.value = 'Please enter shootout scores for both teams.'
        return
      }

      const rawPenHome = parseFloat(score.homeShootoutScore)
      const rawPenAway = parseFloat(score.awayShootoutScore)
      if (!validateScore(rawPenHome) || !validateScore(rawPenAway)) {
        adminError.value = 'Shootout scores must be whole numbers.'
        return
      }

      homeShootoutScore = parseInt(score.homeShootoutScore)
      awayShootoutScore = parseInt(score.awayShootoutScore)

      if (homeShootoutScore === awayShootoutScore) {
        adminError.value = 'Shootout score cannot be a draw!'
        return
      }

      if (shootoutWinner === 'home' && homeShootoutScore < awayShootoutScore) {
        adminError.value = 'Shootout score must favor the selected winner (Home).'
        return
      }
      if (shootoutWinner === 'away' && awayShootoutScore < homeShootoutScore) {
        adminError.value = 'Shootout score must favor the selected winner (Away).'
        return
      }
    }
  }

  try {
    const batch = writeBatch(db)

    const matchUpdate = {
      status: 'completed',
      homeScore: homeScoreVal,
      awayScore: awayScoreVal
    }
    if (isKnockout) {
      matchUpdate.homeScore90 = homeScore90
      matchUpdate.awayScore90 = awayScore90
      matchUpdate.homeScore120 = homeScore120
      matchUpdate.awayScore120 = awayScore120
      matchUpdate.homeShootoutScore = homeShootoutScore
      matchUpdate.awayShootoutScore = awayShootoutScore
      matchUpdate.shootoutWinner = shootoutWinner
    }
    batch.update(doc(db, 'matches', matchId), matchUpdate)

    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('matchId', '==', matchId)))
    
    for (const guessDoc of guessesSnap.docs) {
      const guessData = guessDoc.data()
      let pointsEarned = 0

      if (isKnockout) {
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
      } else {
        const isCorrect = guessData.homeGuess === homeScoreVal && guessData.awayGuess === awayScoreVal
        pointsEarned = isCorrect ? 1 : 0
      }

      batch.update(doc(db, 'guesses', guessDoc.id), { pointsEarned })

      if (pointsEarned > 0) {
        const userRef = doc(db, 'users', guessData.userId)
        const update = {
          points: increment(pointsEarned)
        }
        if (isKnockout) {
          update.knockoutPoints = increment(pointsEarned)
        } else {
          update.groupPoints = increment(pointsEarned)
        }
        batch.update(userRef, update)
      }
    }

    await batch.commit()
    adminSuccess.value = 'Scores locked and points distributed!'
  } catch (err) {
    adminError.value = err.message
  }
}

// Admin Reset Match
const resetMatch = async (matchId) => {
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const matchDoc = await getDoc(doc(db, 'matches', matchId))
    if (!matchDoc.exists()) throw new Error('Match not found')
    const matchData = matchDoc.data()
    if (matchData.status !== 'completed') return

    const batch = writeBatch(db)

    batch.update(doc(db, 'matches', matchId), {
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      homeScore90: null,
      awayScore90: null,
      homeScore120: null,
      awayScore120: null,
      homeShootoutScore: null,
      awayShootoutScore: null,
      shootoutWinner: null
    })

    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('matchId', '==', matchId)))
    
    for (const guessDoc of guessesSnap.docs) {
      const guessData = guessDoc.data()
      const pts = guessData.pointsEarned || 0
      if (pts > 0) {
        const userRef = doc(db, 'users', guessData.userId)
        const update = {
          points: increment(-pts)
        }
        if (matchData.stage === 'knockout') {
          update.knockoutPoints = increment(-pts)
        } else {
          update.groupPoints = increment(-pts)
        }
        batch.update(userRef, update)
      }
      
      batch.update(doc(db, 'guesses', guessDoc.id), {
        pointsEarned: null
      })
    }

    await batch.commit()
    adminSuccess.value = 'Match reset to scheduled state.'
  } catch (err) {
    adminError.value = err.message
  }
}

const toggleKnockoutStage = async () => {
  const targetState = !knockoutStageEnabled.value
  try {
    const settingsRef = doc(db, 'settings', 'app')
    await setDoc(settingsRef, { knockoutStageEnabled: targetState }, { merge: true })
    adminSuccess.value = `Knockout stage features ${targetState ? 'enabled' : 'disabled'} successfully!`
    setTimeout(() => adminSuccess.value = '', 4000)
  } catch (err) {
    adminError.value = `Failed to toggle knockout stage: ${err.message}`
    setTimeout(() => adminError.value = '', 4000)
  }
}

// Subscriptions Lifecycle
const initRealtimeData = (currentUser) => {
  // 1. Subscribe to Matches
  const matchesQuery = query(collection(db, 'matches'), orderBy('date', 'asc'))
  matchesUnsub = onSnapshot(matchesQuery, (snapshot) => {
    matches.value = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    
    // Initialize admin input binders
    matches.value.forEach(match => {
      if (!adminScores.value[match.id]) {
        adminScores.value[match.id] = {
          homeScore: (match.homeScore !== undefined && match.homeScore !== null) ? match.homeScore : '',
          awayScore: (match.awayScore !== undefined && match.awayScore !== null) ? match.awayScore : '',
          homeScore90: (match.homeScore90 !== undefined && match.homeScore90 !== null) ? match.homeScore90 : '',
          awayScore90: (match.awayScore90 !== undefined && match.awayScore90 !== null) ? match.awayScore90 : '',
          homeScore120: (match.homeScore120 !== undefined && match.homeScore120 !== null) ? match.homeScore120 : '',
          awayScore120: (match.awayScore120 !== undefined && match.awayScore120 !== null) ? match.awayScore120 : '',
          homeShootoutScore: (match.homeShootoutScore !== undefined && match.homeShootoutScore !== null) ? match.homeShootoutScore : '',
          awayShootoutScore: (match.awayShootoutScore !== undefined && match.awayShootoutScore !== null) ? match.awayShootoutScore : '',
          shootoutWinner: match.shootoutWinner || ''
        }
      }
    })
  })

  // 2. Subscribe to current user's profile info
  const userProfileRef = doc(db, 'users', currentUser.uid)
  userProfileUnsub = onSnapshot(userProfileRef, (snapshot) => {
    if (snapshot.exists()) {
      userProfile.value = { uid: snapshot.id, ...snapshot.data() }
    }
  })

  // 3. Subscribe to ALL guesses
  const guessesQuery = query(collection(db, 'guesses'))
  guessesUnsub = onSnapshot(guessesQuery, (snapshot) => {
    allGuesses.value = snapshot.docs.map(doc => doc.data())
    
    // Sync current user's predictions to local inputs
    allGuesses.value.forEach(guess => {
      if (guess.userId === currentUser.uid) {
        const homeG90 = guess.homeGuess90 !== undefined ? guess.homeGuess90 : guess.homeGuess;
        const awayG90 = guess.awayGuess90 !== undefined ? guess.awayGuess90 : guess.awayGuess;

        if (!predictionInputs.value[guess.matchId]) {
          predictionInputs.value[guess.matchId] = {
            homeGuess: homeG90,
            awayGuess: awayG90,
            homeGuess120: guess.homeGuess120 !== undefined ? guess.homeGuess120 : homeG90,
            awayGuess120: guess.awayGuess120 !== undefined ? guess.awayGuess120 : awayG90,
            shootoutWinnerGuess: guess.shootoutWinnerGuess || '',
            homeShootoutGuess: guess.homeShootoutGuess !== undefined ? guess.homeShootoutGuess : '',
            awayShootoutGuess: guess.awayShootoutGuess !== undefined ? guess.awayShootoutGuess : ''
          }
        } else {
          predictionInputs.value[guess.matchId].homeGuess = homeG90
          predictionInputs.value[guess.matchId].awayGuess = awayG90
          predictionInputs.value[guess.matchId].homeGuess120 = guess.homeGuess120 !== undefined ? guess.homeGuess120 : homeG90
          predictionInputs.value[guess.matchId].awayGuess120 = guess.awayGuess120 !== undefined ? guess.awayGuess120 : awayG90
          predictionInputs.value[guess.matchId].shootoutWinnerGuess = guess.shootoutWinnerGuess || ''
          predictionInputs.value[guess.matchId].homeShootoutGuess = guess.homeShootoutGuess !== undefined ? guess.homeShootoutGuess : ''
          predictionInputs.value[guess.matchId].awayShootoutGuess = guess.awayShootoutGuess !== undefined ? guess.awayShootoutGuess : ''
        }
      }
    })
  })

  // 4. Subscribe to Leaderboard
  const leaderboardQuery = query(collection(db, 'users'), orderBy('points', 'desc'))
  leaderboardUnsub = onSnapshot(leaderboardQuery, (snapshot) => {
    leaderboard.value = snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }))
  })

  // 5. Subscribe to Settings
  const settingsRef = doc(db, 'settings', 'app')
  settingsUnsub = onSnapshot(settingsRef, (snapshot) => {
    if (snapshot.exists()) {
      knockoutStageEnabled.value = snapshot.data().knockoutStageEnabled || false
    } else {
      knockoutStageEnabled.value = false
    }
  })
}

// Clean up subs on unmount
const clearSubscriptions = () => {
  if (matchesUnsub) matchesUnsub()
  if (guessesUnsub) guessesUnsub()
  if (leaderboardUnsub) leaderboardUnsub()
  if (userProfileUnsub) userProfileUnsub()
  if (settingsUnsub) settingsUnsub()
}

onMounted(() => {
  window.addEventListener('click', closeUserMenu)
  
  // Client-side real-time score polling
  fetchESPNLiveScores()
  espnPollIntervalId = setInterval(fetchESPNLiveScores, 60000)

  // App update checking
  checkAppVersion()
  versionCheckIntervalId = setInterval(checkAppVersion, 60000) // check every 1 minute
  document.addEventListener('visibilitychange', handleActivity)
  window.addEventListener('focus', handleActivity)
  window.addEventListener('click', handleActivity)

  onAuthStateChanged(auth, (currentUser) => {
    clearSubscriptions()
    hasFetchedLiveScoresInitial = false
    
    // Clear all state to prevent memory leaks or data cross-contamination
    userProfile.value = null
    matches.value = []
    allGuesses.value = []
    predictionInputs.value = {}
    expandedMatches.value = {}
    collapsedDays.value = {}
    leaderboard.value = []
    adminScores.value = {}
    hasScrolledToCurrent.value = false
    
    user.value = currentUser
    if (currentUser) {
      initRealtimeData(currentUser)
      
      // Auto-open knockout scoring rules on load unless they checked "Don't show again"
      setTimeout(() => {
        if (localStorage.getItem('dontShowKnockoutRulesAgain') !== 'true') {
          showScoringRules()
        }
      }, 1200)
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('click', closeUserMenu)
  if (espnPollIntervalId) {
    clearInterval(espnPollIntervalId)
  }
  if (versionCheckIntervalId) {
    clearInterval(versionCheckIntervalId)
  }
  document.removeEventListener('visibilitychange', handleActivity)
  window.removeEventListener('focus', handleActivity)
  window.removeEventListener('click', handleActivity)
})

</script>

<template>
  <header v-if="user" class="app-header-bar">
    <div class="header-top-row">
      <div class="logo-group">
        <div class="logo-container">
          <span class="logo-icon">🏆</span>
          <h1>Roomie Bet</h1>
        </div>
        <p class="motto">World Cup 2026 Score Predictor</p>
      </div>
      
      <div class="user-bar">
        <div class="user-points" @click="handleLeaderboardTabClick">
          <span class="points-icon">🏆</span>
          <span class="points-val">{{ processedUserProfile?.points || 0 }}</span>
          <span class="points-label"> {{ (processedUserProfile?.points === 1) ? ' Point' : ' Points' }}</span>
        </div>
        
        <div class="user-menu-container" ref="userMenuRef" @click.stop>
          <div class="app-version-fixed">v{{ version }}</div>
          <button class="btn-avatar-menu" @click="toggleUserMenu">
            {{ processedUserProfile?.displayName?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase() }}
          </button>
          
          <div v-if="showUserMenu" class="user-dropdown-menu">
            <div class="dropdown-user-info">
              <span class="dropdown-user-name">{{ processedUserProfile?.displayName || 'User' }}</span>
              <span class="dropdown-user-email">{{ user.email }}</span>
            </div>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" @click="handleShowScoringRulesClick">
              <span>📋</span> Scoring Rules
            </button>
            <button class="dropdown-item" @click="handleShowVersionHistoryClick">
              <span>📜</span> Version History
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" @click="handleLogout">
              <span>🚪</span> Sign Out
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <nav class="tabs">
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'matches' }" 
        @click="handleMatchesTabClick"
      >
        ⚽ Matches
      </button>
      <button 
        class="tab-btn" 
        :class="{ active: activeTab === 'leaderboard' }" 
        @click="handleLeaderboardTabClick"
      >
        📊 Leaderboard
      </button>
      <button 
        v-if="user.email === 'mariuscm@gmail.com'" 
        class="tab-btn" 
        :class="{ active: activeTab === 'admin' }" 
        @click="handleAdminTabClick"
      >
        ⚙️ Admin
      </button>
    </nav>
  </header>

  <!-- Guest Header -->
  <header v-else class="guest-header">
    <div class="app-version-fixed">v{{ version }}</div>
    <div class="logo-container">
      <span class="logo-icon">🏆</span>
      <h1>Roomie Bet</h1>
    </div>
    <p>World Cup 2026 Score Predictor</p>
  </header>

  <!-- Authenticated App Dashboard -->
  <main v-if="user" style="flex: 1;">

    <!-- Success/Error Banners -->
    <div v-if="adminSuccess" class="alert-banner alert-success">
      <span>✔</span> {{ adminSuccess }}
    </div>
    <div v-if="adminError" class="alert-banner alert-error">
      <span>⚠</span> {{ adminError }}
    </div>

    <!-- Matches Content -->
    <section v-if="activeTab === 'matches'" class="matches-list">
      <!-- Group Stage History Toggle Link -->
      <div v-if="knockoutStageEnabled && processedMatches.length > 0" class="history-toggle-container" style="margin-bottom: 1.5rem; text-align: center; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); padding: 0.8rem; border-radius: var(--input-radius);">
        <a 
          href="#" 
          @click.prevent="showGroupMatchesHistory = !showGroupMatchesHistory"
          style="color: var(--primary); font-size: 0.9rem; text-decoration: none; font-weight: 500; display: inline-flex; align-items: center; gap: 0.35rem;"
        >
          <span>📁</span> {{ showGroupMatchesHistory ? 'Hide Group Stage Matches' : 'View Historical Group Matches Results & Predictions' }}
        </a>
      </div>

      <div v-if="processedMatches.length === 0" class="empty-state">
        <div class="empty-state-icon">📅</div>
        <p>No matches loaded yet. Ask the admin to seed the matches.</p>
      </div>

      <div v-for="group in groupedMatches" :key="group.day" :id="getGroupElementId(group.day)" class="match-date-group">
        <h2 class="date-group-header" @click="toggleDay(group.day)" style="cursor: pointer; user-select: none;">
          <span style="display: flex; align-items: center; gap: 0.5rem;">📅 {{ group.day }}</span>
          <span style="display: flex; align-items: center; gap: 0.75rem;">
            <span v-if="isDayAllCompleted(group)" class="completed-day-badge">Completed ✓</span>
            <span class="expand-arrow">{{ isDayCollapsed(group) ? '▶' : '▼' }}</span>
          </span>
        </h2>
        <div v-show="!isDayCollapsed(group)" class="date-group-cards">
          <div 
            v-for="match in group.matches" 
            :key="match.id" 
            :id="'match-' + match.id"
            class="match-card"
            :class="{
              completed: match.status === 'completed',
              'correct-guess': match.status === 'completed' && userGuesses[match.id]?.pointsEarned > 0,
              'incorrect-guess': match.status === 'completed' && userGuesses[match.id]?.pointsEarned === 0
            }"
          >
            <div class="match-header">
              <div class="match-date">
                <span>⏰</span> {{ formatTime(match.date) }}
              </div>
              <div 
                class="match-status"
                :class="{
                  'status-live': match.status === 'live',
                  'status-scheduled': match.status === 'scheduled',
                  'status-completed': match.status === 'completed'
                }"
              >
                <span v-if="match.status === 'live'" class="live-pulse-container">
                  <span class="live-pulse-dot"></span>
                  LIVE
                </span>
                <span v-else>{{ match.status }}</span>
              </div>
            </div>

            <div class="match-teams-grid">
              <div class="team home">
                <span v-if="!emojiToCountryCode(match.homeFlag)" class="team-flag">{{ match.homeFlag }}</span>
                <img v-else :src="`https://flagcdn.com/w40/${emojiToCountryCode(match.homeFlag)}.png`" :alt="match.homeTeam" class="team-flag-img" />
                <span class="team-name">{{ match.homeTeam }}</span>
              </div>
              
              <div class="score-versus">
                <div v-if="match.status === 'completed' || match.status === 'live'" class="official-score" :class="{ 'live-score': match.status === 'live' }">
                  <div>{{ match.homeScore !== null ? match.homeScore : 0 }} - {{ match.awayScore !== null ? match.awayScore : 0 }}</div>
                  <div v-if="match.stage === 'knockout' && match.homeScore120 !== null && match.homeScore120 === match.awayScore120 && match.shootoutWinner" style="font-size: 0.75rem; color: var(--accent); font-weight: 600; margin-top: 0.15rem; white-space: nowrap;">
                    ({{ match.homeShootoutScore }} - {{ match.awayShootoutScore }})
                  </div>
                </div>
                <div v-else class="vs">VS</div>
              </div>

              <div class="team away">
                <span class="team-name">{{ match.awayTeam }}</span>
                <span v-if="!emojiToCountryCode(match.awayFlag)" class="team-flag">{{ match.awayFlag }}</span>
                <img v-else :src="`https://flagcdn.com/w40/${emojiToCountryCode(match.awayFlag)}.png`" :alt="match.awayTeam" class="team-flag-img" />
              </div>
            </div>

            <!-- Guess inputs / points presentation -->
            <div class="prediction-box">
              <div class="prediction-label">
                {{ match.status === 'completed' ? 'Your Guess:' : 'Predict Score:' }}
              </div>
              
              <!-- Case 1: Match is completed -->
              <div v-if="match.status === 'completed'" class="prediction-badge">
                <span>
                  <span 
                    v-for="(seg, sIdx) in formatFriendPredictionSegments(userGuesses[match.id], match)" 
                    :key="sIdx"
                    :style="seg.isCorrect ? 'color: var(--accent); font-weight: 700;' : ''"
                    :class="{ 'text-muted': seg.isTextMuted }"
                  >
                    {{ seg.text }}
                  </span>
                </span>
                
                <span 
                  class="badge-points"
                  :class="{
                    'points-earned': userGuesses[match.id]?.pointsEarned > 0,
                    'points-missed': userGuesses[match.id]?.pointsEarned === 0,
                    'points-pending': !userGuesses[match.id] || userGuesses[match.id]?.pointsEarned === null || userGuesses[match.id]?.pointsEarned === undefined
                  }"
                >
                  {{ userGuesses[match.id]?.pointsEarned !== null && userGuesses[match.id]?.pointsEarned !== undefined ? (userGuesses[match.id]?.pointsEarned > 0 ? '+' + userGuesses[match.id]?.pointsEarned + ' Pts' : '0 Points') : 'Pending Lock 🔒' }}
                </span>
              </div>

              <!-- Case 2: Match is scheduled, but started/locked -->
              <div v-else-if="matchHasStarted(match.date)" class="prediction-badge">
                <span style="margin-right: 0.5rem;">
                  <span 
                    v-for="(seg, sIdx) in formatFriendPredictionSegments(userGuesses[match.id], match)" 
                    :key="sIdx"
                    :style="seg.isCorrect ? 'color: var(--accent); font-weight: 700;' : ''"
                    :class="{ 'text-muted': seg.isTextMuted }"
                  >
                    {{ seg.text }}
                  </span>
                </span>
                <span class="badge-points points-pending">Locked 🔒</span>
              </div>

              <!-- Case 3: Match is open for predictions -->
              <div v-else-if="predictionInputs[match.id]" class="prediction-inputs" style="flex-wrap: wrap;">
                <div v-if="match.stage === 'knockout' && typeof predictionInputs[match.id].homeGuess === 'number' && typeof predictionInputs[match.id].awayGuess === 'number' && predictionInputs[match.id].homeGuess === predictionInputs[match.id].awayGuess" style="font-size: 0.8rem; color: var(--accent); font-weight: 600; width: 100%; margin-bottom: 0.25rem;">
                  📋 Regular Time (90 mins) [+1 pt]:
                </div>
                 <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 1rem;">
                   <div style="display: flex; align-items: center; gap: 0.5rem;">
                     <input 
                       type="number" 
                       placeholder="Home" 
                       min="0" 
                       step="1"
                       v-model.number="predictionInputs[match.id].homeGuess"
                       @input="syncDefaultExtraTime(match.id)"
                     />
                     <span>-</span>
                     <input 
                       type="number" 
                       placeholder="Away" 
                       min="0" 
                       step="1"
                       v-model.number="predictionInputs[match.id].awayGuess"
                       @input="syncDefaultExtraTime(match.id)"
                     />
                   </div>
                   <button 
                     v-if="match.stage !== 'knockout' || typeof predictionInputs[match.id].homeGuess !== 'number' || typeof predictionInputs[match.id].awayGuess !== 'number' || predictionInputs[match.id].homeGuess !== predictionInputs[match.id].awayGuess"
                     class="btn" 
                     :class="{ 'btn-saved': isPredictionSaved(match.id) }"
                     style="width: auto; padding: 0.4rem 0.8rem; font-size: 0.85rem; margin: 0;"
                     @click="submitGuess(match.id)"
                     :disabled="predictionInputs[match.id].homeGuess === null || predictionInputs[match.id].awayGuess === null || predictionInputs[match.id].homeGuess === undefined || predictionInputs[match.id].awayGuess === undefined"
                   >
                     {{ isPredictionSaved(match.id) ? 'SAVED' : 'Save' }}
                   </button>
                 </div>

                <!-- Extra Time (120m) Prediction inputs -->
                <div v-if="match.stage === 'knockout' && typeof predictionInputs[match.id].homeGuess === 'number' && typeof predictionInputs[match.id].awayGuess === 'number' && predictionInputs[match.id].homeGuess === predictionInputs[match.id].awayGuess" style="display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 0.75rem; width: 100%;">
                  <div style="font-size: 0.8rem; color: var(--accent); font-weight: 600;">⚡ Extra Time (120 mins) [+1 pt]:</div>
                  <div style="display: flex; align-items: center; gap: 0.5rem;">
                    <input 
                      type="number" 
                      placeholder="Home" 
                      min="0" 
                      step="1"
                      v-model.number="predictionInputs[match.id].homeGuess120"
                      style="width: 80px;"
                    />
                    <span>-</span>
                    <input 
                      type="number" 
                      placeholder="Away" 
                      min="0" 
                      step="1"
                      v-model.number="predictionInputs[match.id].awayGuess120"
                      style="width: 80px;"
                    />
                  </div>
                  
                  <div v-if="predictionInputs[match.id].homeGuess120 !== null && predictionInputs[match.id].homeGuess120 !== '' && predictionInputs[match.id].awayGuess120 !== null && predictionInputs[match.id].awayGuess120 !== '' && !isExtraTimeValid(match.id)" style="font-size: 0.8rem; color: var(--danger); font-weight: 500; margin-top: 0.25rem;">
                    ⚠ Extra time scores must be whole numbers and cannot be less than 90 mins scores.
                  </div>
                  
                  <!-- Penalty Shootout Prediction inputs -->
                  <div v-if="isExtraTimeValid(match.id) && predictionInputs[match.id].homeGuess120 === predictionInputs[match.id].awayGuess120" style="display: flex; flex-direction: column; gap: 0.75rem; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 0.75rem;">
                    <div style="font-size: 0.8rem; color: var(--accent); font-weight: 600;">⚽ Penalty shootout winner [+0.5 pts]:</div>
                    <div style="display: flex; gap: 0.5rem;">
                      <button 
                        class="btn"
                        :class="predictionInputs[match.id].shootoutWinnerGuess === 'home' ? 'btn-primary' : 'btn-secondary'"
                        style="width: auto; flex: 1; padding: 0.4rem; font-size: 0.8rem;"
                        @click="predictionInputs[match.id].shootoutWinnerGuess = 'home'"
                      >
                        {{ match.homeTeam }}
                      </button>
                      <button 
                        class="btn"
                        :class="predictionInputs[match.id].shootoutWinnerGuess === 'away' ? 'btn-primary' : 'btn-secondary'"
                        style="width: auto; flex: 1; padding: 0.4rem; font-size: 0.8rem;"
                        @click="predictionInputs[match.id].shootoutWinnerGuess = 'away'"
                      >
                        {{ match.awayTeam }}
                      </button>
                    </div>
                    
                    <div style="font-size: 0.8rem; color: var(--accent); font-weight: 600; margin-top: 0.25rem;">🎯 Shootout score (Optional) [+1.5 pts]:</div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                      <input 
                        type="number" 
                        placeholder="Home" 
                        min="0" 
                        step="1"
                        v-model.number="predictionInputs[match.id].homeShootoutGuess"
                        style="width: 80px;"
                      />
                      <span>-</span>
                      <input 
                        type="number" 
                        placeholder="Away" 
                        min="0" 
                        step="1"
                        v-model.number="predictionInputs[match.id].awayShootoutGuess"
                        style="width: 80px;"
                      />
                    </div>
                  </div>
                </div>
                
                <!-- Bottom Save & Clear Buttons for Knockout Draws -->
                <div v-if="match.stage === 'knockout' && typeof predictionInputs[match.id].homeGuess === 'number' && typeof predictionInputs[match.id].awayGuess === 'number' && predictionInputs[match.id].homeGuess === predictionInputs[match.id].awayGuess" style="width: 100%; margin-top: 0.75rem; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 0.75rem;">
                  
                  <!-- Normal Buttons -->
                  <div v-if="!showClearConfirm[match.id]" style="display: flex; justify-content: flex-end; gap: 0.5rem;">
                    <button 
                      v-if="userGuesses[match.id] || (predictionInputs[match.id] && predictionInputs[match.id].homeGuess !== null && predictionInputs[match.id].homeGuess !== '')"
                      type="button"
                      class="btn btn-secondary"
                      style="width: auto; padding: 0.4rem 1.2rem; font-size: 0.85rem;"
                      @click.stop.prevent="triggerClearConfirm(match.id, true)"
                    >
                      Clear
                    </button>
                    <button 
                      class="btn" 
                      :class="{ 'btn-saved': isPredictionSaved(match.id) }"
                      style="width: auto; padding: 0.4rem 1.2rem; font-size: 0.85rem;"
                      @click="submitGuess(match.id)"
                      :disabled="predictionInputs[match.id].homeGuess === null || predictionInputs[match.id].awayGuess === null || predictionInputs[match.id].homeGuess === undefined || predictionInputs[match.id].awayGuess === undefined"
                    >
                      {{ isPredictionSaved(match.id) ? 'SAVED' : 'Save' }}
                    </button>
                  </div>

                  <!-- Inline Confirmation Warning -->
                  <div v-else class="local-slide-in" style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 77, 109, 0.08); border: 1px solid rgba(255, 77, 109, 0.2); padding: 0.5rem 0.75rem; border-radius: var(--btn-radius);">
                    <span style="font-size: 0.8rem; color: var(--danger); font-weight: 500;">
                      Clear predictions?
                    </span>
                    <div style="display: flex; gap: 0.4rem;">
                      <button 
                        type="button"
                        class="btn btn-danger"
                        style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.8rem; background: var(--danger); border-color: var(--danger); color: white;"
                        @click.stop.prevent="clearGuess(match.id)"
                      >
                        Yes, Clear
                      </button>
                      <button 
                        type="button"
                        class="btn btn-secondary"
                        style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.8rem;"
                        @click.stop.prevent="triggerClearConfirm(match.id, false)"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>

                </div>
              </div>
              <div v-else class="prediction-badge">
                <span class="badge-points points-pending">Loading...</span>
              </div>
            </div>

            <!-- Friends' Predictions List (Expandable after match start) -->
            <div v-if="matchHasStarted(match.date)" class="other-predictions-section">
              <button 
                class="btn btn-secondary btn-toggle-predictions" 
                @click="expandedMatches[match.id] = !expandedMatches[match.id]"
              >
                👥 {{ expandedMatches[match.id] ? 'Hide' : 'Show' }} Other Predictions ({{ getOtherGuessesCount(match.id) }})
              </button>
              
              <div v-if="expandedMatches[match.id]" class="predictions-expanded-list">
                <div 
                  v-for="pred in getGuessesForMatch(match.id)" 
                  :key="pred.uid" 
                  class="prediction-row-item"
                  :class="{ 'highlight-user': pred.uid === user.uid }"
                >
                  <span class="pred-player-name">
                    {{ pred.playerName }} <span v-if="pred.uid === user.uid" class="current-user-tag">You</span>
                  </span>
                  <span class="pred-player-score" :class="{ 'text-muted': pred.homeGuess === undefined || pred.homeGuess === null }">
                    <span 
                      v-for="(seg, sIdx) in formatFriendPredictionSegments(pred, match)" 
                      :key="sIdx"
                      :style="seg.isCorrect ? 'color: var(--accent); font-weight: 700;' : ''"
                    >
                      {{ seg.text }}
                    </span>
                    <span 
                      v-if="match.status === 'completed' && pred.homeGuess !== undefined && pred.homeGuess !== null" 
                      class="mini-points-badge"
                      :class="{
                        'earned': pred.pointsEarned > 0,
                        'missed': pred.pointsEarned === 0,
                        'pending': pred.pointsEarned === null || pred.pointsEarned === undefined
                      }"
                    >
                      {{ pred.pointsEarned !== null && pred.pointsEarned !== undefined ? (pred.pointsEarned > 0 ? '+' + pred.pointsEarned : '0') : '⏳' }}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Leaderboard Content -->
    <section v-if="activeTab === 'leaderboard'" class="leaderboard-card">
      <h2 style="font-family: var(--font-display); font-size: 1.5rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
        📊 Leaderboard
      </h2>
      <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1.5rem;">
        Ranking updated in real-time as scores are locked.
      </p>

      <!-- Leaderboard Filter Tabs -->
      <div v-if="knockoutStageEnabled" class="admin-sub-tabs" style="margin-bottom: 1.5rem;">
        <button 
          class="sub-tab-btn" 
          :class="{ active: leaderboardFilter === 'overall' }" 
          @click="leaderboardFilter = 'overall'"
        >
          🏆 Overall
        </button>
        <button 
          class="sub-tab-btn" 
          :class="{ active: leaderboardFilter === 'group' }" 
          @click="leaderboardFilter = 'group'"
        >
          📋 Group Stage
        </button>
        <button 
          class="sub-tab-btn" 
          :class="{ active: leaderboardFilter === 'knockout' }" 
          @click="leaderboardFilter = 'knockout'"
        >
          ⚡ Knockout Stage
        </button>
      </div>
      
      <!-- Pending Lock Notice -->
      <div v-if="pendingCompletedMatches.length > 0" style="margin-bottom: 1.5rem; padding: 0.75rem 1rem; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 8px; color: #fbbf24; font-size: 0.85rem; display: flex; align-items: center; gap: 0.6rem; line-height: 1.4;">
        <span style="font-size: 1.1rem; line-height: 1;">⏳</span>
        <div>
          <span style="font-weight: 700;">Score sync pending:</span> 
          Some match results are finished but not yet officially locked. Leaderboard scores are not final.
        </div>
      </div>

      <table class="leaderboard-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th style="text-align: right;">Points</th>
          </tr>
        </thead>
        <tbody>
          <tr 
            v-for="(player, idx) in processedLeaderboard" 
            :key="player.uid" 
            class="leaderboard-row"
          >
            <td class="rank-cell">
              <span 
                class="rank-badge"
                :class="{
                  'rank-1': getPlayerRank(player) === 1,
                  'rank-2': getPlayerRank(player) === 2,
                  'rank-3': getPlayerRank(player) === 3,
                  'rank-other': getPlayerRank(player) > 3
                }"
              >
                {{ getPlayerRank(player) }}
              </span>
            </td>
            <td class="name-cell">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span>{{ player.displayName }}</span>
                <span v-if="player.uid === user.uid" class="current-user-tag">You</span>
              </div>
              <div v-if="knockoutStageEnabled" style="font-size: 0.72rem; color: var(--text-muted); margin-top: 0.1rem; opacity: 0.85; font-weight: normal;">
                Grp. {{ player.groupPointsDisplay }} | K.O. {{ player.knockoutPointsDisplay }}
              </div>
            </td>
            <td class="points-cell">
              <span v-if="leaderboardFilter === 'group'">{{ player.groupPointsDisplay }}</span>
              <span v-else-if="leaderboardFilter === 'knockout'">{{ player.knockoutPointsDisplay }}</span>
              <span v-else>{{ player.pointsDisplay }}</span>
              <span v-if="pendingCompletedMatches.length > 0" title="Pending official lock" style="margin-left: 0.35rem; font-size: 0.8rem; opacity: 0.75;">⏳</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Admin Panel (Only visible to mariuscm@gmail.com) -->
    <section v-if="activeTab === 'admin' && user.email === 'mariuscm@gmail.com'">
      <!-- Admin Sub-navigation -->
      <div class="admin-sub-tabs">
        <button 
          class="sub-tab-btn" 
          :class="{ active: activeAdminSubTab === 'users' }" 
          @click="activeAdminSubTab = 'users'"
        >
          👥 Users
        </button>
        <button 
          class="sub-tab-btn" 
          :class="{ active: activeAdminSubTab === 'scores' }" 
          @click="activeAdminSubTab = 'scores'"
        >
          🔒 Lock Scores
        </button>
        <button 
          class="sub-tab-btn" 
          :class="{ active: activeAdminSubTab === 'setup' }" 
          @click="activeAdminSubTab = 'setup'"
        >
          ⚙️ Database Setup
        </button>
      </div>

      <!-- Manage Users Card -->
      <div v-if="activeAdminSubTab === 'users'" class="admin-card">
        <h3>👥 Manage Users & Leaderboard Visibility</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
          Enable or disable users. Disabled users are hidden from the leaderboard and grading calculations.
        </p>
        <div style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 500px; overflow-y: auto; padding-right: 0.25rem;">
          <div v-for="player in leaderboard" :key="player.uid" style="display: flex; align-items: center; justify-content: space-between; padding: 0.65rem 0.85rem; background: rgba(255,255,255,0.02); border-radius: var(--input-radius); border: 1px solid rgba(255,255,255,0.05); gap: 1rem;">
            <div style="display: flex; flex-direction: column; gap: 0.15rem; min-width: 0;">
              <span style="font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                {{ player.displayName || 'User' }}
                <span v-if="player.disabled" style="font-size: 0.75rem; color: var(--danger); font-weight: 500; margin-left: 0.35rem;">(Disabled)</span>
              </span>
              <span style="font-size: 0.75rem; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">{{ player.email }}</span>
            </div>
            <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
              <button 
                class="btn" 
                :class="player.disabled ? 'btn-secondary' : 'btn-danger'" 
                style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.8rem;" 
                @click="toggleUserDisabledState(player.uid, player.disabled)"
              >
                {{ player.disabled ? 'Enable' : 'Disable' }}
              </button>
              <button 
                class="btn btn-secondary" 
                style="width: auto; padding: 0.35rem 0.75rem; font-size: 0.8rem; border-color: rgba(255, 77, 109, 0.3); color: var(--danger);" 
                @click="deleteUserData(player.uid)"
              >
                Delete 🗑
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Manage Matches Score Locker -->
      <div v-if="activeAdminSubTab === 'scores'" class="admin-card">
        <h3>🔒 Manage Matches & Lock Scores</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1.5rem;">
          Input final scorelines and lock them. This evaluates all guesses and rewards points.
        </p>

        <div class="matches-list">
          <div v-for="match in matches" :key="match.id" class="match-card" style="background: rgba(0,0,0,0.15)">
            <div class="match-header">
              <div>📅 {{ formatDate(match.date) }}</div>
              <div>{{ match.status }}</div>
            </div>

            <div class="match-teams-grid">
              <div class="team home">
                <span v-if="!emojiToCountryCode(match.homeFlag)" class="team-flag">{{ match.homeFlag }}</span>
                <img v-else :src="`https://flagcdn.com/w40/${emojiToCountryCode(match.homeFlag)}.png`" :alt="match.homeTeam" class="team-flag-img" />
                <span class="team-name">{{ match.homeTeam }}</span>
              </div>
              <div class="score-versus">VS</div>
              <div class="team away">
                <span class="team-name">{{ match.awayTeam }}</span>
                <span v-if="!emojiToCountryCode(match.awayFlag)" class="team-flag">{{ match.awayFlag }}</span>
                <img v-else :src="`https://flagcdn.com/w40/${emojiToCountryCode(match.awayFlag)}.png`" :alt="match.awayTeam" class="team-flag-img" />
              </div>
            </div>

            <!-- Score locker forms -->
            <div style="border-top: 1px solid rgba(255,255,255,0.05); padding-top: 1rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
              <div v-if="match.status === 'completed'" style="display: flex; align-items: center; gap: 1rem;">
                <span style="font-weight: 700; color: var(--accent);">Score: {{ match.homeScore }} - {{ match.awayScore }}</span>
                <button class="btn btn-secondary" style="width: auto; padding: 0.3rem 0.6rem; font-size: 0.8rem;" @click="resetMatch(match.id)">
                  Reset Score 🔓
                </button>
              </div>
              
              <div v-else style="width: 100%; display: flex; flex-direction: column; gap: 0.75rem;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
                  <div style="display: flex; align-items: center; gap: 0.25rem;">
                    <label style="font-size: 0.8rem; color: var(--text-secondary); margin-right: 0.5rem;">Final Score:</label>
                    <input type="number" min="0" max="15" step="1" placeholder="Home" style="width: 60px; text-align: center;" v-model="adminScores[match.id].homeScore" />
                    <span style="color: var(--text-muted)">-</span>
                    <input type="number" min="0" max="15" step="1" placeholder="Away" style="width: 60px; text-align: center;" v-model="adminScores[match.id].awayScore" />
                  </div>
                  
                  <button class="btn" style="width: auto; padding: 0.4rem 0.8rem; font-size: 0.85rem;" @click="completeMatch(match.id)">
                    Lock Score & Rank
                  </button>
                </div>
                
                <!-- Knockout overrides for admin -->
                <div v-if="match.stage === 'knockout'" style="border-top: 1px solid rgba(255,255,255,0.05); padding-top: 0.5rem; display: flex; flex-direction: column; gap: 0.5rem;">
                  <div style="font-size: 0.75rem; color: var(--accent); font-weight: 600;">Knockout Details Override (Optional):</div>
                  <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
                    <div style="display: flex; align-items: center; gap: 0.25rem;">
                      <label style="font-size: 0.75rem; color: var(--text-muted); width: 60px;">90 Mins:</label>
                      <input type="number" min="0" max="15" step="1" placeholder="Home 90" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].homeScore90" />
                      <span>-</span>
                      <input type="number" min="0" max="15" step="1" placeholder="Away 90" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].awayScore90" />
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.25rem;">
                      <label style="font-size: 0.75rem; color: var(--text-muted); width: 60px;">120 Mins:</label>
                      <input type="number" min="0" max="15" step="1" placeholder="Home 120" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].homeScore120" />
                      <span>-</span>
                      <input type="number" min="0" max="15" step="1" placeholder="Away 120" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].awayScore120" />
                    </div>
                  </div>
                  <div v-if="showShootoutInputs(match.id)" style="display: flex; flex-direction: column; gap: 0.35rem;">
                    <div style="display: flex; align-items: center; gap: 0.25rem;">
                      <label style="font-size: 0.75rem; color: var(--text-muted); width: 60px;">Shootout:</label>
                      <input type="number" min="0" max="15" step="1" placeholder="Pens H" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].homeShootoutScore" />
                      <span>-</span>
                      <input type="number" min="0" max="15" step="1" placeholder="Pens A" style="width: 50px; text-align: center; font-size: 0.75rem; padding: 0.25rem;" v-model="adminScores[match.id].awayShootoutScore" />
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.5rem;">
                      <label style="font-size: 0.75rem; color: var(--text-muted);">Winner:</label>
                      <select v-model="adminScores[match.id].shootoutWinner" style="font-size: 0.75rem; padding: 0.2rem; background: rgba(0,0,0,0.5); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;">
                        <option value="">-- Select Winner --</option>
                        <option value="home">{{ match.homeTeam }}</option>
                        <option value="away">{{ match.awayTeam }}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add New Match -->
      <div v-if="activeAdminSubTab === 'setup'" class="admin-card">
        <h3>➕ Add Custom Match</h3>
        <form @submit.prevent="addMatch" style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="form-row">
            <div class="form-group">
              <label>Home Team</label>
              <input type="text" v-model="newHomeTeam" placeholder="e.g. France" required />
            </div>
            <div class="form-group">
              <label>Away Team</label>
              <input type="text" v-model="newAwayTeam" placeholder="e.g. Italy" required />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Home Team Flag (Emoji)</label>
              <input type="text" v-model="newHomeFlag" placeholder="e.g. 🇫🇷" style="text-align: center;" />
            </div>
            <div class="form-group">
              <label>Away Team Flag (Emoji)</label>
              <input type="text" v-model="newAwayFlag" placeholder="e.g. 🇮🇹" style="text-align: center;" />
            </div>
          </div>
          <div class="form-group">
            <label>Kickoff Date & Time (Local Timezone)</label>
            <input type="datetime-local" v-model="newMatchDate" required />
          </div>
          <button type="submit" class="btn">Add Match</button>
        </form>
      </div>

      <!-- Knockout Stage Control -->
      <div v-if="activeAdminSubTab === 'setup'" class="admin-card">
        <h3>🏆 Knockout Stage Control</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1.25rem;">
          Toggle visibility of the Round of 32 knockout matches and split leaderboards.
        </p>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 1rem; background: rgba(255,255,255,0.03); border-radius: var(--input-radius); border: 1px solid rgba(255,255,255,0.05);">
          <div>
            <span style="font-weight: 600; display: block;">Knockout Stage Features</span>
            <span style="font-size: 0.8rem; color: var(--text-muted);">
              {{ knockoutStageEnabled ? 'Visible to players' : 'Hidden from players' }}
            </span>
          </div>
          <label class="switch-control">
            <input 
              type="checkbox" 
              :checked="knockoutStageEnabled" 
              @change="toggleKnockoutStage" 
            />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>

      <!-- Seed Database Panel -->
      <div v-if="activeAdminSubTab === 'setup'" class="admin-card">
        <h3>🌱 Database Seeding</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
          Populate or overwrite the database with group stage matches, or migrate to the Round of 32.
        </p>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <button class="btn btn-secondary" @click="seedDatabase" style="width: auto; margin-bottom: 0;">
            Seed Group Stage Matches (June 19+)
          </button>
          <button class="btn btn-secondary" @click="seedRoundOf32Matches" style="width: auto; background: var(--primary-glow); color: var(--primary); border-color: rgba(0, 245, 155, 0.3); margin-bottom: 0;">
            ⚡ Seed Round of 32 Matches & Migrate Users
          </button>
        </div>
        <span style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
          Note: Seeding Round of 32 will preserve and copy current scores to group stage points, and append the 16 knockout matches safely.
        </span>
      </div>

      <!-- Friends' Predictions Layout Testing Panel -->
      <div v-if="activeAdminSubTab === 'setup'" class="admin-card">
        <h3>🧪 Friends' Predictions Layout Testing</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
          Generate a dummy knockout match in the past with multiple fake friend predictions to test the list rendering layout and points display on mobile and desktop.
        </p>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary" @click.stop.prevent="seedTestFriendPredictions" style="width: auto; margin-bottom: 0;">
            Seed Test Match & Predictions
          </button>
          <button type="button" class="btn btn-danger" @click.stop.prevent="cleanTestData" style="width: auto; background: var(--danger); border-color: var(--danger); margin-bottom: 0; display: flex; align-items: center; gap: 0.25rem;">
            🗑️ Remove Test Data
          </button>
        </div>
      </div>
    </section>
  </main>

  <!-- Guest / Auth screens -->
  <main v-else class="auth-container">
    <div class="glass-card">
      <div class="auth-header">
        <h2>{{ isForgotPassword ? 'Reset Password' : (isLogin ? 'Welcome Back!' : 'Create Account') }}</h2>
        <p>{{ isForgotPassword ? 'Enter your email to receive a password reset link' : (isLogin ? 'Sign in to place your score predictions' : 'Register to play with your roommates') }}</p>
      </div>

      <div v-if="authError" class="alert-banner alert-error">
        <span>⚠</span> {{ authError }}
      </div>

      <div v-if="authSuccess" class="alert-banner alert-success">
        <span>✔</span> {{ authSuccess }}
      </div>

      <!-- Forgot Password Form -->
      <form v-if="isForgotPassword" @submit.prevent="handleResetPassword" style="display: flex; flex-direction: column; gap: 0.5rem;">
        <div class="form-group">
          <label>Email Address</label>
          <input type="email" v-model="email" placeholder="you@example.com" required />
        </div>

        <button type="submit" class="btn" :disabled="authLoading" style="margin-top: 1rem;">
          {{ authLoading ? 'Sending...' : 'Send Reset Link' }}
        </button>
      </form>

      <!-- Sign In / Sign Up Form -->
      <form v-else @submit.prevent="handleAuth" style="display: flex; flex-direction: column; gap: 0.5rem;">
        <div v-if="!isLogin" class="form-group">
          <label>Display Name</label>
          <input type="text" v-model="displayName" placeholder="e.g. John Doe" required />
        </div>

        <div class="form-group">
          <label>Email Address</label>
          <input type="email" v-model="email" placeholder="you@example.com" required />
        </div>

        <div class="form-group">
          <label>Password</label>
          <input type="password" v-model="password" placeholder="••••••••" required />
        </div>

        <button type="submit" class="btn" :disabled="authLoading" style="margin-top: 1rem;">
          {{ authLoading ? 'Processing...' : (isLogin ? 'Sign In' : 'Sign Up') }}
        </button>
      </form>

      <div class="auth-footer">
        <div v-if="isForgotPassword">
          <a href="#" @click.prevent="isForgotPassword = false; isLogin = true; authError = ''; authSuccess = '';">Back to Sign In</a>
        </div>
        <div v-else style="display: flex; flex-direction: column; gap: 0.5rem; align-items: center;">
          <span v-if="isLogin">
            Don't have an account? 
            <a href="#" @click.prevent="isLogin = false; authError = ''; authSuccess = '';">Create one here</a>
          </span>
          <span v-else>
            Already have an account? 
            <a href="#" @click.prevent="isLogin = true; authError = ''; authSuccess = '';">Sign in here</a>
          </span>
          <span v-if="isLogin" style="margin-top: 0.25rem;">
            <a href="#" @click.prevent="isForgotPassword = true; authError = ''; authSuccess = '';">Forgot Password?</a>
          </span>
        </div>
      </div>
    </div>
  </main>

  <!-- Localhost Simulation Control Panel -->
  <div v-if="isLocalhost && user" class="local-simulator-card">
    <h4>⚙️ Local Sandbox Simulator</h4>
    <p>Simulate a live match in-memory to test styling, live score pulsing, and points calculation without database writes.</p>
    <div v-if="isSimulating" class="local-simulator-status">
      {{ simulatorMessage }}
    </div>
    <div class="local-simulator-actions">
      <button v-if="!isSimulating" class="btn simulator-btn" @click="startSimulation">
        ▶ Start Live Simulation
      </button>
      <button v-else class="btn btn-secondary simulator-btn" @click="stopSimulation">
        ⏹ Stop Simulation
      </button>
    </div>
  </div>

  <!-- Native Dialog Modal for Scoring Rules -->
  <dialog 
    id="scoring-rules-dialog" 
    ref="scoringRulesDialogRef"
    closedby="any"
    class="premium-dialog"
    @click="handleDialogBackdropClick"
  >
    <div class="dialog-content">
      <div class="dialog-header">
        <h3>🏆 Scoring Rules</h3>
        <button type="button" class="close-btn" @click="closeScoringRules">✕</button>
      </div>
      
      <div class="dialog-body">
        <section class="rules-section">
          <h4>⚡ Knockout Stage Scoring</h4>
          <p class="rules-intro">Since knockout matches must have a winner, the scoring accumulates across stages:</p>
          
          <div class="timeline-rule">
            <div class="rule-point">
              <span class="rule-badge">+1.0 Pt</span>
              <div>
                <strong>Regular Time (90 mins)</strong>
                <p>Awarded for matching the exact score at the end of regulation time.</p>
              </div>
            </div>

            <div class="rule-point">
              <span class="rule-badge">+1.0 Pt</span>
              <div>
                <strong>Extra Time (120 mins)</strong>
                <p>If the match is a draw at the end of regulation time, you predict the score after extra time. Correct exact score earns +1.0 pt.</p>
              </div>
            </div>

            <div class="rule-point">
              <span class="rule-badge">+0.5 Pts</span>
              <div>
                <strong>Penalty Shootout Winner</strong>
                <p>If the match is a draw after extra time, you predict the shootout winner. Correct selection earns +0.5 pts.</p>
              </div>
            </div>

            <div class="rule-point">
              <span class="rule-badge">+1.5 Pts</span>
              <div>
                <strong>Penalty Shootout Score</strong>
                <p>If the match goes to a shootout, matching the exact penalties score (e.g., 5-4) earns +1.5 pts.</p>
              </div>
            </div>
          </div>
          
          <p class="rules-note">
            💡 <em>Note: If you predict a decisive win in regular time (e.g. 3-1), the extra-time and shootout inputs are bypassed since they won't occur.</em>
          </p>
        </section>

        <!-- Availability notice -->
        <p class="rules-menu-note" style="margin-top: 1rem; font-size: 0.82rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.35rem; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 0.75rem;">
          ℹ️ <em>You can access these rules anytime from your user menu in the top right.</em>
        </p>
      </div>

      <div class="dialog-footer" style="justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;">
        <label style="display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: var(--text-secondary); cursor: pointer; user-select: none; margin: 0;">
          <input type="checkbox" v-model="dontShowRulesAgain" style="width: 16px; height: 16px; margin: 0; cursor: pointer;" />
          Don't show again
        </label>
      </div>
    </div>
  </dialog>

  <!-- Native Dialog Modal for Version History -->
  <dialog 
    id="version-history-dialog" 
    ref="versionHistoryDialogRef"
    closedby="any"
    class="premium-dialog"
    @click="handleVersionHistoryBackdropClick"
  >
    <div class="dialog-content">
      <div class="dialog-header">
        <h3>📜 Version History</h3>
        <button type="button" class="close-btn" @click="closeVersionHistory">✕</button>
      </div>
      
      <div class="dialog-body" style="padding: 1.5rem 1.75rem;">
        <div class="version-history-list" style="display: flex; flex-direction: column; gap: 0.5rem;">
          <div 
            v-for="(item, idx) in formattedChangelog" 
            :key="idx"
            :class="{ 
              'version-header-row': item.isHeader, 
              'version-bullet-row': !item.isHeader 
            }"
            :style="item.isHeader ? 'font-family: var(--font-display); font-weight: 700; color: var(--primary); font-size: 1.05rem; margin-top: 0.75rem; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 0.25rem;' : 'font-size: 0.88rem; color: var(--text-secondary); line-height: 1.4; padding-left: 1rem; position: relative; margin-bottom: 0.25rem;'"
          >
            <span v-if="!item.isHeader" style="position: absolute; left: 0; color: var(--accent);">•</span>
            {{ item.text }}
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button type="button" class="btn btn-secondary" @click="closeVersionHistory" style="width: auto; padding: 0.5rem 1.25rem; margin: 0;">Close</button>
      </div>
    </div>
  </dialog>

  <!-- Update Notification Toast -->
  <div v-if="showUpdateBanner" class="update-toast" :class="{ 'expanded': showChangelog }">
    <div class="update-toast-main">
      <div class="update-toast-content">
        <div class="update-toast-title">
          <span class="update-toast-sparkle">✨</span>
          New Version Available!
        </div>
        <div class="update-toast-desc">
          v{{ remoteVersion }} is ready. 
          <a v-if="latestRemoteChangelog.length > 0" href="#" class="changelog-toggle" @click.prevent="showChangelog = !showChangelog">
            {{ showChangelog ? 'Hide changes ▴' : 'Show changes ▾' }}
          </a>
        </div>
      </div>
      <button class="update-toast-btn" @click="triggerReload">
        Reload Now
      </button>
    </div>

    <!-- Collapsible Changelog List (Only latest remote version changes) -->
    <div v-if="showChangelog && latestRemoteChangelog.length > 0" class="update-toast-changelog">
      <ul>
        <li v-for="(change, idx) in latestRemoteChangelog" :key="idx">
          {{ change }}
        </li>
      </ul>
    </div>
  </div>
</template>

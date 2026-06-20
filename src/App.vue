<script setup>
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { version } from '../package.json'
import { auth, db } from './firebase'
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  updateProfile
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
const collapsedDays = ref({})
const hasScrolledToCurrent = ref(false)
const activeTab = ref('matches') // 'matches' | 'leaderboard' | 'admin'

const showUserMenu = ref(false)
const userMenuRef = ref(null)

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

const processedMatches = computed(() => {
  if (!isSimulating.value || !simulatedMatchId.value) {
    return matches.value
  }
  return matches.value.map(match => {
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
})

const processedUserProfile = computed(() => {
  if (!userProfile.value) return null
  if (!isSimulating.value || !simulatedMatchId.value || simulatedStatus.value !== 'completed') {
    return userProfile.value
  }
  const guess = userGuesses.value[simulatedMatchId.value]
  const isCorrect = guess && Number(guess.homeGuess) === Number(simulatedHomeScore.value) && Number(guess.awayGuess) === Number(simulatedAwayScore.value)
  if (isCorrect) {
    return {
      ...userProfile.value,
      points: (userProfile.value.points || 0) + 1
    }
  }
  return userProfile.value
})

const processedLeaderboard = computed(() => {
  if (!isSimulating.value || !simulatedMatchId.value || simulatedStatus.value !== 'completed') {
    return leaderboard.value
  }
  const targetId = simulatedMatchId.value
  const homeFinal = Number(simulatedHomeScore.value)
  const awayFinal = Number(simulatedAwayScore.value)
  
  return leaderboard.value.map(player => {
    const guess = allGuesses.value.find(g => g.matchId === targetId && g.userId === player.uid)
    const isCorrect = guess && Number(guess.homeGuess) === homeFinal && Number(guess.awayGuess) === awayFinal
    if (isCorrect) {
      return {
        ...player,
        points: (player.points || 0) + 1
      }
    }
    return player
  }).sort((a, b) => (b.points || 0) - (a.points || 0))
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

// Computed userGuesses for points/badge rendering
const userGuesses = computed(() => {
  const guessesObj = {}
  processedMatches.value.forEach(match => {
    guessesObj[match.id] = { homeGuess: null, awayGuess: null, pointsEarned: null }
  })
  allGuesses.value.forEach(guess => {
    if (guess.userId === user.value?.uid) {
      guessesObj[guess.matchId] = guess
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
  const homeFinal = Number(simulatedHomeScore.value)
  const awayFinal = Number(simulatedAwayScore.value)
  
  return finalLeaderboard
    .filter(player => player.uid !== user.value?.uid)
    .map(player => {
      const guess = allGuesses.value.find(g => g.matchId === matchId && g.userId === player.uid)
      let pointsEarned = guess?.pointsEarned
      if (isSimulating.value && matchId === simulatedMatchId.value && simulatedStatus.value === 'completed') {
        const isCorrect = guess && Number(guess.homeGuess) === homeFinal && Number(guess.awayGuess) === awayFinal
        pointsEarned = isCorrect ? 1 : 0
      }
      
      return {
        uid: player.uid,
        playerName: player.displayName,
        homeGuess: guess?.homeGuess,
        awayGuess: guess?.awayGuess,
        pointsEarned: pointsEarned
      }
    })
}

const getOtherGuessesCount = (matchId) => {
  return allGuesses.value.filter(g => g.matchId === matchId && g.userId !== user.value?.uid).length
}

const getPlayerRank = (player) => {
  const points = player.points || 0
  const higherCount = processedLeaderboard.value.filter(p => (p.points || 0) > points).length
  return higherCount + 1
}


const isPredictionSaved = (matchId) => {
  const guess = userGuesses.value[matchId]
  const input = predictionInputs.value[matchId]
  if (!guess || !input) return false
  if (guess.homeGuess === null || guess.awayGuess === null || guess.homeGuess === undefined || guess.awayGuess === undefined) return false
  if (input.homeGuess === null || input.awayGuess === null || input.homeGuess === undefined || input.awayGuess === undefined) return false
  return Number(guess.homeGuess) === Number(input.homeGuess) && Number(guess.awayGuess) === Number(input.awayGuess)
}

watch(matches, (newMatches) => {
  newMatches.forEach(match => {
    if (!predictionInputs.value[match.id]) {
      predictionInputs.value[match.id] = { homeGuess: null, awayGuess: null }
    }
  })
}, { deep: true })

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
  processedMatches.value.forEach(match => {
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
  nextTick(() => {
    setTimeout(() => {
      scrollToCurrentDay()
    }, 150)
  })
}

// Auth Form State
const isLogin = ref(true)
const email = ref('')
const password = ref('')
const displayName = ref('')
const authError = ref('')
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
        points: 0
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

// User Guesses Submission
const submitGuess = async (matchId) => {
  const guess = predictionInputs.value[matchId]
  if (!guess || guess.homeGuess === undefined || guess.awayGuess === undefined || guess.homeGuess === null || guess.awayGuess === null) {
    return
  }
  
  const homeVal = parseFloat(guess.homeGuess)
  const awayVal = parseFloat(guess.awayGuess)
  
  if (!Number.isInteger(homeVal) || !Number.isInteger(awayVal) || homeVal < 0 || homeVal > 15 || awayVal < 0 || awayVal > 15) {
    adminError.value = 'Predictions must be whole numbers between 0 and 15.'
    setTimeout(() => adminError.value = '', 4000)
    return
  }
  
  try {
    const guessId = `${user.value.uid}_${matchId}`
    await setDoc(doc(db, 'guesses', guessId), {
      userId: user.value.uid,
      matchId: matchId,
      homeGuess: parseInt(guess.homeGuess),
      awayGuess: parseInt(guess.awayGuess),
      pointsEarned: null,
      submittedAt: Timestamp.now()
    })
    // Local confirmation
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

// Seed Database
const seedDatabase = async () => {
  adminError.value = ''
  adminSuccess.value = ''
  try {
    const batch = writeBatch(db)
    
    // 1. Delete all existing matches
    const matchesSnap = await getDocs(collection(db, 'matches'))
    matchesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })

    // 2. Delete all existing guesses to avoid inconsistencies
    const guessesSnap = await getDocs(collection(db, 'guesses'))
    guessesSnap.docs.forEach((doc) => {
      batch.delete(doc.ref)
    })

    // 3. Reset all user scores to 0
    const usersSnap = await getDocs(collection(db, 'users'))
    usersSnap.docs.forEach((uDoc) => {
      batch.update(uDoc.ref, { points: 0 })
    })

    // 4. Seed new matches
    defaultMatches.forEach((match) => {
      const matchRef = doc(collection(db, 'matches'))
      batch.set(matchRef, match)
    })

    await batch.commit()
    adminSuccess.value = 'Database re-seeded with matches starting June 19!'
  } catch (err) {
    adminError.value = err.message
  }
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

  const homeScoreVal = parseFloat(score.homeScore)
  const awayScoreVal = parseFloat(score.awayScore)

  if (!Number.isInteger(homeScoreVal) || !Number.isInteger(awayScoreVal) || homeScoreVal < 0 || homeScoreVal > 15 || awayScoreVal < 0 || awayScoreVal > 15) {
    adminError.value = 'Scores must be whole numbers between 0 and 15.'
    return
  }

  try {

    const batch = writeBatch(db)

    // 1. Update Match status and scores
    batch.update(doc(db, 'matches', matchId), {
      status: 'completed',
      homeScore: homeScoreVal,
      awayScore: awayScoreVal
    })

    // 2. Fetch all guesses for this match
    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('matchId', '==', matchId)))
    
    // 3. Score each guess and increment user's leaderboard points
    for (const guessDoc of guessesSnap.docs) {
      const guessData = guessDoc.data()
      const isCorrect = guessData.homeGuess === homeScoreVal && guessData.awayGuess === awayScoreVal
      const pointsEarned = isCorrect ? 1 : 0

      // Update guess record
      batch.update(doc(db, 'guesses', guessDoc.id), { pointsEarned })

      // Increment user points if correct
      if (isCorrect) {
        batch.update(doc(db, 'users', guessData.userId), {
          points: increment(1)
        })
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

    // 1. Reset match scores and status
    batch.update(doc(db, 'matches', matchId), {
      status: 'scheduled',
      homeScore: null,
      awayScore: null
    })

    // 2. Fetch guesses
    const guessesSnap = await getDocs(query(collection(db, 'guesses'), where('matchId', '==', matchId)))
    
    // 3. Decrement user points if they previously won
    for (const guessDoc of guessesSnap.docs) {
      const guessData = guessDoc.data()
      if (guessData.pointsEarned === 1) {
        batch.update(doc(db, 'users', guessData.userId), {
          points: increment(-1)
        })
      }
      
      // Clear point status on guess
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
          homeScore: match.homeScore !== null ? match.homeScore : 0,
          awayScore: match.awayScore !== null ? match.awayScore : 0
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
        if (!predictionInputs.value[guess.matchId]) {
          predictionInputs.value[guess.matchId] = {
            homeGuess: guess.homeGuess,
            awayGuess: guess.awayGuess
          }
        } else {
          predictionInputs.value[guess.matchId].homeGuess = guess.homeGuess
          predictionInputs.value[guess.matchId].awayGuess = guess.awayGuess
        }
      }
    })
  })

  // 4. Subscribe to Leaderboard
  const leaderboardQuery = query(collection(db, 'users'), orderBy('points', 'desc'))
  leaderboardUnsub = onSnapshot(leaderboardQuery, (snapshot) => {
    leaderboard.value = snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() }))
  })
}

// Clean up subs on unmount
const clearSubscriptions = () => {
  if (matchesUnsub) matchesUnsub()
  if (guessesUnsub) guessesUnsub()
  if (leaderboardUnsub) leaderboardUnsub()
  if (userProfileUnsub) userProfileUnsub()
}

onMounted(() => {
  window.addEventListener('click', closeUserMenu)
  onAuthStateChanged(auth, (currentUser) => {
    clearSubscriptions()
    
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
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('click', closeUserMenu)
})

</script>

<template>
  <header v-if="user" class="app-header-bar">
    <div class="app-version-fixed">v{{ version }}</div>
    <div class="header-top-row">
      <div class="logo-group">
        <div class="logo-container">
          <span class="logo-icon">🏆</span>
          <h1>Roomie Bet</h1>
        </div>
        <p class="motto">World Cup 2026 Score Predictor</p>
      </div>
      
      <div class="user-bar">
        <div class="user-points">
          <span class="points-icon">🏆</span>
          <span class="points-val">{{ processedUserProfile?.points || 0 }}</span>
          <span class="points-label"> {{ (processedUserProfile?.points === 1) ? ' Point' : ' Points' }}</span>
        </div>
        
        <div class="user-menu-container" ref="userMenuRef" @click.stop>
          <button class="btn-avatar-menu" @click="toggleUserMenu">
            {{ processedUserProfile?.displayName?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase() }}
          </button>
          
          <div v-if="showUserMenu" class="user-dropdown-menu">
            <div class="dropdown-user-info">
              <span class="dropdown-user-name">{{ processedUserProfile?.displayName || 'User' }}</span>
              <span class="dropdown-user-email">{{ user.email }}</span>
            </div>
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
        @click="activeTab = 'leaderboard'"
      >
        📊 Leaderboard
      </button>
      <button 
        v-if="user.email === 'mariuscm@gmail.com'" 
        class="tab-btn" 
        :class="{ active: activeTab === 'admin' }" 
        @click="activeTab = 'admin'"
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
              'correct-guess': match.status === 'completed' && userGuesses[match.id]?.pointsEarned === 1,
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
                  {{ match.homeScore !== null ? match.homeScore : 0 }} - {{ match.awayScore !== null ? match.awayScore : 0 }}
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
                <span v-if="userGuesses[match.id]?.homeGuess !== undefined && userGuesses[match.id]?.homeGuess !== null">
                  {{ userGuesses[match.id].homeGuess }} - {{ userGuesses[match.id].awayGuess }}
                </span>
                <span v-else class="text-muted">No prediction submitted</span>
                
                <span 
                  class="badge-points"
                  :class="{
                    'points-earned': userGuesses[match.id]?.pointsEarned === 1,
                    'points-missed': userGuesses[match.id]?.pointsEarned === 0 || !userGuesses[match.id]
                  }"
                >
                  {{ userGuesses[match.id]?.pointsEarned === 1 ? '+1 Point' : '0 Points' }}
                </span>
              </div>

              <!-- Case 2: Match is scheduled, but started/locked -->
              <div v-else-if="matchHasStarted(match.date)" class="prediction-badge">
                <span v-if="userGuesses[match.id]?.homeGuess !== undefined && userGuesses[match.id]?.homeGuess !== null" style="margin-right: 0.5rem;">
                  {{ userGuesses[match.id].homeGuess }} - {{ userGuesses[match.id].awayGuess }}
                </span>
                <span v-else class="text-muted" style="margin-right: 0.5rem;">No prediction</span>
                <span class="badge-points points-pending">Locked 🔒</span>
              </div>

              <!-- Case 3: Match is open for predictions -->
              <div v-else-if="predictionInputs[match.id]" class="prediction-inputs">
                <input 
                  type="number" 
                  placeholder="Home" 
                  min="0" 
                  max="15"
                  step="1"
                  v-model.number="predictionInputs[match.id].homeGuess"
                />
                <span>-</span>
                <input 
                  type="number" 
                  placeholder="Away" 
                  min="0" 
                  max="15"
                  step="1"
                  v-model.number="predictionInputs[match.id].awayGuess"
                />
                <button 
                  class="btn" 
                  :class="{ 'btn-saved': isPredictionSaved(match.id) }"
                  style="width: auto; padding: 0.4rem 0.8rem; font-size: 0.85rem;"
                  @click="submitGuess(match.id)"
                  :disabled="predictionInputs[match.id].homeGuess === null || predictionInputs[match.id].awayGuess === null || predictionInputs[match.id].homeGuess === undefined || predictionInputs[match.id].awayGuess === undefined"
                >
                  {{ isPredictionSaved(match.id) ? 'SAVED' : 'Save' }}
                </button>
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
                👥 {{ expandedMatches[match.id] ? 'Hide' : 'Show' }} Friends' Predictions ({{ getOtherGuessesCount(match.id) }})
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
                  <span class="pred-player-score" v-if="pred.homeGuess !== undefined && pred.homeGuess !== null">
                    {{ pred.homeGuess }} - {{ pred.awayGuess }}
                    <span 
                      v-if="match.status === 'completed'" 
                      class="mini-points-badge"
                      :class="pred.pointsEarned === 1 ? 'earned' : 'missed'"
                    >
                      {{ pred.pointsEarned === 1 ? '+1' : '0' }}
                    </span>
                  </span>
                  <span class="pred-player-score text-muted" v-else>
                    No prediction
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
              {{ player.displayName }}
              <span v-if="player.uid === user.uid" class="current-user-tag">You</span>
            </td>
            <td class="points-cell">{{ player.points }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Admin Panel (Only visible to mariuscm@gmail.com) -->
    <section v-if="activeTab === 'admin' && user.email === 'mariuscm@gmail.com'">
      <!-- Seed Database Panel -->
      <div class="admin-card">
        <h3>🌱 Database Seeding</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1rem;">
          Populate or overwrite the database with group stage matches starting tomorrow (June 19, 2026).
        </p>
        <button class="btn btn-secondary" @click="seedDatabase">
          Seed Group Stage Matches (June 19+)
        </button>
        <span style="display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
          Note: This resets current scores and deletes existing predictions.
        </span>
      </div>

      <!-- Add New Match -->
      <div class="admin-card">
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

      <!-- Manage Matches Score Locker -->
      <div class="admin-card">
        <h3>🔒 Manage Matches & Lock Scores</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 1.5rem;">
          Input final scorelines and lock them. This evaluates all guesses and rewards points.
        </p>

        <div class="matches-list">
          <div v-for="match in processedMatches" :key="match.id" class="match-card" style="background: rgba(0,0,0,0.15)">
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
              
              <div v-else class="form-grid-three" style="width: 100%; align-items: center;">
                <div style="display: flex; align-items: center; gap: 0.25rem;">
                  <input type="number" min="0" max="15" step="1" placeholder="Home" style="width: 75px; text-align: center;" v-model="adminScores[match.id].homeScore" />
                  <span style="color: var(--text-muted)">-</span>
                  <input type="number" min="0" max="15" step="1" placeholder="Away" style="width: 75px; text-align: center;" v-model="adminScores[match.id].awayScore" />
                </div>
                <div></div>
                <button class="btn" style="padding: 0.4rem; font-size: 0.85rem;" @click="completeMatch(match.id)">
                  Lock Score & Rank
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <!-- Guest / Auth screens -->
  <main v-else class="auth-container">
    <div class="glass-card">
      <div class="auth-header">
        <h2>{{ isLogin ? 'Welcome Back!' : 'Create Account' }}</h2>
        <p>{{ isLogin ? 'Sign in to place your score predictions' : 'Register to play with your roommates' }}</p>
      </div>

      <div v-if="authError" class="alert-banner alert-error">
        <span>⚠</span> {{ authError }}
      </div>

      <form @submit.prevent="handleAuth" style="display: flex; flex-direction: column; gap: 0.5rem;">
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
        <span v-if="isLogin">
          Don't have an account? 
          <a href="#" @click.prevent="isLogin = false">Create one here</a>
        </span>
        <span v-else>
          Already have an account? 
          <a href="#" @click.prevent="isLogin = true">Sign in here</a>
        </span>
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
</template>

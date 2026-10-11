import Vue from 'vue'

const REQUEST_TIMEOUT = 8000
const SYNC_INTERVAL = 4000
// Don't correct drift right after a local or remote change while players settle
const SETTLE_TIME = 3000
// Max position difference (seconds) when applying an explicit remote action
const ACTION_THRESHOLD = 0.75

/**
 * Position of the shared playback at a given server time
 *
 * @param {{ isPlaying: boolean, currentTime: number, playbackRate: number, updatedAt: number }} state
 * @param {number} now
 */
function getStatePosition(state, now) {
  if (!state.isPlaying) return state.currentTime
  return state.currentTime + (Math.max(0, now - state.updatedAt) / 1000) * (state.playbackRate || 1)
}

/**
 * @typedef ListenTogetherPlayerState
 * @property {string|null} libraryItemId server library item id
 * @property {string|null} episodeId server episode id
 * @property {number} currentTime
 * @property {number} [duration]
 * @property {boolean} isPlaying
 * @property {boolean} isLoading
 * @property {number} playbackRate
 */

/**
 * @typedef ListenTogetherPlayerAdapter
 * @property {() => Promise<ListenTogetherPlayerState>|ListenTogetherPlayerState} getState
 * @property {() => void} play
 * @property {() => void} pause
 * @property {(time: number) => void} seek
 * @property {(rate: number) => void} setPlaybackRate
 * @property {(payload: { libraryItemId: string, episodeId: string|null, startTime: number, paused: boolean }) => Promise<any>|void} loadItem
 */

/**
 * Client side of "Listen together".
 * Keeps the local player in sync with the shared state of the listening party and sends
 * user initiated playback changes to the server.
 *
 * Local actions must be reported with `localAction()`, changes applied from the party
 * are performed directly on the player adapter so they are never echoed back.
 */
export default class ListenTogether {
  constructor(store, options = {}) {
    this.store = store
    this.driftThreshold = options.driftThreshold || 2

    this.socket = null
    /** @type {ListenTogetherPlayerAdapter} */
    this.player = null

    this.party = null
    this.positionAtReceive = 0
    this.receivedAt = 0

    this.syncInterval = null
    this.lastLocalActionAt = 0
    this.lastRemoteApplyAt = 0
    this.actionSeq = 0
    this.isLoadingItem = false
    this.isSyncing = false
    this.pendingSyncThreshold = null
  }

  get strings() {
    return Vue.prototype.$strings || {}
  }

  get toast() {
    return Vue.prototype.$toast
  }

  get isInParty() {
    return !!this.party
  }

  getString(key, subs = []) {
    let str = this.strings[key] || key
    subs.forEach((sub, index) => {
      str = str.replace(`{${index}}`, sub)
    })
    return str
  }

  setSocket(socket) {
    this.socket = socket
  }

  attachPlayer(player) {
    this.player = player
  }

  detachPlayer(player) {
    if (this.player === player) this.player = null
  }

  request(evt, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        return reject(new Error(this.strings.MessageListenTogetherNotConnected || 'Not connected to server'))
      }
      const timeout = setTimeout(() => reject(new Error('Request timed out')), REQUEST_TIMEOUT)
      this.socket.emit(evt, payload, (res) => {
        clearTimeout(timeout)
        if (!res || res.error) return reject(new Error(res?.error || 'Unknown error'))
        resolve(res)
      })
    })
  }

  setParty(party) {
    this.party = party || null
    if (this.party) {
      this.receivedAt = Date.now()
      this.positionAtReceive = getStatePosition(party.state, party.serverTime || party.state.updatedAt)
      this.startSyncInterval()
    } else {
      this.stopSyncInterval()
    }
    this.store.commit('listenTogether/setParty', this.party)
  }

  /**
   * Update the party state locally before the server confirms it
   */
  setOptimisticState(state, partyProps = {}) {
    const now = Date.now()
    this.setParty({
      ...this.party,
      ...partyProps,
      state: { ...this.party.state, ...state, updatedAt: now },
      serverTime: now
    })
  }

  /**
   * Current position of the shared playback
   */
  getExpectedTime() {
    if (!this.party) return 0
    const state = this.party.state
    if (!state.isPlaying) return this.positionAtReceive
    return this.positionAtReceive + ((Date.now() - this.receivedAt) / 1000) * (state.playbackRate || 1)
  }

  isPartyItem(libraryItemId, episodeId) {
    if (!this.party) return false
    return this.party.libraryItemId === libraryItemId && (this.party.episodeId || null) === (episodeId || null)
  }

  //
  // Party management
  //
  async create() {
    const state = this.player ? await this.player.getState() : null
    if (!state?.libraryItemId) throw new Error(this.strings.MessageListenTogetherNothingPlaying || 'Nothing is playing')

    const res = await this.request('listen_together_create', {
      libraryItemId: state.libraryItemId,
      episodeId: state.episodeId || null,
      currentTime: state.currentTime,
      isPlaying: state.isPlaying,
      playbackRate: state.playbackRate
    })
    this.setParty(res.party)
    return res.party
  }

  async join(payload) {
    const res = await this.request('listen_together_join', payload)
    this.setParty(res.party)
    await this.syncToParty(ACTION_THRESHOLD)
    return res.party
  }

  async leave() {
    if (!this.party) return
    this.setParty(null)
    await this.request('listen_together_leave').catch((error) => {
      console.error('[ListenTogether] Failed to leave party', error)
    })
  }

  async end() {
    await this.request('listen_together_end')
    this.setParty(null)
  }

  async invite(userId) {
    await this.request('listen_together_invite', { userId })
  }

  async getUsers() {
    const res = await this.request('listen_together_users')
    return res.users || []
  }

  //
  // Local playback changes
  //

  /**
   * Report a user initiated playback change
   *
   * @param {'play'|'pause'|'seek'|'rate'|'load'} action
   * @param {{ currentTime?: number, isPlaying?: boolean, playbackRate?: number, libraryItemId?: string, episodeId?: string }} data
   * @returns {boolean} true if the action was handled by syncing to the party instead
   */
  localAction(action, data = {}) {
    if (!this.party) return false

    const isPartyItem = this.isPartyItem(data.libraryItemId, data.episodeId)
    if (action !== 'load' && data.libraryItemId && !isPartyItem) return false

    // Pressing play while the party is playing catches up with the party instead of moving everyone
    if (action === 'play' && this.party.state.isPlaying) {
      this.lastLocalActionAt = Date.now()
      this.player?.seek(this.getExpectedTime())
      return true
    }
    if (action === 'rate' && Math.abs((data.playbackRate || 1) - this.party.state.playbackRate) < 0.01) return false

    this.lastLocalActionAt = Date.now()

    const payload = { action, ...data }
    if (action === 'play' || action === 'pause') {
      this.setOptimisticState({ isPlaying: action === 'play', currentTime: data.currentTime !== undefined ? data.currentTime : this.getExpectedTime() })
    } else if (action === 'seek') {
      this.setOptimisticState({ currentTime: data.currentTime })
    } else if (action === 'rate') {
      this.setOptimisticState({ currentTime: data.currentTime !== undefined ? data.currentTime : this.getExpectedTime(), playbackRate: data.playbackRate })
    } else if (action === 'load') {
      this.setOptimisticState({ currentTime: data.currentTime || 0, isPlaying: data.isPlaying !== false }, { libraryItemId: data.libraryItemId, episodeId: data.episodeId || null })
    }

    const seq = ++this.actionSeq
    this.request('listen_together_update', payload)
      .then((res) => {
        // Ignore stale responses when another local action happened in the meantime
        if (seq === this.actionSeq && this.party?.id === res.party.id) {
          this.setParty(res.party)
        }
      })
      .catch((error) => {
        console.error(`[ListenTogether] Failed to send ${action}`, error)
        if (action === 'load') {
          // The party can't follow, leave it so the local player isn't pulled back
          this.toast?.warning(this.getString('ToastListenTogetherLeftItemChanged', [error.message]))
          this.leave()
        } else if (error.message === 'Not in a listening party') {
          this.setParty(null)
          this.toast?.warning(this.strings.ToastListenTogetherEnded)
        } else {
          this.toast?.error(error.message)
        }
      })
    return false
  }

  //
  // Socket events
  //
  onState(data) {
    if (!this.party || data.partyId !== this.party.id) return
    this.setParty(data.party)

    if (data.action === 'play') this.toast?.info(this.getString('ToastListenTogetherPlayed', [data.username]), { timeout: 2500 })
    else if (data.action === 'pause') this.toast?.info(this.getString('ToastListenTogetherPaused', [data.username]), { timeout: 2500 })
    else if (data.action === 'load') this.toast?.info(this.getString('ToastListenTogetherLoaded', [data.username, data.party.title]), { timeout: 4000 })

    this.syncToParty(ACTION_THRESHOLD)
  }

  onPartyUpdated(party) {
    if (!this.party || party.id !== this.party.id) return
    this.setParty(party)
  }

  onEnded(data) {
    if (!this.party || data.partyId !== this.party.id) return
    this.setParty(null)
    this.toast?.info(this.strings.ToastListenTogetherEnded)
  }

  /**
   * Socket reconnected and authenticated again, rejoin the party with the new socket
   */
  async onReconnected() {
    if (!this.party) return
    const partyId = this.party.id
    try {
      await this.join({ partyId })
    } catch (error) {
      console.error('[ListenTogether] Failed to rejoin party', error)
      if (this.party?.id === partyId) {
        this.setParty(null)
        this.toast?.warning(this.strings.ToastListenTogetherEnded)
      }
    }
  }

  //
  // Syncing the local player
  //
  startSyncInterval() {
    if (this.syncInterval) return
    this.syncInterval = setInterval(() => {
      const now = Date.now()
      if (now - this.lastLocalActionAt < SETTLE_TIME || now - this.lastRemoteApplyAt < SETTLE_TIME) return
      this.syncToParty(this.driftThreshold)
    }, SYNC_INTERVAL)
  }

  stopSyncInterval() {
    clearInterval(this.syncInterval)
    this.syncInterval = null
  }

  /**
   * Bring the local player in line with the party state
   *
   * @param {number} threshold max allowed position difference in seconds
   */
  async syncToParty(threshold) {
    if (!this.party || !this.player || this.isLoadingItem) return
    if (this.isSyncing) {
      // Run again once the current sync is done so remote actions aren't dropped
      this.pendingSyncThreshold = this.pendingSyncThreshold === null ? threshold : Math.min(threshold, this.pendingSyncThreshold)
      return
    }
    this.isSyncing = true
    try {
      const party = this.party
      const state = await this.player.getState()
      if (!this.party || this.party !== party) return

      const expectedTime = this.getExpectedTime()

      if (!this.isPartyItem(state.libraryItemId, state.episodeId)) {
        this.isLoadingItem = true
        this.lastRemoteApplyAt = Date.now()
        try {
          await this.player.loadItem({
            libraryItemId: party.libraryItemId,
            episodeId: party.episodeId || null,
            startTime: expectedTime,
            paused: !party.state.isPlaying
          })
        } finally {
          this.isLoadingItem = false
          this.lastRemoteApplyAt = Date.now()
        }
        return
      }

      if (state.isLoading) return

      // The party reached the end of the item, wait for the next item to be loaded
      const isPastEnd = party.state.isPlaying && state.duration > 0 && expectedTime >= state.duration - 1

      let changed = false
      if (Math.abs((state.playbackRate || 1) - party.state.playbackRate) >= 0.01) {
        this.player.setPlaybackRate(party.state.playbackRate)
        changed = true
      }
      if (!isPastEnd && Math.abs(state.currentTime - expectedTime) > threshold) {
        console.log(`[ListenTogether] Syncing position ${state.currentTime} -> ${expectedTime}`)
        this.player.seek(expectedTime)
        changed = true
      }
      if (isPastEnd) {
        // Let the local player finish on its own
      } else if (party.state.isPlaying && !state.isPlaying) {
        this.player.play()
        changed = true
      } else if (!party.state.isPlaying && state.isPlaying) {
        this.player.pause()
        changed = true
      }
      if (changed) this.lastRemoteApplyAt = Date.now()
    } catch (error) {
      console.error('[ListenTogether] Failed to sync to party', error)
    } finally {
      this.isSyncing = false
      if (this.pendingSyncThreshold !== null) {
        const pendingThreshold = this.pendingSyncThreshold
        this.pendingSyncThreshold = null
        this.syncToParty(pendingThreshold)
      }
    }
  }
}

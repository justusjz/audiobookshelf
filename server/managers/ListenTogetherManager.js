const crypto = require('crypto')
const Logger = require('../Logger')

// Characters that are easy to read aloud and type (no 0/O, 1/I/L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
// Keep an empty party around for a while so members can rejoin after a reconnect
const EMPTY_PARTY_TTL = 2 * 60 * 1000

const VALID_ACTIONS = ['play', 'pause', 'seek', 'rate', 'load']

/**
 * @typedef ListenTogetherState
 * @property {boolean} isPlaying
 * @property {number} currentTime position in seconds at `updatedAt`
 * @property {number} playbackRate
 * @property {number} updatedAt server timestamp (ms)
 */

/**
 * @typedef ListenTogetherMember
 * @property {string} socketId
 * @property {string} userId
 * @property {string} username
 */

/**
 * @typedef ListenTogetherParty
 * @property {string} id
 * @property {string} code
 * @property {string} hostUserId
 * @property {string} libraryItemId
 * @property {string|null} episodeId
 * @property {string} title
 * @property {Map<string, ListenTogetherMember>} members keyed by socket id
 * @property {ListenTogetherState} state
 * @property {number} createdAt
 * @property {NodeJS.Timeout|null} emptyTimeout
 */

/**
 * Manages "Listen together" parties. A party is a group of sockets (devices) that keep
 * their playback of the same library item in sync. Every member keeps their own playback
 * session and media progress; only the play state, position and playback rate are shared.
 *
 * Parties are kept in memory only.
 */
class ListenTogetherManager {
  /**
   * @param {(socketId: string, evt: string, data: any) => void} emitToSocket
   */
  constructor(emitToSocket) {
    this.emitToSocket = emitToSocket

    /** @type {Map<string, ListenTogetherParty>} */
    this.parties = new Map()
    /** @type {Map<string, string>} socket id -> party id */
    this.socketPartyMap = new Map()
  }

  /**
   * Position of the shared playback at a given time
   *
   * @param {ListenTogetherState} state
   * @param {number} [now]
   * @returns {number}
   */
  static getStatePosition(state, now = Date.now()) {
    if (!state.isPlaying) return state.currentTime
    const elapsed = Math.max(0, now - state.updatedAt) / 1000
    return state.currentTime + elapsed * (state.playbackRate || 1)
  }

  generateCode() {
    const existingCodes = new Set([...this.parties.values()].map((p) => p.code))
    let code = null
    do {
      code = ''
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
      }
    } while (existingCodes.has(code))
    return code
  }

  /**
   * @param {string} socketId
   * @returns {ListenTogetherParty|null}
   */
  getPartyForSocket(socketId) {
    const partyId = this.socketPartyMap.get(socketId)
    if (!partyId) return null
    return this.parties.get(partyId) || null
  }

  /**
   * @param {{ partyId?: string, code?: string }} payload
   * @returns {ListenTogetherParty|null}
   */
  findParty(payload) {
    if (payload?.partyId && this.parties.has(payload.partyId)) {
      return this.parties.get(payload.partyId)
    }
    if (typeof payload?.code === 'string') {
      const code = payload.code.trim().toUpperCase()
      if (!code) return null
      return [...this.parties.values()].find((p) => p.code === code) || null
    }
    return null
  }

  /**
   * @param {ListenTogetherParty} party
   */
  toJSON(party) {
    const membersByUser = new Map()
    for (const member of party.members.values()) {
      if (membersByUser.has(member.userId)) {
        membersByUser.get(member.userId).numDevices++
      } else {
        membersByUser.set(member.userId, {
          userId: member.userId,
          username: member.username,
          numDevices: 1
        })
      }
    }
    return {
      id: party.id,
      code: party.code,
      hostUserId: party.hostUserId,
      libraryItemId: party.libraryItemId,
      episodeId: party.episodeId,
      title: party.title,
      members: [...membersByUser.values()],
      state: { ...party.state },
      createdAt: party.createdAt,
      serverTime: Date.now()
    }
  }

  /**
   * Emit to all sockets in a party
   *
   * @param {ListenTogetherParty} party
   * @param {string} evt
   * @param {any} data
   * @param {string} [excludeSocketId]
   */
  emitToParty(party, evt, data, excludeSocketId = null) {
    for (const socketId of party.members.keys()) {
      if (socketId === excludeSocketId) continue
      this.emitToSocket(socketId, evt, data)
    }
  }

  /**
   * @param {ListenTogetherParty} party
   * @param {string} [excludeSocketId]
   */
  emitPartyUpdated(party, excludeSocketId = null) {
    this.emitToParty(party, 'listen_together_party', this.toJSON(party), excludeSocketId)
  }

  /**
   * Validate and normalize position/rate values sent by a client
   *
   * @param {any} value
   * @returns {number|null}
   */
  parseTime(value) {
    const num = Number(value)
    if (value === null || value === undefined || isNaN(num) || !isFinite(num) || num < 0) return null
    return num
  }

  parsePlaybackRate(value) {
    const num = Number(value)
    if (isNaN(num) || num < 0.5 || num > 10) return null
    return num
  }

  /**
   * @param {import('../SocketAuthority').SocketClient} client
   * @param {{ libraryItemId: string, episodeId?: string, title?: string, currentTime?: number, isPlaying?: boolean, playbackRate?: number }} payload
   * @returns {ListenTogetherParty}
   */
  createParty(client, payload) {
    this.leaveParty(client.id)

    const party = {
      id: crypto.randomUUID(),
      code: this.generateCode(),
      hostUserId: client.user.id,
      libraryItemId: payload.libraryItemId,
      episodeId: payload.episodeId || null,
      title: payload.title || '',
      members: new Map(),
      state: {
        isPlaying: !!payload.isPlaying,
        currentTime: this.parseTime(payload.currentTime) || 0,
        playbackRate: this.parsePlaybackRate(payload.playbackRate) || 1,
        updatedAt: Date.now()
      },
      createdAt: Date.now(),
      emptyTimeout: null
    }
    party.members.set(client.id, { socketId: client.id, userId: client.user.id, username: client.user.username })
    this.parties.set(party.id, party)
    this.socketPartyMap.set(client.id, party.id)

    Logger.info(`[ListenTogetherManager] User "${client.user.username}" created party ${party.code} for item "${party.libraryItemId}"`)
    return party
  }

  /**
   * @param {import('../SocketAuthority').SocketClient} client
   * @param {ListenTogetherParty} party
   * @returns {ListenTogetherParty}
   */
  joinParty(client, party) {
    const currentParty = this.getPartyForSocket(client.id)
    if (currentParty && currentParty.id !== party.id) {
      this.leaveParty(client.id)
    }

    if (party.emptyTimeout) {
      clearTimeout(party.emptyTimeout)
      party.emptyTimeout = null
    }

    const isNewMember = !party.members.has(client.id)
    party.members.set(client.id, { socketId: client.id, userId: client.user.id, username: client.user.username })
    this.socketPartyMap.set(client.id, party.id)

    if (isNewMember) {
      Logger.info(`[ListenTogetherManager] User "${client.user.username}" joined party ${party.code}`)
      this.emitPartyUpdated(party, client.id)
    }
    return party
  }

  /**
   * Remove socket from its party
   *
   * @param {string} socketId
   * @returns {boolean} true if socket was in a party
   */
  leaveParty(socketId) {
    const party = this.getPartyForSocket(socketId)
    this.socketPartyMap.delete(socketId)
    if (!party) return false

    const member = party.members.get(socketId)
    party.members.delete(socketId)
    if (member) {
      Logger.info(`[ListenTogetherManager] User "${member.username}" left party ${party.code}`)
    }

    if (!party.members.size) {
      // Keep empty party for a short time so members can rejoin after reconnecting
      if (party.emptyTimeout) clearTimeout(party.emptyTimeout)
      party.emptyTimeout = setTimeout(() => this.removeParty(party.id), EMPTY_PARTY_TTL)
      if (party.emptyTimeout.unref) party.emptyTimeout.unref()
      return true
    }

    // Pass host to another member when the host has no devices left in the party
    if (member && member.userId === party.hostUserId && ![...party.members.values()].some((m) => m.userId === party.hostUserId)) {
      party.hostUserId = party.members.values().next().value.userId
    }
    this.emitPartyUpdated(party)
    return true
  }

  /**
   * End a party for all members. Only the host can end a party.
   *
   * @param {import('../SocketAuthority').SocketClient} client
   * @returns {{ error?: string }}
   */
  endParty(client) {
    const party = this.getPartyForSocket(client.id)
    if (!party) return { error: 'Not in a listening party' }
    if (party.hostUserId !== client.user.id) return { error: 'Only the host can end the listening party' }

    this.emitToParty(party, 'listen_together_ended', { partyId: party.id, reason: 'ended', username: client.user.username }, client.id)
    this.removeParty(party.id)
    Logger.info(`[ListenTogetherManager] User "${client.user.username}" ended party ${party.code}`)
    return {}
  }

  removeParty(partyId) {
    const party = this.parties.get(partyId)
    if (!party) return
    if (party.emptyTimeout) clearTimeout(party.emptyTimeout)
    for (const socketId of party.members.keys()) {
      this.socketPartyMap.delete(socketId)
    }
    this.parties.delete(partyId)
    Logger.debug(`[ListenTogetherManager] Removed party ${party.code}`)
  }

  /**
   * Update the shared playback state and broadcast it to the other members
   *
   * @param {import('../SocketAuthority').SocketClient} client
   * @param {{ action: string, currentTime?: number, isPlaying?: boolean, playbackRate?: number, libraryItemId?: string, episodeId?: string, title?: string }} payload
   * @returns {{ error?: string, party?: ListenTogetherParty }}
   */
  updateState(client, payload) {
    const party = this.getPartyForSocket(client.id)
    if (!party) return { error: 'Not in a listening party' }

    const action = payload?.action
    if (!VALID_ACTIONS.includes(action)) return { error: 'Invalid action' }

    if (action !== 'load') {
      // Ignore updates sent for a different item (e.g. a client that has not loaded the new item yet)
      if (payload.libraryItemId && (payload.libraryItemId !== party.libraryItemId || (payload.episodeId || null) !== party.episodeId)) {
        return { error: 'Item mismatch' }
      }
    } else if (!payload.libraryItemId) {
      return { error: 'Invalid library item' }
    }

    const now = Date.now()
    const state = party.state
    const currentTime = this.parseTime(payload.currentTime)

    if (action === 'play' || action === 'pause') {
      state.currentTime = currentTime ?? ListenTogetherManager.getStatePosition(state, now)
      state.isPlaying = action === 'play'
    } else if (action === 'seek') {
      if (currentTime === null) return { error: 'Invalid time' }
      state.currentTime = currentTime
      if (typeof payload.isPlaying === 'boolean') state.isPlaying = payload.isPlaying
    } else if (action === 'rate') {
      const playbackRate = this.parsePlaybackRate(payload.playbackRate)
      if (playbackRate === null) return { error: 'Invalid playback rate' }
      state.currentTime = currentTime ?? ListenTogetherManager.getStatePosition(state, now)
      state.playbackRate = playbackRate
    } else if (action === 'load') {
      party.libraryItemId = payload.libraryItemId
      party.episodeId = payload.episodeId || null
      party.title = payload.title || ''
      state.currentTime = currentTime || 0
      state.isPlaying = typeof payload.isPlaying === 'boolean' ? payload.isPlaying : true
    }
    state.updatedAt = now

    const partyJson = this.toJSON(party)
    this.emitToParty(
      party,
      'listen_together_state',
      {
        partyId: party.id,
        action,
        userId: client.user.id,
        username: client.user.username,
        party: partyJson
      },
      client.id
    )
    return { party }
  }

  /**
   * @param {string} socketId
   */
  handleDisconnect(socketId) {
    this.leaveParty(socketId)
  }
}
module.exports = ListenTogetherManager

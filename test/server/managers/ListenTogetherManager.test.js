const { expect } = require('chai')
const sinon = require('sinon')
const ListenTogetherManager = require('../../../server/managers/ListenTogetherManager')

describe('ListenTogetherManager', () => {
  let manager
  let emitToSocket
  let clock

  const alice = { id: 'socket-alice', user: { id: 'user-alice', username: 'alice' } }
  const alicePhone = { id: 'socket-alice-phone', user: { id: 'user-alice', username: 'alice' } }
  const bob = { id: 'socket-bob', user: { id: 'user-bob', username: 'bob' } }

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1000000 })
    emitToSocket = sinon.spy()
    manager = new ListenTogetherManager(emitToSocket)
  })

  afterEach(() => {
    clock.restore()
  })

  describe('createParty', () => {
    it('should create a party with a join code and the creator as host', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1', title: 'Book', currentTime: 42, isPlaying: true, playbackRate: 1.5 })

      expect(party.code).to.match(/^[A-Z0-9]{6}$/)
      expect(party.hostUserId).to.equal('user-alice')
      expect(party.state).to.deep.include({ isPlaying: true, currentTime: 42, playbackRate: 1.5 })
      expect(manager.getPartyForSocket(alice.id)).to.equal(party)
    })

    it('should leave the current party when creating a new one', () => {
      const party1 = manager.createParty(alice, { libraryItemId: 'li1' })
      manager.joinParty(bob, party1)
      const party2 = manager.createParty(bob, { libraryItemId: 'li2' })

      expect(party1.members.has(bob.id)).to.be.false
      expect(manager.getPartyForSocket(bob.id)).to.equal(party2)
    })
  })

  describe('joinParty', () => {
    it('should find a party by code case-insensitively and notify other members', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1' })
      const found = manager.findParty({ code: ` ${party.code.toLowerCase()} ` })
      expect(found).to.equal(party)

      manager.joinParty(bob, found)

      expect(party.members.size).to.equal(2)
      expect(emitToSocket.calledWith(alice.id, 'listen_together_party')).to.be.true
      expect(emitToSocket.calledWith(bob.id, 'listen_together_party')).to.be.false
    })

    it('should group devices of the same user in the member list', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1' })
      manager.joinParty(alicePhone, party)
      manager.joinParty(bob, party)

      const json = manager.toJSON(party)
      expect(json.members).to.deep.equal([
        { userId: 'user-alice', username: 'alice', numDevices: 2 },
        { userId: 'user-bob', username: 'bob', numDevices: 1 }
      ])
    })
  })

  describe('updateState', () => {
    it('should update state and broadcast to other members only', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1', currentTime: 10, isPlaying: false })
      manager.joinParty(bob, party)
      emitToSocket.resetHistory()

      const result = manager.updateState(bob, { action: 'play', currentTime: 20, libraryItemId: 'li1' })

      expect(result.error).to.be.undefined
      expect(party.state.isPlaying).to.be.true
      expect(party.state.currentTime).to.equal(20)
      expect(emitToSocket.calledOnce).to.be.true
      const [socketId, evt, data] = emitToSocket.firstCall.args
      expect(socketId).to.equal(alice.id)
      expect(evt).to.equal('listen_together_state')
      expect(data.action).to.equal('play')
      expect(data.username).to.equal('bob')
      expect(data.party.state.currentTime).to.equal(20)
    })

    it('should reject updates for a different item', () => {
      manager.createParty(alice, { libraryItemId: 'li1' })
      const result = manager.updateState(alice, { action: 'seek', currentTime: 5, libraryItemId: 'li2' })
      expect(result.error).to.equal('Item mismatch')
    })

    it('should reject invalid actions and values', () => {
      manager.createParty(alice, { libraryItemId: 'li1' })
      expect(manager.updateState(alice, { action: 'explode' }).error).to.equal('Invalid action')
      expect(manager.updateState(alice, { action: 'seek', currentTime: -1 }).error).to.equal('Invalid time')
      expect(manager.updateState(alice, { action: 'rate', playbackRate: 50 }).error).to.equal('Invalid playback rate')
      expect(manager.updateState(bob, { action: 'play' }).error).to.equal('Not in a listening party')
    })

    it('should use the extrapolated position when pausing without a time', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1', currentTime: 100, isPlaying: true, playbackRate: 2 })
      clock.tick(5000)
      manager.updateState(alice, { action: 'pause' })
      expect(party.state.isPlaying).to.be.false
      expect(party.state.currentTime).to.equal(110)
    })

    it('should switch item on load', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1', currentTime: 100 })
      manager.updateState(alice, { action: 'load', libraryItemId: 'li2', episodeId: 'ep1', title: 'Episode', currentTime: 3 })
      expect(party.libraryItemId).to.equal('li2')
      expect(party.episodeId).to.equal('ep1')
      expect(party.title).to.equal('Episode')
      expect(party.state).to.deep.include({ currentTime: 3, isPlaying: true })
    })
  })

  describe('getStatePosition', () => {
    it('should extrapolate the position while playing', () => {
      const state = { isPlaying: true, currentTime: 10, playbackRate: 1.5, updatedAt: 1000 }
      expect(ListenTogetherManager.getStatePosition(state, 5000)).to.equal(16)
      expect(ListenTogetherManager.getStatePosition({ ...state, isPlaying: false }, 5000)).to.equal(10)
    })
  })

  describe('leaveParty', () => {
    it('should pass host to another user when the host leaves', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1' })
      manager.joinParty(alicePhone, party)
      manager.joinParty(bob, party)

      manager.leaveParty(alice.id)
      expect(party.hostUserId).to.equal('user-alice') // alice still has another device in the party

      manager.leaveParty(alicePhone.id)
      expect(party.hostUserId).to.equal('user-bob')
    })

    it('should keep an empty party for a while so members can rejoin', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1' })
      manager.handleDisconnect(alice.id)

      expect(manager.parties.has(party.id)).to.be.true
      manager.joinParty(alicePhone, manager.findParty({ partyId: party.id }))
      clock.tick(5 * 60 * 1000)
      expect(manager.parties.has(party.id)).to.be.true

      manager.leaveParty(alicePhone.id)
      clock.tick(5 * 60 * 1000)
      expect(manager.parties.has(party.id)).to.be.false
    })
  })

  describe('endParty', () => {
    it('should only allow the host to end the party', () => {
      const party = manager.createParty(alice, { libraryItemId: 'li1' })
      manager.joinParty(bob, party)

      expect(manager.endParty(bob).error).to.exist
      emitToSocket.resetHistory()
      expect(manager.endParty(alice).error).to.be.undefined
      expect(emitToSocket.calledOnceWith(bob.id, 'listen_together_ended')).to.be.true
      expect(manager.parties.size).to.equal(0)
      expect(manager.getPartyForSocket(bob.id)).to.be.null
    })
  })
})

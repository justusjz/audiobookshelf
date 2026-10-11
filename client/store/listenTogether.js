export const state = () => ({
  party: null,
  showModal: false
})

export const getters = {
  isInParty: (state) => !!state.party
}

export const mutations = {
  setParty(state, party) {
    state.party = party
  },
  setShowModal(state, val) {
    state.showModal = !!val
  }
}

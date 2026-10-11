<template>
  <modals-modal ref="modal" v-model="show" name="listen-together" :width="500" :height="'unset'" :processing="processing">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ $strings.LabelListenTogether }}</p>
      </div>
    </template>
    <div class="px-6 py-8 w-full text-sm rounded-lg bg-bg shadow-lg border border-black-300 overflow-y-auto overflow-x-hidden" style="max-height: 80vh">
      <template v-if="party">
        <p class="text-gray-300 mb-1">{{ $strings.LabelListenTogetherPlaying }}</p>
        <p class="text-base font-semibold truncate mb-4">{{ party.title }}</p>

        <div class="w-full py-2">
          <label class="px-1 text-sm font-semibold block">{{ $strings.LabelListenTogetherCode }}</label>
          <ui-text-input :value="party.code" show-copy readonly class="font-mono tracking-widest" />
          <p class="text-xs text-gray-400 px-1 pt-1">{{ $strings.MessageListenTogetherCodeHelp }}</p>
        </div>

        <div class="w-full py-2">
          <label class="px-1 text-sm font-semibold block mb-1">{{ $strings.LabelListenTogetherMembers }} ({{ party.members.length }})</label>
          <div v-for="member in party.members" :key="member.userId" class="flex items-center px-1 py-1">
            <span class="material-symbols text-lg text-gray-300">person</span>
            <p class="pl-2 truncate">{{ member.username }}</p>
            <span v-if="member.userId === party.hostUserId" class="ml-2 text-xs text-warning">{{ $strings.LabelListenTogetherHost }}</span>
            <span v-if="member.numDevices > 1" class="ml-2 text-xs text-gray-400">({{ $getString('LabelListenTogetherDevices', [member.numDevices]) }})</span>
          </div>
        </div>

        <div class="w-full py-2">
          <label class="px-1 text-sm font-semibold block mb-1">{{ $strings.LabelListenTogetherInvite }}</label>
          <p v-if="loadingUsers" class="px-1 text-gray-400">{{ $strings.MessageLoading }}</p>
          <p v-else-if="!invitableUsers.length" class="px-1 text-gray-400">{{ $strings.MessageListenTogetherNoUsersOnline }}</p>
          <div v-for="user in invitableUsers" :key="user.id" class="flex items-center px-1 py-1">
            <span class="material-symbols text-lg text-gray-300">person_add</span>
            <p class="pl-2 truncate grow">{{ user.username }}</p>
            <ui-btn small :disabled="invitedUserIds.includes(user.id)" @click="inviteUser(user)">{{ invitedUserIds.includes(user.id) ? $strings.LabelListenTogetherInvited : $strings.ButtonListenTogetherInvite }}</ui-btn>
          </div>
        </div>

        <div class="flex items-center pt-6">
          <div class="grow" />
          <ui-btn v-if="isHost" color="bg-error" small class="mr-2" @click="endParty">{{ $strings.ButtonListenTogetherEnd }}</ui-btn>
          <ui-btn small @click="leaveParty">{{ $strings.ButtonListenTogetherLeave }}</ui-btn>
        </div>
      </template>
      <template v-else>
        <p class="text-gray-300 mb-4">{{ $strings.MessageListenTogetherDescription }}</p>

        <div class="w-full py-2">
          <ui-btn color="bg-success" class="w-full" :disabled="!streamLibraryItem" @click="createParty">{{ $strings.ButtonListenTogetherStart }}</ui-btn>
          <p v-if="!streamLibraryItem" class="text-xs text-gray-400 px-1 pt-1">{{ $strings.MessageListenTogetherNothingPlaying }}</p>
        </div>

        <div class="flex items-center py-4">
          <div class="grow border-t border-white/10" />
          <p class="px-3 text-gray-400 text-xs uppercase">{{ $strings.LabelOr }}</p>
          <div class="grow border-t border-white/10" />
        </div>

        <form class="w-full flex items-end" @submit.prevent="joinParty">
          <div class="grow">
            <label class="px-1 text-sm font-semibold block">{{ $strings.LabelListenTogetherCode }}</label>
            <ui-text-input v-model="joinCode" class="font-mono tracking-widest uppercase h-10" />
          </div>
          <ui-btn type="submit" class="ml-2 h-10" :disabled="!joinCode.trim()">{{ $strings.ButtonListenTogetherJoin }}</ui-btn>
        </form>
      </template>
    </div>
  </modals-modal>
</template>

<script>
export default {
  data() {
    return {
      processing: false,
      joinCode: '',
      users: [],
      loadingUsers: false,
      invitedUserIds: []
    }
  },
  watch: {
    show(newVal) {
      if (newVal) this.init()
    },
    partyId(newVal) {
      this.invitedUserIds = []
      if (newVal && this.show) this.loadUsers()
    }
  },
  computed: {
    show: {
      get() {
        return this.$store.state.listenTogether.showModal
      },
      set(val) {
        this.$store.commit('listenTogether/setShowModal', val)
      }
    },
    party() {
      return this.$store.state.listenTogether.party
    },
    partyId() {
      return this.party?.id || null
    },
    isHost() {
      return this.party?.hostUserId === this.$store.state.user.user?.id
    },
    streamLibraryItem() {
      return this.$store.state.streamLibraryItem
    },
    invitableUsers() {
      return this.users.filter((u) => !this.party?.members.some((m) => m.userId === u.id))
    }
  },
  methods: {
    init() {
      this.joinCode = ''
      if (this.party) this.loadUsers()
    },
    async loadUsers() {
      this.loadingUsers = true
      try {
        this.users = await this.$listenTogether.getUsers()
      } catch (error) {
        console.error('Failed to load users', error)
        this.users = []
      }
      this.loadingUsers = false
    },
    async runAction(action) {
      this.processing = true
      try {
        await action()
      } catch (error) {
        console.error('[ListenTogetherModal] Action failed', error)
        this.$toast.error(error.message)
      }
      this.processing = false
    },
    createParty() {
      return this.runAction(() => this.$listenTogether.create())
    },
    joinParty() {
      const code = this.joinCode.trim()
      if (!code) return
      return this.runAction(async () => {
        await this.$listenTogether.join({ code })
        this.show = false
      })
    },
    leaveParty() {
      return this.runAction(async () => {
        await this.$listenTogether.leave()
        this.show = false
      })
    },
    endParty() {
      return this.runAction(async () => {
        await this.$listenTogether.end()
        this.show = false
      })
    },
    inviteUser(user) {
      return this.runAction(async () => {
        await this.$listenTogether.invite(user.id)
        this.invitedUserIds.push(user.id)
        this.$toast.success(this.$getString('ToastListenTogetherInviteSent', [user.username]))
      })
    }
  }
}
</script>

import ListenTogether from '@/players/ListenTogether'

export default ({ store }, inject) => {
  inject('listenTogether', new ListenTogether(store))
}

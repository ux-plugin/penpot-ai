/** Reading behaviour from React. */
import { useSignal } from '../../../doc'
import { EMPTY_BEHAVIOUR, type Behaviour, type Store } from '../ir'
import { behaviourOf, storesOf } from './behaviour'
import { computed } from '@preact/signals-core'

const NONE = computed(() => EMPTY_BEHAVIOUR)

/** The behaviour of `page`, re-rendering when one of its records changes. */
export function useBehaviour(page: string | null | undefined): Behaviour {
  return useSignal(page ? behaviourOf(page) : NONE)
}

/** The document's stores. */
export function useStores(): Store[] {
  return useSignal(storesOf())
}

/**
 * Document-level state that is not yet records: tokens, components
 * and the exporter's document fields. One signal, replaced on write.
 */
import { signal } from '@preact/signals-core'
import type { PenpotDocument } from 'penpot-exporter/types'
import type { LocalComponent } from '../common/component'
import type { TokensLib } from '../tokens/types'

export type DocumentMeta = Omit<PenpotDocument, 'children' | 'tokens' | 'components'> & {
  tokens?: TokensLib
  components: Record<string, LocalComponent>
}

export const meta = signal<DocumentMeta | null>(null)

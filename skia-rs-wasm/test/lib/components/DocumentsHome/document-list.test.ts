/**
 * The documents screen's behaviour, tested without a DOM (the component itself is
 * presentation only). Page-name search and the Continue fallback chain are the
 * parts most likely to break quietly.
 */

import { describe, expect, it } from 'vitest'
import type { DocumentSummary } from '../../../../src/lib/persistence'
import {
  ALL,
  continueDocument,
  describeEdited,
  describeSize,
  matchesQuery,
  nextCopyName,
  scopeCounts,
  visibleDocuments,
} from '../../../../src/lib/components/DocumentsHome/document-list'

const doc = (
  id: string,
  name: string,
  updatedAt: number,
  pages: Array<[string, number]> = [['Page 1', 0]],
): DocumentSummary => ({
  id,
  name,
  pages: pages.map(([pageName, boardCount], i) => ({
    id: `${id}-p${i}`,
    name: pageName,
    boardCount,
  })),
  createdAt: 0,
  updatedAt,
})

const LIBRARY = [
  doc('a', 'Kestrel onboarding', 300, [
    ['Sign up', 4],
    ['Verify email', 2],
  ]),
  doc('b', 'Marketing site', 200, [['Pricing', 3]]),
  doc('c', 'Checkout', 100, [['Cart', 1]]),
]

describe('search', () => {
  it('matches on the document name', () => {
    expect(matchesQuery(LIBRARY[0]!, 'kestrel')).toBe(true)
    expect(matchesQuery(LIBRARY[0]!, 'KESTREL')).toBe(true)
  })

  it('matches on a page name, which is what people actually remember', () => {
    expect(matchesQuery(LIBRARY[1]!, 'pricing')).toBe(true)
    expect(matchesQuery(LIBRARY[0]!, 'verify')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(matchesQuery(LIBRARY[2]!, 'pricing')).toBe(false)
  })

  it('treats blank and whitespace-only queries as no filter', () => {
    expect(visibleDocuments(LIBRARY, '')).toHaveLength(3)
    expect(visibleDocuments(LIBRARY, '   ')).toHaveLength(3)
  })

  it('filters and orders by recency', () => {
    expect(visibleDocuments(LIBRARY, '').map((d) => d.id)).toEqual(['a', 'b', 'c'])
    expect(visibleDocuments([LIBRARY[2]!, LIBRARY[0]!], '').map((d) => d.id)).toEqual(['a', 'c'])
    expect(visibleDocuments(LIBRARY, 'cart').map((d) => d.id)).toEqual(['c'])
  })
})

describe('scopes', () => {
  const filed = { ...doc('p1', 'Filed', 400), projectId: 'proj-a' }
  const archived = { ...doc('a1', 'Old thing', 500), archived: true }
  const archivedAndFiled = {
    ...doc('a2', 'Old filed thing', 600),
    archived: true,
    projectId: 'proj-a',
  }
  const library = [...LIBRARY, filed, archived, archivedAndFiled]

  it('hides archived documents from All', () => {
    expect(visibleDocuments(library, '', ALL).map((d) => d.id)).toEqual(['p1', 'a', 'b', 'c'])
  })

  it('shows only archived documents in Archive', () => {
    expect(visibleDocuments(library, '', { kind: 'archived' }).map((d) => d.id)).toEqual([
      'a2',
      'a1',
    ])
  })

  it('hides archived documents inside a project too', () => {
    // Archiving has to get something out of the way wherever it was filed,
    // otherwise it only half-works.
    expect(
      visibleDocuments(library, '', { kind: 'project', projectId: 'proj-a' }).map((d) => d.id),
    ).toEqual(['p1'])
  })

  it('combines scope and search', () => {
    expect(visibleDocuments(library, 'filed', { kind: 'archived' }).map((d) => d.id)).toEqual(['a2'])
    expect(visibleDocuments(library, 'kestrel', ALL).map((d) => d.id)).toEqual(['a'])
  })

  it('counts match what each scope shows', () => {
    const counts = scopeCounts(library)
    expect(counts.all).toBe(visibleDocuments(library, '', ALL).length)
    expect(counts.archived).toBe(visibleDocuments(library, '', { kind: 'archived' }).length)
    expect(counts.byProject['proj-a']).toBe(
      visibleDocuments(library, '', { kind: 'project', projectId: 'proj-a' }).length,
    )
  })

  it('counts nothing for a project with only archived documents', () => {
    expect(scopeCounts([archivedAndFiled]).byProject['proj-a']).toBeUndefined()
  })
})

describe('continue', () => {
  it('offers the last-opened document', () => {
    expect(continueDocument(LIBRARY, 'c')!.id).toBe('c')
  })

  it('offers the most recent when nothing was opened', () => {
    expect(continueDocument(LIBRARY, null)!.id).toBe('a')
  })

  it('falls through a stale id rather than offering nothing', () => {
    expect(continueDocument(LIBRARY, 'deleted')!.id).toBe('a')
  })

  it('offers nothing for an empty library', () => {
    expect(continueDocument([], 'a')).toBeNull()
  })

  it('never offers an archived document, even if it was the last one open', () => {
    const archived = { ...doc('z', 'Archived', 999), archived: true }
    expect(continueDocument([...LIBRARY, archived], 'z')!.id).toBe('a')
    expect(continueDocument([archived], 'z')).toBeNull()
  })
})

describe('labels', () => {
  it('pluralizes pages and boards independently', () => {
    expect(describeSize(LIBRARY[0]!)).toBe('2 pages · 6 boards')
    expect(describeSize(LIBRARY[2]!)).toBe('1 page · 1 board')
    expect(describeSize(doc('d', 'Empty', 0, []))).toBe('0 pages · 0 boards')
  })

  it('describes edit times coarsely, and never in the future', () => {
    const now = 1_000_000_000
    const ago = (ms: number) => describeEdited(now - ms, now)
    expect(ago(0)).toBe('Just now')
    expect(ago(30_000)).toBe('Just now')
    expect(ago(60_000)).toBe('1 minute ago')
    expect(ago(5 * 60_000)).toBe('5 minutes ago')
    expect(ago(60 * 60_000)).toBe('1 hour ago')
    expect(ago(26 * 60 * 60_000)).toBe('Yesterday')
    expect(ago(3 * 24 * 60 * 60_000)).toBe('3 days ago')
    expect(ago(8 * 24 * 60 * 60_000)).toBe('Last week')
    expect(ago(20 * 24 * 60 * 60_000)).toBe('2 weeks ago')
    expect(ago(40 * 24 * 60 * 60_000)).toBe('Last month')
    expect(ago(200 * 24 * 60 * 60_000)).toBe('6 months ago')
    // A clock that jumped backwards must not read as "in -3 minutes".
    expect(describeEdited(now + 60_000, now)).toBe('Just now')
  })
})

describe('duplicate naming', () => {
  it('avoids colliding with names already in the library', () => {
    const withCopy = [...LIBRARY, doc('d', 'Checkout copy', 50)]
    expect(nextCopyName(LIBRARY, 'Checkout')).toBe('Checkout copy')
    expect(nextCopyName(withCopy, 'Checkout')).toBe('Checkout copy 2')
    expect(nextCopyName([...withCopy, doc('e', 'Checkout copy 2', 40)], 'Checkout')).toBe(
      'Checkout copy 3',
    )
  })
})

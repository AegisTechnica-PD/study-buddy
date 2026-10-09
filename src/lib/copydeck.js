// Builds the rows for copying a deck's approved cards to another student.
// Definition cards go first with fresh ids, then application questions are re-linked
// to the new copies of the definition cards they were written from.
export function buildCopy(cards, deckId, ownerId, genId = () => globalThis.crypto.randomUUID()) {
  const active = cards.filter((c) => c.status === 'active')
  const base = (c) => ({
    deck_id: deckId,
    owner_id: ownerId,
    front: c.front,
    back: c.back,
    wrong_answers: c.wrong_answers || [],
    kind: c.kind || 'term',
    explanation: c.explanation || null,
    status: 'active'
  })
  const idMap = {}
  const termRows = active
    .filter((c) => (c.kind || 'term') === 'term')
    .map((c) => {
      const id = genId()
      idMap[c.id] = id
      return { id, ...base(c) }
    })
  const scenarioRows = active
    .filter((c) => c.kind === 'scenario')
    .map((c) => ({ ...base(c), concept_card_id: idMap[c.concept_card_id] || null }))
  return { termRows, scenarioRows }
}

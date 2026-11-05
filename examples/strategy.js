// Replace this policy with a solver, LLM, or another strategy. Only your own cards
// and public game state reach this function. Never send your wallet secret to a model.
export function chooseAction(match, random = Math.random) {
  const legal = match.hand.legalActions;
  if (!legal) throw new Error('Strategy called out of turn');
  if (legal.allIn && random() < 0.08) return { action: 'all-in' };
  if (legal.raise && random() < 0.18) return { action: 'raise', amount: legal.raise.min };
  if (legal.check) return { action: 'check' };
  if (random() < 0.08) return { action: 'fold' };
  return { action: 'call' };
}

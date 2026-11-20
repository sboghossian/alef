// Where an agent's car and plane belong once its house may have moved (a sub-district lot of
// Automated Runs, features/auto-districts-lib.ts). Pure; covered by house-home.test.ts.
//
// A moved house parks its car: the lot has no ring road, and a car left on the old city's ring
// would drag the agent's creature, its selection marker and positionOf back to the old city. With
// no car the creature wanders around the moved house and positionOf falls through to the house.
// A plane (the agent visiting another city) leaves from, and returns to, the moved house's lot.

/** The city whose ring road the agent's car drives, or null for no car. */
export function carCity<C>(agent: { id: string; status: string }, flying: boolean, moved: ReadonlyMap<string, C>, home: C | undefined): C | null {
  if (agent.status !== "live" || flying || moved.has(agent.id)) return null;
  return home ?? null;
}

/** The city a plane leaves from and returns to: the moved house's lot, else the agent's home city. */
export function planeHome<C>(agentId: string, moved: ReadonlyMap<string, C>, home: C | undefined): C | undefined {
  return moved.get(agentId) ?? home;
}

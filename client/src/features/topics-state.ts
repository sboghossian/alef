// Round 11 B: the topic-continent layout main.ts computed at load, shared with the topics
// feature (continent signs + borders) and the Districts sidebar (continent grouping). Null when
// the server sent no topics map (older server, first boot): the planet then keeps the classic
// one-city-per-folder layout and every consumer shows nothing extra.

import type * as THREE from "three";
import type { TopicsMap } from "../../../shared/features/topics";
import type { TopicLayout } from "../topic-layout";

export interface TopicsState {
  map: TopicsMap;
  layout: TopicLayout;
  /** Ground height above sea level along a direction (0 on the sea), so border rings hug the land. */
  groundHeight(dir: THREE.Vector3): number;
}

let state: TopicsState | null = null;

export function setTopicsState(s: TopicsState | null): void {
  state = s;
}

export function topicsState(): TopicsState | null {
  return state;
}

/** Sessions the server has classified since this page laid the planet out (they show after a reload). */
let unplaced = 0;
export function setUnplacedSessions(n: number): void {
  unplaced = Math.max(0, n);
}
export function unplacedSessions(): number {
  return unplaced;
}

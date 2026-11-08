// Street routing for the AI on the town map.
//
// tankAI.js drives straight at its goal and steers round whatever is in the
// way (avoidWalls); in open country that is all it needs. In a town the
// straight line runs through three rows of houses and a crew that steers round
// one only finds the next, so the battle hands the AI a waypoint along the
// street graph instead (Battle.navStep -> StreetNav.step):
//
//   * the hull can see its goal down a clear corridor -> null (drive direct);
//   * otherwise a shortest path over world/town.js's street nodes, entered at
//     the nearest node the hull can reach in a straight line and left at the
//     nearest node that can see the goal; the hull is steered at the next node
//     and skips ahead whenever the one after it is already in clear view.
//   * a goal inside a building (a capture ring drawn over a row of houses) is
//     moved to the nearest street node first — written back into the AI's own
//     vector, so its arrival checks agree with where it is actually sent.
//
// Plans are per AI and per goal, refreshed on a timer, so the cost is a few
// dozen solidPushOut() disc tests per crew per second.

import * as THREE from 'three';
import { solidPushOut } from '../world/scenery.js';
import { terrainHeight } from '../world/terrain.js';

const STEP = 2.5;          // m between corridor test discs
const REPLAN = 1.6;        // s between path rebuilds
const GOAL_MOVE = 9;       // m the goal may drift before a rebuild
const ARRIVE = 6.5;        // m: a node counts as reached
const SKIP_EVERY = 0.4;    // s between look-ahead tests
const NEAR_NODES = 7;      // candidates tested for entry and exit
const NEAR_RANGE = 160;    // m

const disc = new THREE.Vector4();
const shove = new THREE.Vector3();

export class StreetNav {
  constructor(plan) {
    this.nodes = plan.nodes.map((n) => ({ id: n.id, x: n.x, z: n.z, links: n.links.slice() }));
    this.state = new WeakMap();
    this.dist = new Float64Array(this.nodes.length);
    this.prev = new Int32Array(this.nodes.length);
    this.done = new Uint8Array(this.nodes.length);
    this.stats = { plans: 0, direct: 0, routed: 0, snapped: 0, tests: 0 };
  }

  blockedAt(x, z, r) {
    disc.set(x, terrainHeight(x, z), z, r);
    this.stats.tests++;
    return solidPushOut(disc, shove);
  }

  // a hull of half-width `half` can drive the straight line a -> b
  clear(ax, az, bx, bz, half) {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / STEP));
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      if (this.blockedAt(ax + (bx - ax) * f, az + (bz - az) * f, half)) return false;
    }
    return true;
  }

  nearest(x, z, out, max = NEAR_NODES) {
    out.length = 0;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d > NEAR_RANGE) continue;
      out.push({ n, d });
    }
    out.sort((a, b) => a.d - b.d);
    if (out.length > max) out.length = max;
    return out;
  }

  // Shortest path from `starts` [{ n, d }] to any of `ends` [{ n, d }].
  route(starts, ends) {
    const N = this.nodes.length;
    const dist = this.dist;
    const prev = this.prev;
    const done = this.done;
    dist.fill(Infinity);
    prev.fill(-1);
    done.fill(0);
    for (const s of starts) {
      if (s.d < dist[s.n.id]) dist[s.n.id] = s.d;
    }
    for (let it = 0; it < N; it++) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < N; i++) {
        if (!done[i] && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u < 0) break;
      done[u] = 1;
      const a = this.nodes[u];
      for (const v of a.links) {
        if (done[v]) continue;
        const b = this.nodes[v];
        const nd = best + Math.hypot(b.x - a.x, b.z - a.z);
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
        }
      }
    }
    let end = -1;
    let endCost = Infinity;
    for (const e of ends) {
      const c = dist[e.n.id] + e.d;
      if (c < endCost) {
        endCost = c;
        end = e.n.id;
      }
    }
    if (end < 0) return null;
    const path = [];
    for (let v = end; v >= 0; v = prev[v]) path.push(v);
    path.reverse();
    return path;
  }

  // The point the AI should steer at on its way to `goal` (the AI's own vector;
  // it may be moved off a building), or null to drive straight at it.
  step(ai, goal, now) {
    const t = ai.tank;
    const half = (t.spec && t.spec.hull ? t.spec.hull.w * 0.5 : 1.6) + 0.3;
    let st = this.state.get(ai);
    if (!st) {
      st = {
        gx: Infinity, gz: Infinity, at: -1e9, path: null, i: 0, direct: false,
        skipAt: -1e9, out: new THREE.Vector3(), near: [], far: [],
      };
      this.state.set(ai, st);
    }
    const px = t.position.x;
    const pz = t.position.z;

    const moved = Math.hypot(goal.x - st.gx, goal.z - st.gz) > GOAL_MOVE;
    if (moved || now - st.at > REPLAN) {
      st.at = now;
      this.stats.plans++;
      // a goal inside a house is no goal: the nearest street node instead
      if (this.blockedAt(goal.x, goal.z, half)) {
        const cand = this.nearest(goal.x, goal.z, st.far, 1);
        if (cand.length) {
          goal.x = cand[0].n.x;
          goal.z = cand[0].n.z;
          this.stats.snapped++;
        }
      }
      st.gx = goal.x;
      st.gz = goal.z;
      st.path = null;
      st.i = 0;
      st.direct = this.clear(px, pz, goal.x, goal.z, half);
      if (st.direct) {
        this.stats.direct++;
      } else {
        const starts = this.nearest(px, pz, st.near).filter((c) => this.clear(px, pz, c.n.x, c.n.z, half));
        if (!starts.length) {
          const any = this.nearest(px, pz, st.near, 1);
          if (any.length) starts.push(any[0]);
        }
        const ends = this.nearest(goal.x, goal.z, st.far).filter((c) => this.clear(c.n.x, c.n.z, goal.x, goal.z, half));
        if (!ends.length) {
          const any = this.nearest(goal.x, goal.z, st.far, 1);
          if (any.length) ends.push(any[0]);
        }
        st.path = starts.length && ends.length ? this.route(starts, ends) : null;
        if (st.path) this.stats.routed++;
      }
    }
    if (st.direct || !st.path) return null;

    // follow: advance on arrival, skip ahead when the next node is in view
    while (st.i < st.path.length) {
      const n = this.nodes[st.path[st.i]];
      if (Math.hypot(n.x - px, n.z - pz) < ARRIVE) st.i++;
      else break;
    }
    if (st.i < st.path.length && now - st.skipAt > SKIP_EVERY) {
      st.skipAt = now;
      const nextI = st.i + 1;
      if (nextI < st.path.length) {
        const nx = this.nodes[st.path[nextI]];
        if (this.clear(px, pz, nx.x, nx.z, half)) st.i = nextI;
      } else if (this.clear(px, pz, goal.x, goal.z, half)) {
        st.i = st.path.length;
      }
    }
    if (st.i >= st.path.length) return null;
    const n = this.nodes[st.path[st.i]];
    return st.out.set(n.x, goal.y, n.z);
  }
}

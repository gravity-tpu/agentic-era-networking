/**
 * routing-verifier.ts
 * Symbolic Neuro-Symbolic Verifier (Demis Hassabis & Oriol Vinyals Paradigm)
 *
 * Invariant:
 * - Autonomous agents may probabilistically propose dynamic SDN routes.
 * - Before ANY proposed route update is committed to the data plane, this symbolic
 *   verifier must formally prove that the resulting graph is a strictly loop-free DAG.
 */

export interface NetworkHop {
  readonly fromNode: string;
  readonly toNode: string;
  readonly cost: number;
}

export class RoutingLoopDetectedError extends Error {
  constructor(public readonly cyclePath: string[]) {
    super(`Symbolic Verification Rejected: Routing loop detected along cycle [${cyclePath.join(' -> ')}]`);
    this.name = 'RoutingLoopDetectedError';
  }
}

export class SymbolicRouteVerifier {
  /**
   * Formally verifies that a set of proposed network hops produces a loop-free DAG.
   * Throws RoutingLoopDetectedError immediately if a cycle is discovered.
   */
  public static verifyLoopFree(hops: ReadonlyArray<NetworkHop>): boolean {
    const adj = new Map<string, string[]>();

    for (const hop of hops) {
      if (hop.fromNode === hop.toNode) {
        throw new RoutingLoopDetectedError([hop.fromNode, hop.toNode]);
      }
      const neighbors = adj.get(hop.fromNode) ?? [];
      neighbors.push(hop.toNode);
      adj.set(hop.fromNode, neighbors);
    }

    // 0 = unvisited, 1 = visiting (in recursion stack), 2 = completely visited
    const visited = new Map<string, 0 | 1 | 2>();
    const recursionStack: string[] = [];

    const hasCycle = (node: string): boolean => {
      visited.set(node, 1);
      recursionStack.push(node);

      const neighbors = adj.get(node) ?? [];
      for (const next of neighbors) {
        const state = visited.get(next) ?? 0;
        if (state === 1) {
          // Cycle found
          const cycleStart = recursionStack.indexOf(next);
          const cycle = [...recursionStack.slice(cycleStart), next];
          throw new RoutingLoopDetectedError(cycle);
        }
        if (state === 0 && hasCycle(next)) {
          return true;
        }
      }

      recursionStack.pop();
      visited.set(node, 2);
      return false;
    };

    for (const node of adj.keys()) {
      if ((visited.get(node) ?? 0) === 0) {
        if (hasCycle(node)) return false;
      }
    }

    return true;
  }
}

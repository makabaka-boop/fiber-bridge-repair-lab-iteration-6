/**
 * 删边预言机（仅测试用的朴素参考实现）：
 * 对每条链路逐一删除，再用 BFS 检查图是否仍连通；不连通即为桥，
 * 较小连通块站点数由 BFS 触达数与 n 之差取最小。
 *
 * O(E·(V+E))，仅用于在随机小图上核对生产算法，不参与上限性能路径。
 */
import type { BaselineResult, NormalizedTopology } from './types';

export function oracleBaseline(t: NormalizedTopology): BaselineResult {
  const n = t.sites.length;
  const index = new Map<string, number>();
  t.sites.forEach((s, i) => index.set(s, i));

  const undirected = t.links.map((l) => [index.get(l.u)!, index.get(l.v)!] as const);

  const reachableWithout = (skipEdge: number): number => {
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    seen[0] = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let e = 0; e < undirected.length; e++) {
        if (e === skipEdge) continue;
        const [a, b] = undirected[e];
        let w = -1;
        if (a === v) w = b;
        else if (b === v) w = a;
        if (w !== -1 && !seen[w]) {
          seen[w] = 1;
          queue[tail++] = w;
        }
      }
    }
    return tail;
  };

  const bridges = [];
  for (let e = 0; e < t.links.length; e++) {
    const reached = reachableWithout(e);
    if (reached < n) {
      const link = t.links[e];
      bridges.push({
        id: link.id,
        u: link.u,
        v: link.v,
        smallerSide: Math.min(reached, n - reached),
      });
    }
  }
  bridges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { siteCount: n, linkCount: t.links.length, bridges };
}

/**
 * 删边预言机校验“试接后”结论：在原图 + 虚拟边 (a,b) 上逐一删边。
 * 返回仍脆弱的链路编号集合与（相对原基线）被消除的编号集合。
 */
export function oracleTrial(
  t: NormalizedTopology,
  baseline: BaselineResult,
  a: string,
  b: string,
): { stillFragile: Set<string>; removed: Set<string> } {
  const n = t.sites.length;
  const index = new Map<string, number>();
  t.sites.forEach((s, i) => index.set(s, i));
  const edges = t.links.map((l) => [index.get(l.u)!, index.get(l.v)!] as const);
  const va = index.get(a)!;
  const vb = index.get(b)!;
  const virtual = edges.length;
  edges.push([va, vb]);

  const connectedAfterRemove = (skip: number): boolean => {
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    seen[0] = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let e = 0; e < edges.length; e++) {
        if (e === skip) continue;
        const [p, q] = edges[e];
        let w = -1;
        if (p === v) w = q;
        else if (q === v) w = p;
        if (w !== -1 && !seen[w]) {
          seen[w] = 1;
          queue[tail++] = w;
        }
      }
    }
    return tail === n;
  };

  const stillFragile = new Set<string>();
  const removed = new Set<string>();
  for (const bridge of baseline.bridges) {
    const e = t.links.findIndex((l) => l.id === bridge.id);
    if (connectedAfterRemove(e)) removed.add(bridge.id);
    else stillFragile.add(bridge.id);
  }
  void virtual;
  return { stillFragile, removed };
}

/**
 * 删边预言机校验“检修替换预演”：先按链路编号精确摘除 removedId，
 * 再追加一条临时备纤 (a,b)，在得到的临时图上**逐边删除**判定桥。
 *
 * 独立于生产实现：临时链路编号由调用方给出（核对其不与导入编号碰撞），
 * 预言机完全按边的下标工作，不复用 Analyzer 的任何索引。
 *
 * 返回：
 *  - connected：替换后的图是否连通（不连通时生产侧必须拒绝、不产出结果）；
 *  - bridgeIds：替换后图中的全部桥编号集合（含临时备纤编号）；
 *  - edgeIds：临时图中除被摘除链路外的原始链路编号（按下标序），
 *    供测试映射“仍为桥 / 新变成桥”。
 */
export function oracleReplacement(
  t: NormalizedTopology,
  removedId: string,
  a: string,
  b: string,
  temporaryId: string,
): { connected: boolean; bridgeIds: Set<string>; edgeIds: string[] } {
  const n = t.sites.length;
  const index = new Map<string, number>();
  t.sites.forEach((s, i) => index.set(s, i));

  const removedIndex = t.links.findIndex((l) => l.id === removedId);
  if (removedIndex === -1) throw new Error(`oracle：链路 ${removedId} 不存在`);

  const kept = t.links.filter((_, e) => e !== removedIndex);
  const edges = kept.map((l) => [index.get(l.u)!, index.get(l.v)!] as const);
  edges.push([index.get(a)!, index.get(b)!]);
  const edgeIds = [...kept.map((l) => l.id), temporaryId];

  const reachable = (skip: number): number => {
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    seen[0] = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let e = 0; e < edges.length; e++) {
        if (e === skip) continue;
        const [p, q] = edges[e];
        let w = -1;
        if (p === v) w = q;
        else if (q === v) w = p;
        if (w !== -1 && !seen[w]) {
          seen[w] = 1;
          queue[tail++] = w;
        }
      }
    }
    return tail;
  };

  // 不删任何边先确认替换图整体连通
  const connected = reachable(-1) === n;
  const bridgeIds = new Set<string>();
  for (let e = 0; e < edges.length; e++) {
    if (reachable(e) < n) bridgeIds.add(edgeIds[e]);
  }
  return { connected, bridgeIds, edgeIds };
}

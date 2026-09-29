/**
 * 检修替换预演：以**独立的逐边删除预言机**核对生产实现。
 *
 * 预言机完全不经过生产的 Tarjan / 父树：直接构建“摘除一条链路 + 加入一条
 * 临时备纤”的朴素边表，先 BFS 判定替换后是否连通；连通时再对每条存活链路
 * 逐一删除后 BFS 判桥，并以 BFS 触达数给出较小侧站点数。临时备纤以一个
 * 独立的“虚拟边”参与，单独核对其桥属性。
 *
 * 覆盖：原桥、非桥、平行边（各保 ID 身份）、替换后仍脆弱（备纤自身成桥 /
 * 原链路新成桥）、摘除后无法恢复连通、非法链路与端点、失败隔离、
 * 内部临时边编号不与导入编号碰撞、基线不可变。
 */
import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { parseTopology } from './parse';
import { Rng } from './rng';
import type { NormalizedTopology } from './types';

interface OracleEdge {
  /** 原始链路导入下标；临时备纤为 -1（内部编号不与导入编号碰撞） */
  orig: number;
  u: number;
  v: number;
}

interface OracleResult {
  connected: boolean;
  reached?: number;
  /** 替换后仍为桥的原始链路下标 */
  stillBridges: Set<number>;
  /** 替换后新变成桥的原始链路下标（原基线非桥） */
  newBridges: Set<number>;
  /** 相对基线被临时备纤消除的原桥下标（被摘除者不在内） */
  clearedBridges: Set<number>;
  /** 原始下标 → 替换后较小侧站点数（仍为桥 / 新成桥者） */
  smaller: Map<number, number>;
  tempIsBridge: boolean;
  tempSmaller: number;
}

/**
 * 独立预言机：摘除 skipEdge（导入下标）并加入临时备纤 (a,b)。
 * baseBridge 为原基线桥下标集合。
 */
function oracleReplacement(
  t: NormalizedTopology,
  baseBridge: Set<number>,
  skipEdge: number,
  a: string,
  b: string,
): OracleResult {
  const n = t.sites.length;
  const index = new Map<string, number>();
  t.sites.forEach((s, i) => index.set(s, i));

  const edges: OracleEdge[] = [];
  for (let e = 0; e < t.links.length; e++) {
    if (e === skipEdge) continue;
    edges.push({ orig: e, u: index.get(t.links[e].u)!, v: index.get(t.links[e].v)! });
  }
  const tempIdx = edges.length;
  edges.push({ orig: -1, u: index.get(a)!, v: index.get(b)! });

  // 忽略 skipEdge 时无需特殊处理：边表中根本不含它
  const reachCount = (forbidden: number): number => {
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    queue[tail++] = 0;
    seen[0] = 1;
    while (head < tail) {
      const v = queue[head++];
      for (let k = 0; k < edges.length; k++) {
        if (k === forbidden) continue;
        const ed = edges[k];
        let w = -1;
        if (ed.u === v) w = ed.v;
        else if (ed.v === v) w = ed.u;
        if (w !== -1 && !seen[w]) {
          seen[w] = 1;
          queue[tail++] = w;
        }
      }
    }
    return tail;
  };

  const res: OracleResult = {
    connected: false,
    stillBridges: new Set(),
    newBridges: new Set(),
    clearedBridges: new Set(),
    smaller: new Map(),
    tempIsBridge: false,
    tempSmaller: 0,
  };

  const reached = reachCount(-1);
  if (reached < n) {
    res.reached = reached;
    return res;
  }
  res.connected = true;

  for (let k = 0; k < edges.length; k++) {
    const r = reachCount(k);
    if (r < n) {
      const side = Math.min(r, n - r);
      if (k === tempIdx) {
        res.tempIsBridge = true;
        res.tempSmaller = side;
      } else {
        const orig = edges[k].orig;
        if (baseBridge.has(orig)) res.stillBridges.add(orig);
        else res.newBridges.add(orig);
        res.smaller.set(orig, side);
      }
    } else if (k !== tempIdx) {
      const orig = edges[k].orig;
      if (baseBridge.has(orig)) res.clearedBridges.add(orig);
    }
  }
  return res;
}

/**
 * 生成随机连通无向多重图：随机生成树保证连通，再追加随机边（允许平行边）。
 */
function randomConnectedGraph(rng: Rng, n: number, extraEdges: number): NormalizedTopology {
  const sites: string[] = [];
  for (let i = 0; i < n; i++) sites[i] = `S-${(1000 + i).toString(16)}`;
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [sites[i], sites[j]] = [sites[j], sites[i]];
  }

  const raw: { id: string; u: string; v: string }[] = [];
  const usedIds = new Set<string>();
  let seq = 0;
  const newId = () => {
    let id: string;
    do {
      id = `e${(rng.int(9000) + 100).toString(36)}-${seq++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) raw.push({ id: newId(), u: order[i], v: order[rng.int(i)] });
  for (let k = 0; k < extraEdges; k++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}

const idsOf = (infos: { id: string }[]): Set<string> => new Set(infos.map((x) => x.id));

describe('检修替换预演 vs 逐边删除预言机（随机连通多重小图）', () => {
  it('随机图逐链路摘除、随机备纤端点：连通时四类清单与备纤桥属性逐项一致', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rng = new Rng(seed * 2246822519 + 7);
      const n = 2 + rng.int(8); // 2–9 站
      const g = randomConnectedGraph(rng, n, rng.int(n * 2));
      const analyzer = new Analyzer(g);
      const baseEdges = new Set<number>();
      const baseIds = new Set(analyzer.baseline.bridges.map((x) => x.id));
      g.links.forEach((l, e) => {
        if (baseIds.has(l.id)) baseEdges.add(e);
      });

      // 每个图随机挑若干链路摘除，备纤端点也随机
      const picks = 1 + rng.int(Math.min(3, g.links.length));
      const chosen = new Set<number>();
      while (chosen.size < picks) chosen.add(rng.int(g.links.length));

      for (const skip of chosen) {
        const a = g.sites[rng.int(n)];
        let b = g.sites[rng.int(n)];
        while (b === a) b = g.sites[rng.int(n)];

        const oracle = oracleReplacement(g, baseEdges, skip, a, b);

        if (!oracle.connected) {
          // 无法恢复连通：生产端必须拒绝，不生成结果
          expect(() => analyzer.rehearseReplacement(g.links[skip].id, a, b)).toThrow(/仍不连通/);
          continue;
        }

        const got = analyzer.rehearseReplacement(g.links[skip].id, a, b);

        // 被摘除链路：状态已移除，携带原桥诊断，且绝不混入任一存活清单
        expect(got.removedLink.id).toBe(g.links[skip].id);
        expect(got.removedLink.wasBaselineBridge).toBe(baseEdges.has(skip));
        const allSurviving = new Set([
          ...got.stillBridges.map((x) => x.id),
          ...got.newBridges.map((x) => x.id),
          ...got.clearedBridges.map((x) => x.id),
        ]);
        expect(allSurviving.has(g.links[skip].id)).toBe(false);

        const wantStill = idsOf([...oracle.stillBridges].map((e) => ({ id: g.links[e].id })));
        const wantNew = idsOf([...oracle.newBridges].map((e) => ({ id: g.links[e].id })));
        const wantCleared = idsOf([...oracle.clearedBridges].map((e) => ({ id: g.links[e].id })));

        expect(idsOf(got.stillBridges)).toEqual(wantStill);
        expect(idsOf(got.newBridges)).toEqual(wantNew);
        expect(idsOf(got.clearedBridges)).toEqual(wantCleared);

        // 四个集合互斥且完备：仍桥 + 新桥 + 消除 = 存活链路中参与基线/余网的全部桥变化
        expect(got.stillBridges.length + got.newBridges.length).toBe(
          oracle.stillBridges.size + oracle.newBridges.size,
        );

        // 较小侧站点数与 BFS 预言机一致
        for (const info of [...got.stillBridges, ...got.newBridges]) {
          const e = g.links.findIndex((l) => l.id === info.id);
          expect(info.smallerSide).toBe(oracle.smaller.get(e));
        }

        // 临时备纤桥属性单独核对
        expect(got.temporaryFiber.a).toBe(a);
        expect(got.temporaryFiber.b).toBe(b);
        expect(got.temporaryFiber.isBridge).toBe(oracle.tempIsBridge);
        expect(got.temporaryFiber.smallerSide).toBe(oracle.tempSmaller);

        // 各清单严格按 UTF-8 字节序
        for (const list of [got.stillBridges, got.newBridges, got.clearedBridges]) {
          const ids = list.map((x) => x.id);
          expect(ids).toEqual([...ids].sort());
        }

        expect(got.siteCount).toBe(n);
        expect(got.survivingLinkCount).toBe(g.links.length - 1);
        expect(got.baselineCount).toBe(analyzer.baseline.bridges.length);
      }
    }
  });
});

describe('检修替换预演：典型固定拓扑', () => {
  it('长链摘除中间桥后跨接备纤恢复连通：其余原桥仍为桥，备纤自身成为新桥', () => {
    // 0-1-2-3-4 全桥；摘除桥 L3（2-3）后余网裂为两段，任何跨接备纤都是新桥
    const sites = ['v0', 'v1', 'v2', 'v3', 'v4'];
    const links = [
      { id: 'L1', u: 'v0', v: 'v1' },
      { id: 'L2', u: 'v1', v: 'v2' },
      { id: 'L3', u: 'v2', v: 'v3' },
      { id: 'L4', u: 'v3', v: 'v4' },
    ];
    const t: NormalizedTopology = { sites, links };
    const analyzer = new Analyzer(t);
    expect(analyzer.baseline.bridges).toHaveLength(4);

    // 摘除 L3、备纤 v0-v4（跨两段）：L1,L2,L4 仍为桥，无原桥被消除，备纤是新单点
    const r = analyzer.rehearseReplacement('L3', 'v0', 'v4');
    expect(r.removedLink.id).toBe('L3');
    expect(r.removedLink.wasBaselineBridge).toBe(true);
    expect(idsOf(r.stillBridges)).toEqual(new Set(['L1', 'L2', 'L4']));
    expect(r.newBridges).toHaveLength(0);
    expect(r.clearedBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(true);
    expect(r.temporaryFiber.smallerSide).toBe(2); // {v0,v1,v2} 对 {v3,v4}
  });

  it('摘除桥后备纤恰好平行补回缺口：其余原桥仍为桥，备纤仍为桥（裂段间唯一边）', () => {
    // v0-v1-v2-v3 链，摘除桥 L2（v1-v2），备纤 v1-v2：L1,L3 仍桥，
    // 备纤是两段之间唯一连线，仍是桥（并未形成环）
    const t: NormalizedTopology = {
      sites: ['v0', 'v1', 'v2', 'v3'],
      links: [
        { id: 'L1', u: 'v0', v: 'v1' },
        { id: 'L2', u: 'v1', v: 'v2' },
        { id: 'L3', u: 'v2', v: 'v3' },
      ],
    };
    const analyzer = new Analyzer(t);
    const r = analyzer.rehearseReplacement('L2', 'v1', 'v2');
    expect(idsOf(r.stillBridges)).toEqual(new Set(['L1', 'L3']));
    expect(r.newBridges).toHaveLength(0);
    expect(r.clearedBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(true);
    expect(r.temporaryFiber.smallerSide).toBe(2); // {v0,v1} 对 {v2,v3}
  });

  it('摘除非桥（环边）且备纤原样补回：拓扑等价恢复，全无桥', () => {
    // 三角形摘除 ab（非桥），备纤 a-b 原样补回：仍是三角形，无桥，备纤非桥
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'ab', u: 'a', v: 'b' },
          { id: 'bc', u: 'b', v: 'c' },
          { id: 'ca', u: 'c', v: 'a' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    const r = analyzer.rehearseReplacement('ab', 'a', 'b');
    expect(r.stillBridges).toHaveLength(0);
    expect(r.newBridges).toHaveLength(0);
    expect(r.clearedBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(false);
  });

  it('摘除平行热备之一（非桥）：另一条平行边新变成桥，备纤平行尾桥消除原基线桥', () => {
    // a-b 有 p1,p2 两条平行（均非桥），b-c 为悬挂基线桥 tail。
    // 摘除 p1（非桥，余网仍连通），备纤 b-c 与 tail 平行：
    // p2 成为 a-b 唯一边 → 新变成桥；tail 被备纤消除；备纤非桥。
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'p1', u: 'a', v: 'b' },
          { id: 'p2', u: 'a', v: 'b' },
          { id: 'tail', u: 'b', v: 'c' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    expect(analyzer.baseline.bridges.map((x) => x.id)).toEqual(['tail']);
    const r = analyzer.rehearseReplacement('p1', 'b', 'c');
    expect(r.removedLink.wasBaselineBridge).toBe(false);
    expect(idsOf(r.newBridges)).toEqual(new Set(['p2']));
    expect(r.newBridges[0].smallerSide).toBe(1); // 断开 p2 隔离 {a} 一个站点
    expect(idsOf(r.clearedBridges)).toEqual(new Set(['tail']));
    expect(r.stillBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(false);
    expect(r.survivingLinkCount).toBe(2);
  });

  it('环+悬挂链：摘除环边后跨接备纤可消除尾桥，同时另一条环边新变成桥', () => {    // 环 a-b-c-a ＋ 悬挂 c-d（cd 为基线桥）。摘除环边 ab（非桥），备纤 b-d：
    // 新环 b-c-d-b 上 bc/cd/备纤均非桥 ⇒ 尾桥 cd 被消除；a 经 ca 悬挂 ⇒ ca 新变成桥
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: 'ab', u: 'a', v: 'b' },
          { id: 'bc', u: 'b', v: 'c' },
          { id: 'ca', u: 'c', v: 'a' },
          { id: 'cd', u: 'c', v: 'd' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    expect(analyzer.baseline.bridges.map((x) => x.id)).toEqual(['cd']);
    const r = analyzer.rehearseReplacement('ab', 'b', 'd');
    expect(idsOf(r.newBridges)).toEqual(new Set(['ca']));
    expect(r.newBridges[0].smallerSide).toBe(1);
    expect(idsOf(r.clearedBridges)).toEqual(new Set(['cd']));
    expect(r.stillBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(false);
  });

  it('摘除桥且备纤接在同一侧：余网仍不连通，拒绝且不生成结果；跨接才恢复', () => {
    // 链 a-b-c，摘除桥 L1（a-b），备纤 b-c 只连在 {b,c} 一侧，a 被孤立
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'L1', u: 'a', v: 'b' },
          { id: 'L2', u: 'b', v: 'c' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    expect(() => analyzer.rehearseReplacement('L1', 'b', 'c')).toThrow(/仍不连通/);
    // 备纤 a-b 跨接两段才恢复：L2 仍桥，备纤是裂段间唯一边（桥）
    const r = analyzer.rehearseReplacement('L1', 'a', 'b');
    expect(idsOf(r.stillBridges)).toEqual(new Set(['L2']));
    expect(r.temporaryFiber.isBridge).toBe(true);
    expect(r.temporaryFiber.smallerSide).toBe(1);
  });
});

describe('检修替换预演：契约与失败隔离', () => {
  const t = parseTopology(
    JSON.stringify({
      sites: ['a', 'b', 'c'],
      links: [
        { id: 'L1', u: 'a', v: 'b' },
        { id: 'L2', u: 'b', v: 'c' },
      ],
    }),
  );

  it('拒绝不存在 / 为空的链路 ID，且错误原样携带编号', () => {
    const analyzer = new Analyzer(t);
    expect(() => analyzer.rehearseReplacement('ghost', 'a', 'c')).toThrow(/链路 "ghost" 不在当前链路清单/);
    expect(() => analyzer.rehearseReplacement('', 'a', 'c')).toThrow(/被摘除链路编号/);
    expect(() => analyzer.rehearseReplacement(null, 'a', 'c')).toThrow(/非空字符串或整数/);
    expect(() => analyzer.rehearseReplacement(123, 'a', 'c')).toThrow(/链路 "123" 不在当前链路清单/);
  });

  it('拒绝不存在端点、相同端点与空端点', () => {
    const analyzer = new Analyzer(t);
    expect(() => analyzer.rehearseReplacement('L1', 'a', 'a')).toThrow(/必须不同/);
    expect(() => analyzer.rehearseReplacement('L1', 'a', 'zzz')).toThrow(/"zzz" 不在当前站点清单/);
    expect(() => analyzer.rehearseReplacement('L1', '  ', 'c')).toThrow(/"  " 不在当前站点清单/);
    expect(() => analyzer.rehearseReplacement('L1', '', 'c')).toThrow(/端点 A/);
  });

  it('链路与端点编号逐字符精确匹配，带空白编号不被 trim 改写', () => {
    const tws = parseTopology(
      JSON.stringify({
        sites: ['a', ' a ', 'b'],
        links: [
          { id: 'L1', u: 'a', v: ' a ' },
          { id: 'L2', u: ' a ', v: 'b' },
        ],
      }),
    );
    const analyzer = new Analyzer(tws);
    // 摘除基线桥 L1（a—' a '）裂出 {a}；备纤 'a'->'b' 跨接两段恢复连通，
    // 但它是两段间唯一边：L2 仍为桥，备纤成桥，没有原桥被消除。
    const r = analyzer.rehearseReplacement('L1', 'a', 'b');
    expect(idsOf(r.stillBridges)).toEqual(new Set(['L2']));
    expect(r.clearedBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(true);
    // ' a'（缺尾空白）是不存在的站点，原样报错
    expect(() => analyzer.rehearseReplacement('L2', 'a', ' a')).toThrow(/" a" 不在当前站点清单/);
  });

  it('失败尝试不产生结果；调用方保留上次成功预演；基线与原拓扑不变', () => {
    const analyzer = new Analyzer(t);
    const beforeBaseline = JSON.stringify(analyzer.baseline);
    const ok = analyzer.rehearseReplacement('L1', 'a', 'b'); // 成功：补回缺口，L2 仍桥
    expect(idsOf(ok.stillBridges)).toEqual(new Set(['L2']));

    // 之后多次失败均抛错，analyzer 无状态可改；再次成功结果独立正确
    expect(() => analyzer.rehearseReplacement('nope', 'a', 'b')).toThrow();
    expect(() => analyzer.rehearseReplacement('L1', 'b', 'b')).toThrow();
    expect(() => analyzer.rehearseReplacement('L2', 'a', 'b')).toThrow(/仍不连通/);

    const ok2 = analyzer.rehearseReplacement('L2', 'b', 'c');
    expect(idsOf(ok2.stillBridges)).toEqual(new Set(['L1']));
    // 基线与原拓扑对象从未被改写
    expect(JSON.stringify(analyzer.baseline)).toBe(beforeBaseline);
    expect(t.links.map((l) => l.id)).toEqual(['L1', 'L2']);
  });

  it('临时备纤为内部临时边，编号空间不与导入链路碰撞（极端 ID 亦不冲突）', () => {
    // 导入链路 ID 故意取为可能与内部表示混淆的值；内部仅用下标 m，不持有这些 ID
    const t2 = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd'],
        links: [
          { id: '0', u: 'a', v: 'b' },
          { id: '1', u: 'b', v: 'c' },
          { id: '3', u: 'c', v: 'd' },
          { id: 'temp', u: 'a', v: 'd' },
        ],
      }),
    );
    const analyzer = new Analyzer(t2);
    // 图本为环，无桥；摘除 'temp'（环边）后备纤 a-d 补回，仍为环、全无桥
    const r = analyzer.rehearseReplacement('temp', 'a', 'd');
    expect(r.stillBridges).toHaveLength(0);
    expect(r.newBridges).toHaveLength(0);
    expect(r.temporaryFiber.isBridge).toBe(false);
    expect(r.survivingLinkCount).toBe(3);
  });
});

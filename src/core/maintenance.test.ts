import { describe, expect, it } from 'vitest';
import { Analyzer } from './analysis';
import { parseTopology } from './parse';
import { oracleBaseline, oracleReplacement } from './oracle';
import { Rng } from './rng';
import type { NormalizedTopology } from './types';

/**
 * 随机连通无向多重图（与 analysis.test.ts 同款生成器，独立内联以隔离演进）：
 * 先生成随机生成树保证连通，再追加随机边（允许平行边、允许重复同一对）。
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
      id = `m${(rng.int(9000) + 100).toString(36)}-${seq++}`;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  const order = sites.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let i = 1; i < n; i++) {
    raw.push({ id: newId(), u: order[i], v: order[rng.int(i)] });
  }
  for (let k2 = 0; k2 < extraEdges; k2++) {
    const u = sites[rng.int(n)];
    let v = sites[rng.int(n)];
    while (v === u) v = sites[rng.int(n)];
    raw.push({ id: newId(), u, v });
  }
  return { sites, links: raw };
}

/** 枚举一张小图上全部不同站点对（临时备纤候选端点） */
function allPairs(sites: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) pairs.push([sites[i], sites[j]]);
  }
  return pairs;
}

describe('检修替换预演 vs 逐边删除独立预言机（随机小图）', () => {
  it('逐链路摘除 × 逐端点对试接：桥分类、连通性与临时备纤身份全部一致', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rng = new Rng(seed * 48271 + 7);
      const n = 2 + rng.int(7); // 2–8 站点
      const g = randomConnectedGraph(rng, n, rng.int(n * 3));
      const analyzer = new Analyzer(g);
      const baseline = oracleBaseline(g);
      const baselineIds = new Set(baseline.bridges.map((b) => b.id));

      // 逐条链路作为被检修对象
      for (const link of g.links) {
        for (const [a, b] of allPairs(g.sites)) {
          const oracle = oracleReplacement(g, link.id, a, b, '临时备纤#oracle');

          let result: ReturnType<Analyzer['rehearseMaintenance']> | null = null;
          let threw = false;
          try {
            result = analyzer.rehearseMaintenance(link.id, a, b);
          } catch {
            threw = true;
          }

          // 不连通：生产侧必须拒绝；连通：必须产出结果
          expect(threw).toBe(!oracle.connected);
          if (!oracle.connected) {
            expect(result).toBeNull();
            continue;
          }
          expect(result).not.toBeNull();
          const res = result!;

          // 被摘除链路标记“已移除”，且绝不进入任何桥清单（不算被备纤消除）
          expect(res.removedLink).toEqual({ id: link.id, u: link.u, v: link.v, status: 'removed' });
          const stillIds = new Set(res.stillBridges.map((x) => x.id));
          const newIds = new Set(res.newBridges.map((x) => x.id));
          expect(stillIds.has(link.id)).toBe(false);
          expect(newIds.has(link.id)).toBe(false);

          // 临时图中的原始链路桥（排除临时备纤自身）
          const keptEdges = oracle.edgeIds.slice(0, -1);
          const expectedStill = new Set<string>();
          const expectedNew = new Set<string>();
          for (const id of keptEdges) {
            if (!oracle.bridgeIds.has(id)) continue;
            if (baselineIds.has(id)) expectedStill.add(id);
            else expectedNew.add(id);
          }
          expect(stillIds).toEqual(expectedStill);
          expect(newIds).toEqual(expectedNew);

          // 临时备纤是否为桥单独一致
          expect(res.temporaryIsBridge).toBe(oracle.bridgeIds.has('临时备纤#oracle'));

          // 仍为桥 / 新变成桥清单均按 UTF-8 字节序，且彼此互斥
          const allSorted = (arr: { id: string }[]) => arr.map((x) => x.id);
          expect(allSorted(res.stillBridges)).toEqual([...stillIds].sort());
          expect(allSorted(res.newBridges)).toEqual([...newIds].sort());
          for (const id of stillIds) expect(newIds.has(id)).toBe(false);

          // 仍为桥者必为基线桥；新变成桥者原必非桥
          for (const id of stillIds) expect(baselineIds.has(id)).toBe(true);
          for (const id of newIds) expect(baselineIds.has(id)).toBe(false);
        }
      }
    }
  });

  it('预演不改写基线与原拓扑（隔离临时图生命周期）', () => {
    const rng = new Rng(20240929);
    const g = randomConnectedGraph(rng, 7, 8);
    const analyzer = new Analyzer(g);
    const snapshot = JSON.stringify(analyzer.baseline);
    const linkSnapshot = JSON.stringify(g.links);

    // 含一次会失败（摘除无热备桥且备纤接不回）和多次成功
    expect(() => analyzer.rehearseMaintenance(g.links[0].id, g.sites[0], g.sites[0])).toThrow();
    for (const link of g.links.slice(0, 4)) {
      try {
        analyzer.rehearseMaintenance(link.id, g.sites[0], g.sites[g.sites.length - 1]);
      } catch {
        /* 允许不连通失败 */
      }
    }
    expect(JSON.stringify(analyzer.baseline)).toBe(snapshot);
    expect(JSON.stringify(g.links)).toBe(linkSnapshot);
  });
});

describe('检修替换预演：平行边保持各自 ID 身份', () => {
  const topology = (extraParallel: boolean) =>
    parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'p1', u: 'a', v: 'b' },
          { id: 'p2', u: 'a', v: 'b' },
          { id: 'tail', u: 'b', v: 'c' },
          // 可选的 c-a 回边，使摘除 tail 后接备纤的场景连通
          ...(extraParallel ? [{ id: 'ca', u: 'c', v: 'a' }] : []),
        ],
      }),
    );

  it('摘除一条平行边：另一条以原 ID 成为新桥，被摘除者不算被消除', () => {
    const t = topology(false);
    const analyzer = new Analyzer(t);
    expect(analyzer.baseline.bridges.map((x) => x.id)).toEqual(['tail']);

    // 摘除 p1（原非桥），余网 p2(a-b)-tail(b-c) 仍连通；备纤 b-c 与 tail
    // 平行消除了基线桥 tail，却使 p2 成为 a 的唯一链路（新单点故障）。
    const res = analyzer.rehearseMaintenance('p1', 'b', 'c');
    expect(res.removedLink.id).toBe('p1');
    expect(res.newBridges.map((x) => x.id)).toEqual(['p2']);
    // tail 是被备纤真正消除的基线桥：既不在仍为桥、也不在新成桥清单
    expect(res.stillBridges.map((x) => x.id)).toEqual([]);
    // 备纤与 tail 平行，自身非桥
    expect(res.temporaryIsBridge).toBe(false);

    // 按 ID 精确：摘除 p2 时 p1 以自身身份成为新桥（不与 p1/p2 混淆）
    const res2 = analyzer.rehearseMaintenance('p2', 'b', 'c');
    expect(res2.removedLink.id).toBe('p2');
    expect(res2.newBridges.map((x) => x.id)).toEqual(['p1']);
    expect(res2.stillBridges.map((x) => x.id)).toEqual([]);
  });

  it('摘除桥 tail 后无论是否试接，只要不恢复连通即拒绝；接回后才出结果', () => {
    const t = topology(false);
    const analyzer = new Analyzer(t);
    // tail 是唯一连接 c 的链路：摘除后 c 孤立，不涉及 c 的备纤（a-b）救不回，必失败
    expect(() => analyzer.rehearseMaintenance('tail', 'a', 'b')).toThrow(/余网仍不连通/);

    // 存在 c-a 回边 ca 时，摘除 tail：c 经 ca 仍连通（余网不断），
    // 备纤 c-a 与 ca 平行：环与平行结构均无桥，备纤自身也非桥
    const t2 = topology(true);
    const analyzer2 = new Analyzer(t2);
    // 该图 a-b 双平行、b-c(tail)、c-a(ca)：无桥
    expect(analyzer2.baseline.bridges).toHaveLength(0);
    const res = analyzer2.rehearseMaintenance('tail', 'c', 'a');
    expect(res.stillBridges).toHaveLength(0);
    expect(res.newBridges).toHaveLength(0);
    expect(res.temporaryIsBridge).toBe(false);
  });

  it('临时备纤自身可以是新的单点故障', () => {
    // 环 a-b-c-a ＋ 悬挂 c-d（cd 为桥）。摘除 cd 后 d 孤立，
    // 唯一能救回 d 的备纤必须落到 d；备纤 (d,a) 成为 d 的唯一新链路 ⇒ 备纤即桥。
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
    const res = analyzer.rehearseMaintenance('cd', 'd', 'a');
    expect(res.removedLink.id).toBe('cd');
    expect(res.stillBridges).toHaveLength(0);
    expect(res.newBridges).toHaveLength(0);
    // d 仅经临时备纤连入：它就是新单点故障
    expect(res.temporaryIsBridge).toBe(true);

    // 备纤平行于被摘除的 cd（d-c）同样是 d 的唯一链路：备纤为桥
    const res2 = analyzer.rehearseMaintenance('cd', 'd', 'c');
    expect(res2.temporaryIsBridge).toBe(true);
  });
});

describe('检修替换预演：原桥 / 非桥 / 替换后仍脆弱', () => {
  it('长链摘除中间桥：备纤就近跨越可恢复，未被覆盖的其余链边仍为桥', () => {
    // a-b-c-d-e 全为桥；摘除 c-d（L3），备纤 c-d 等价恢复
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c', 'd', 'e'],
        links: [
          { id: 'L1', u: 'a', v: 'b' },
          { id: 'L2', u: 'b', v: 'c' },
          { id: 'L3', u: 'c', v: 'd' },
          { id: 'L4', u: 'd', v: 'e' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    const res = analyzer.rehearseMaintenance('L3', 'c', 'd');
    expect(res.removedLink.status).toBe('removed');
    // L1/L2/L4 仍为桥；被摘除的 L3 不算“被备纤消除”，不出现在清单中
    expect(res.stillBridges.map((x) => x.id)).toEqual(['L1', 'L2', 'L4']);
    expect(res.newBridges).toHaveLength(0);
    expect(res.temporaryIsBridge).toBe(true); // 备纤补回的是原桥位置，仍是单点
  });

  it('非桥（环上边）摘除：其余边可能新成桥，备纤把网络接成更大环时无新桥', () => {
    // 三角形 a-b-c-a，摘除 ab；备纤 a-b（原样补一条）后仍为环，无桥
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
    const res = analyzer.rehearseMaintenance('ab', 'a', 'b');
    expect(res.stillBridges).toHaveLength(0);
    expect(res.newBridges).toHaveLength(0);
    expect(res.temporaryIsBridge).toBe(false);

    // 摘除 ab 后不备在原端点，而以 a-b 之外无法恢复：备纤 (a,c) 是 ca 的平行边，
    // 但 b 仅经 bc 连入 ⇒ bc 新成桥，临时备纤（a-c 平行于 ca）非桥
    const res2 = analyzer.rehearseMaintenance('ab', 'a', 'c');
    expect(res2.newBridges.map((x) => x.id)).toEqual(['bc']);
    expect(res2.temporaryIsBridge).toBe(false);
  });
});

describe('检修替换预演：内部临时编号不与导入编号碰撞', () => {
  it('即使导入链路含同样式编号，临时编号也自动避让', () => {
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: '检修临时备纤#0', u: 'a', v: 'b' },
          { id: '检修临时备纤#1', u: 'b', v: 'c' },
        ],
      }),
    );
    const analyzer = new Analyzer(t);
    // 摘除 #1（桥），备纤 b-c 恢复；临时编号不得是 #0 或 #1
    const res = analyzer.rehearseMaintenance('检修临时备纤#1', 'b', 'c');
    expect(res.temporaryLinkId).not.toBe('检修临时备纤#0');
    expect(res.temporaryLinkId).not.toBe('检修临时备纤#1');
    expect(t.links.some((l) => l.id === res.temporaryLinkId)).toBe(false);
  });

  it('默认临时编号不与普通导入编号碰撞', () => {
    const t = parseTopology(
      JSON.stringify({
        sites: ['a', 'b', 'c'],
        links: [
          { id: 'L1', u: 'a', v: 'b' },
          { id: 'L2', u: 'b', v: 'c' },
        ],
      }),
    );
    const res = new Analyzer(t).rehearseMaintenance('L2', 'b', 'c');
    expect(t.links.some((l) => l.id === res.temporaryLinkId)).toBe(false);
  });
});

describe('检修替换预演：无效输入只更新错误，且不产出结果', () => {
  const t = parseTopology(
    JSON.stringify({
      sites: ['a', 'b', 'c'],
      links: [
        { id: 'L1', u: 'a', v: 'b' },
        { id: 'L2', u: 'b', v: 'c' },
      ],
    }),
  );

  it('无效链路编号', () => {
    const analyzer = new Analyzer(t);
    expect(() => analyzer.rehearseMaintenance('ghost', 'a', 'c')).toThrow(/不在当前链路清单/);
    expect(() => analyzer.rehearseMaintenance('', 'a', 'c')).toThrow(/不能为空字符串/);
    expect(() => analyzer.rehearseMaintenance(null, 'a', 'c')).toThrow(/必须是非空字符串或整数链路编号/);
    expect(() => analyzer.rehearseMaintenance(true, 'a', 'c')).toThrow(/必须是非空字符串或整数链路编号/);
  });

  it('无效端点（不存在 / 相同 / 空 / 错类型）', () => {
    const analyzer = new Analyzer(t);
    expect(() => analyzer.rehearseMaintenance('L1', 'a', 'ghost')).toThrow(/不在当前站点清单/);
    expect(() => analyzer.rehearseMaintenance('L1', 'b', 'b')).toThrow(/必须不同/);
    expect(() => analyzer.rehearseMaintenance('L1', '', 'c')).toThrow(/不能为空字符串/);
    expect(() => analyzer.rehearseMaintenance('L1', 'a', null)).toThrow(/必须是已存在的站点编号/);
  });

  it('全空白站点编号逐字符寻址，不静默重定向', () => {
    const tws = parseTopology(
      JSON.stringify({
        sites: ['a', ' a ', 'b'],
        links: [
          { id: 'l1', u: 'a', v: ' a ' },
          { id: 'l2', u: ' a ', v: 'b' },
        ],
      }),
    );
    const analyzer = new Analyzer(tws);
    // 摘除 l2，备纤 ' a '-b 原样补回；引用带空白但不存在的 ' a' 必须精确失败
    const res = analyzer.rehearseMaintenance('l2', ' a ', 'b');
    expect(res.a).toBe(' a ');
    expect(() => analyzer.rehearseMaintenance('l2', ' a', 'b')).toThrow(/" a" 不在当前站点清单/);
  });
});

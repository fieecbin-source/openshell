/**
 * 会话分组树的纯函数工具：建树、扁平化、拖拽落点与稀疏排序值计算。
 *
 * 独立成纯函数是为了能单测「成环保护、层级展开、sort_order 耗尽重排」
 * 这类容易被 UI 掩盖的逻辑错误。
 */
import type { Group, Session } from "../types/ipc";

export interface GroupNode {
  group: Group;
  /** 子分组（已按 sort_order 排序） */
  children: GroupNode[];
  /** 直接归属该分组的会话（已按 sort_order 排序） */
  sessions: Session[];
  /** 该分组下所有后代分组的 id（用于禁止拖入自身子树） */
  descendantIds: string[];
}

export interface SessionTreeModel {
  roots: GroupNode[];
  /** 未分组会话 */
  ungrouped: Session[];
}

const bySortOrder = <T extends { sort_order?: number | null; name?: string }>(a: T, b: T) => {
  const sa = a.sort_order ?? 0;
  const sb = b.sort_order ?? 0;
  if (sa !== sb) return sa - sb;
  return (a.name ?? "").localeCompare(b.name ?? "");
};

/** 构建多级分组树。支持任意层级（后端限制 8 层），并容忍孤儿分组（父级已删除）。 */
export function buildGroupTree(groups: Group[], sessions: Session[]): SessionTreeModel {
  const byParent = new Map<string | null, Group[]>();
  for (const g of groups) {
    const key = g.parent_id ?? null;
    const list = byParent.get(key);
    if (list) list.push(g);
    else byParent.set(key, [g]);
  }

  const byGroup = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  for (const s of sessions) {
    if (s.group_id) {
      const list = byGroup.get(s.group_id);
      if (list) list.push(s);
      else byGroup.set(s.group_id, [s]);
    } else {
      ungrouped.push(s);
    }
  }

  const knownIds = new Set(groups.map((g) => g.id));

  const build = (parentId: string | null): GroupNode[] => {
    const children = (byParent.get(parentId) ?? []).slice().sort(bySortOrder);
    return children.map((group) => {
      const node: GroupNode = {
        group,
        children: [],
        sessions: (byGroup.get(group.id) ?? []).slice().sort(bySortOrder),
        descendantIds: [],
      };
      node.children = build(group.id);
      node.descendantIds = collectDescendants(node);
      return node;
    });
  };

  const roots = build(null);
  // 孤儿分组（parent_id 指向不存在的分组）挂到根节点，避免整组消失
  const orphans = groups
    .filter((g) => g.parent_id && !knownIds.has(g.parent_id))
    .sort(bySortOrder)
    .map<GroupNode>((group) => ({
      group,
      children: [],
      sessions: (byGroup.get(group.id) ?? []).slice().sort(bySortOrder),
      descendantIds: [],
    }));

  return { roots: [...roots, ...orphans], ungrouped: ungrouped.sort(bySortOrder) };
}

function collectDescendants(node: GroupNode): string[] {
  const ids: string[] = [];
  for (const child of node.children) {
    ids.push(child.group.id, ...child.descendantIds);
  }
  return ids;
}

/** 会话总数（含子分组），用于分组标题上的计数 */
export function countSessions(node: GroupNode): number {
  return node.sessions.length + node.children.reduce((sum, c) => sum + countSessions(c), 0);
}

/** 判断 `candidateParentId` 是否是 `groupId` 自身或其后代（拖拽时用于拒绝成环） */
export function wouldCreateCycle(
  model: SessionTreeModel,
  groupId: string,
  candidateParentId: string | null
): boolean {
  if (!candidateParentId) return false;
  if (candidateParentId === groupId) return true;
  const find = (nodes: GroupNode[]): GroupNode | null => {
    for (const node of nodes) {
      if (node.group.id === groupId) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return null;
  };
  const node = find(model.roots);
  return !!node && node.descendantIds.includes(candidateParentId);
}

/**
 * 计算把元素移动到目标列表 `index` 位置时的稀疏排序值。
 *
 * 采用「相邻两项取中值」的稀疏步进，避免每次拖拽都重写整张表；
 * 当间隙耗尽（差值 < 2）时返回 `null`，调用方应执行一次批量重排。
 */
export function sortOrderForIndex(sortedOrders: number[], index: number): number | null {
  const prev = index > 0 ? sortedOrders[index - 1] : undefined;
  const next = index < sortedOrders.length ? sortedOrders[index] : undefined;

  if (prev === undefined && next === undefined) return 1024;
  if (prev === undefined) return Math.max(1, Math.floor((next as number) / 2));
  if (next === undefined) return prev + 1024;

  const gap = next - prev;
  if (gap <= 1) return null; // 间隙耗尽，需要重排
  return prev + Math.floor(gap / 2);
}

/** 间隙耗尽时把整组顺序重排为 1024 步进 */
export function rebalanceOrders(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * 1024);
}

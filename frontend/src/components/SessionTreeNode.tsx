import React from "react";
import type { Group } from "../types/ipc";
import { type GroupNode, countSessions } from "../lib/groupTree";

export interface DragPayload {
  kind: "session" | "group";
  id: string;
}

export interface TreeApi {
  collapsed: Record<string, boolean>;
  toggle: (groupId: string) => void;
  beginDrag: (e: React.DragEvent, payload: DragPayload) => void;
  endDrag: () => void;
  hoverGroup: (groupId: string) => void;
  clearHover: () => void;
  dropOnGroup: (groupId: string | null) => void;
  openContextMenu: (e: React.MouseEvent, payload: { group?: Group }) => void;
  onNewSession: (groupId?: string) => void;
  onRenameGroup: (group: Group) => void;
  onDeleteGroup: (group: Group) => void;
  onCreateSubGroup: (group: Group) => void;
  renderSession: (session: import("../types/ipc").Session) => React.ReactNode;
  hoveredGroupId: string | null;
  draggingKind: DragPayload["kind"] | null;
}

interface SessionTreeNodeProps {
  node: GroupNode;
  depth: number;
  api: TreeApi;
}

/**
 * 递归分组节点：支持任意层级（后端限制 8 层）、折叠、拖拽移组与拖拽排序。
 *
 * 会话行的渲染交给 `api.renderSession`，保证根级与分组内的会话样式与交互完全一致。
 */
export const SessionTreeNode: React.FC<SessionTreeNodeProps> = ({ node, depth, api }) => {
  const { group, children, sessions } = node;
  const isCollapsed = !!api.collapsed[group.id];
  const isHovered = api.hoveredGroupId === group.id;
  // 拖拽进行中才显示可放置高亮
  const canDropOnGroup = api.draggingKind !== null;

  return (
    <div className="space-y-0.5">
      <div
        draggable
        onDragStart={(e) => api.beginDrag(e, { kind: "group", id: group.id })}
        onDragEnd={api.endDrag}
        onDragOver={(e) => {
          // 允许放置：阻止默认行为才会触发 drop
          e.preventDefault();
          e.stopPropagation();
          api.hoverGroup(group.id);
        }}
        onDragLeave={() => api.clearHover()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          api.dropOnGroup(group.id);
        }}
        onClick={() => api.toggle(group.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          api.openContextMenu(e, { group });
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`group flex items-center justify-between rounded-xl py-1.5 pr-2 text-xs font-semibold cursor-pointer select-none transition ${
          isHovered && canDropOnGroup
            ? "bg-action/10 ring-1 ring-accent/40 text-ink"
            : "text-ink-secondary hover:bg-line/5"
        }`}
        title={`${group.name}（可拖拽排序 / 移入其它分组）`}
      >
        <div className="flex min-w-0 items-center space-x-1.5">
          <span className="inline-block text-[10px] text-ink-tertiary transition-transform duration-150">
            {isCollapsed ? "▶" : "▼"}
          </span>
          <svg className="h-3.5 w-3.5 shrink-0 text-ink-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
            />
          </svg>
          <span className="truncate">{group.name}</span>
          <span className="text-[10px] font-normal text-ink-tertiary">({countSessions(node)})</span>
        </div>

        <div className="flex items-center space-x-1 opacity-0 transition group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.onNewSession(group.id);
            }}
            className="p-0.5 text-xs text-ink-secondary transition hover:text-accent"
            title="在此分组下新建会话"
          >
            +
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.onCreateSubGroup(group);
            }}
            className="p-0.5 text-[11px] text-ink-secondary transition hover:text-accent"
            title="新建子分组"
          >
            ⧉
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.onRenameGroup(group);
            }}
            className="p-0.5 text-[11px] text-ink-secondary transition hover:text-ink"
            title="重命名分组"
          >
            ✏️
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              api.onDeleteGroup(group);
            }}
            className="p-0.5 text-ink-secondary transition hover:text-state-danger"
            title="删除分组"
          >
            ✕
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <div
          className="ml-2.5 space-y-0.5 border-l border-line/15 pl-2"
          style={{ marginLeft: 10 + depth * 12 }}
        >
          {children.map((child) => (
            <SessionTreeNode key={child.group.id} node={child} depth={depth + 1} api={api} />
          ))}
          {sessions.map(api.renderSession)}
        </div>
      )}
    </div>
  );
};

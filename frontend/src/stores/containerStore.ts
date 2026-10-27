import { create } from "zustand";
import { sshExec } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: "running" | "exited" | "paused" | "restarting" | "dead";
  ports: string;
  created: string;
  composeProject?: string;
}

interface ContainerState {
  /** 当前探测所属的连接，切换标签页时用于判断是否需要重新探测 */
  connId: string | null;
  runtime: string;
  containers: DockerContainerInfo[];
  loading: boolean;
  error: string | null;
  /** 是否已经探测过（区别于「探测完但没有容器」） */
  probed: boolean;

  probe: (connId: string) => Promise<void>;
  reload: () => Promise<void>;
  /** 返回面向用户的提示文案 */
  action: (id: string, act: "start" | "stop" | "restart") => Promise<string>;
  reset: () => void;
}

/**
 * 容器数据源。
 *
 * 侧栏的「容器」列表和画布级的容器工作区共用同一份数据，
 * 避免两处各自探测导致状态不一致（也避免重复执行 docker ps）。
 */
export const useContainerStore = create<ContainerState>((set, get) => ({
  connId: null,
  runtime: "",
  containers: [],
  loading: false,
  error: null,
  probed: false,

  /**
   * 探测远端容器引擎。
   * docker/podman 可能不在非交互式 SSH 的 PATH 里（/snap/bin、/usr/local/bin），
   * 因此补上常见绝对路径兜底；只要有输出就认为可用，不依赖 exit_code
   * （SSH exec 通道可能丢失 exit-status）。
   */
  probe: async (connId) => {
    if (!connId) return;
    set({ loading: true, error: null, connId });
    try {
      const res = await sshExec(
        connId,
        "command -v docker 2>/dev/null || command -v podman 2>/dev/null || " +
          "ls -1 /usr/bin/docker /usr/local/bin/docker /snap/bin/docker /bin/docker " +
          "/usr/bin/podman /usr/local/bin/podman 2>/dev/null | head -n 1"
      );
      const runtime = (res.stdout || "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();

      if (!runtime) {
        set({ runtime: "", containers: [], probed: true, loading: false });
        return;
      }
      set({ runtime });
      await get().reload();
      set({ probed: true });
    } catch (e) {
      set({
        runtime: "",
        containers: [],
        error: formatFriendlyError(e),
        probed: true,
        loading: false,
      });
    }
  },

  reload: async () => {
    const { connId, runtime } = get();
    if (!connId || !runtime) {
      if (connId) await get().probe(connId);
      return;
    }
    set({ loading: true, error: null });
    try {
      const res = await sshExec(connId, `${runtime} ps -a --format '{{json .}}'`);
      const out = (res.stdout || "").trim();
      const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));

      // 以「能否解析出容器 JSON 行」为唯一成功标准；没有容器时 stdout/stderr 均为空
      if (lines.length === 0) {
        const stderrText = (res.stderr || "").trim();
        set({
          containers: [],
          error: stderrText || out ? formatFriendlyError(stderrText || out) : null,
          loading: false,
        });
        return;
      }

      const list: DockerContainerInfo[] = [];
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          const rawState = String(item.State || "").toLowerCase();
          const rawStatus = String(item.Status || "").toLowerCase();
          let state: DockerContainerInfo["state"] = "exited";
          if (rawState === "running" || rawState === "paused" || rawState === "restarting") {
            state = rawState;
          } else if (!rawState) {
            if (rawStatus.includes("up")) state = "running";
            else if (rawStatus.includes("pause")) state = "paused";
            else if (rawStatus.includes("restart")) state = "restarting";
          }

          const labels = String(item.Labels || "");
          const composeProject = /com\.docker\.compose\.project=([^,]+)/.exec(labels)?.[1];

          list.push({
            id: item.ID || item.Id || "",
            name: String(item.Names || item.Name || item.name || "").replace(/^\//, "") || "未命名容器",
            image: item.Image || item.image || "",
            status: item.Status || item.status || "",
            state,
            ports: item.Ports || item.ports || "",
            created: item.CreatedAt || item.RunningFor || "",
            composeProject,
          });
        } catch {
          // 单行解析失败不影响其它容器
        }
      }
      list.sort((a, b) => {
        if (a.state === b.state) return a.name.localeCompare(b.name);
        return a.state === "running" ? -1 : 1;
      });
      set({ containers: list, loading: false });
    } catch (e) {
      set({ containers: [], error: formatFriendlyError(e), loading: false });
    }
  },

  action: async (id, act) => {
    const { connId, runtime } = get();
    if (!connId || !runtime) return "容器引擎尚未就绪，请先刷新";
    const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "");
    try {
      const res = await sshExec(connId, `${runtime} ${act} ${safeId}`);
      const stderrText = (res.stderr || "").trim();
      const ok = res.exit_code === 0 || (res.exit_code === null && !stderrText);
      if (!ok) return formatFriendlyError(stderrText || "操作未成功");
      await get().reload();
      return `已${act === "start" ? "启动" : act === "stop" ? "停止" : "重启"}容器`;
    } catch (e) {
      return formatFriendlyError(e);
    }
  },

  reset: () => set({ connId: null, runtime: "", containers: [], error: null, probed: false }),
}));

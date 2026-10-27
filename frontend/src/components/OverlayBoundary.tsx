import { Component, type ErrorInfo, type ReactNode } from "react";
import { formatFriendlyError } from "../lib/errors";
import { toast } from "../stores/toastStore";

interface Props {
  /**
   * 变化时自动清除错误状态。
   * 传入「当前打开了哪些浮层」的组合键，用户关掉崩溃的弹窗再打开别的就能恢复。
   */
  resetKey: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * 浮层（弹窗 / 抽屉 / 侧栏）局部错误边界。
 *
 * 为什么需要它：根级 ErrorBoundary 一旦接住异常就会整棵 React 树卸载，
 * 常驻挂载的 xterm 实例随之 dispose，后端 PTY 通道关闭 —— 用户看到的表现
 * 就是「点了一个按钮，报错页弹出来，SSH 连接也断了」。
 * 把非关键的浮层隔离开后，某一次渲染异常只会让该浮层消失，终端会话维持在线。
 */
export class OverlayBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[overlay] render crashed, keeping terminal session alive:", error, info);
    toast.error(
      "该面板渲染出错，已暂停显示（终端连接未受影响）",
      `${formatFriendlyError(error)}\n${info.componentStack ?? ""}`
    );
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

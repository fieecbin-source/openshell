import React, { Component, ErrorInfo, ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Button } from "./components/ui/Button";
import { TriangleAlertIcon } from "./components/ui/icons";
import "./index.css";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen select-none flex-col items-center justify-center bg-canvas p-8 text-center">
          <div className="w-full max-w-[440px] rounded-os-xl border border-line/10 bg-surface p-6 shadow-os-lg">
            <TriangleAlertIcon className="mx-auto mb-3 h-7 w-7 text-state-danger" />
            <h2 className="text-os-md font-semibold tracking-[-0.01em] text-ink">界面加载遇到问题</h2>
            <p className="mt-2 text-os-xs leading-relaxed text-ink-secondary">
              客户端界面出现异常，请点击下方按钮重新加载。如果问题持续出现，请重启应用后再试。
            </p>
            <details className="mt-4 text-left">
              <summary className="cursor-pointer text-os-2xs text-ink-tertiary">
                查看错误详情（反馈问题时提供）
              </summary>
              <p className="mt-1.5 max-h-40 overflow-auto rounded-os-sm bg-surface-muted p-2.5 font-mono text-os-2xs text-ink-secondary">
                {this.state.error?.message || String(this.state.error)}
              </p>
            </details>
            <Button variant="primary" className="mt-5" onClick={() => window.location.reload()}>
              刷新重新加载
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

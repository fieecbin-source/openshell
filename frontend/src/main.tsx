import React, { Component, ErrorInfo, ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#f5f5f7] p-8 text-center select-none">
          <div className="max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-red-200">
            <span className="text-3xl mb-2 block">⚠️</span>
            <h2 className="text-base font-bold text-slate-900 mb-2">客户端界面初始化异常</h2>
            <p className="text-xs text-red-600 font-mono bg-red-50 p-2.5 rounded-lg mb-4 text-left overflow-auto max-h-40">
              {this.state.error?.message || String(this.state.error)}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="rounded-xl bg-apple-blue px-4 py-2 text-xs font-semibold text-white shadow-apple-md hover:bg-apple-hoverBlue transition"
            >
              刷新重新加载
            </button>
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

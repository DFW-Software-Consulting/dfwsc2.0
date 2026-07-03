import { Component } from "react";
import logger from "../utils/logger";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    logger.error("Uncaught error in component tree:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--bg-main)] text-[var(--text-main)] px-4">
          <div className="glass rounded-2xl p-8 max-w-md w-full text-center border border-[var(--glass-border)] bg-[var(--glass-bg)]">
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-sm opacity-75 mb-6">
              An unexpected error occurred. Please reload the page to continue.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="px-4 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-medium transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';

interface Props extends WithTranslation {
  /** Changing this value clears a caught error (route change / Retry). */
  resetKey?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Renderer error boundary: a throw inside a routed view used to blank the whole
 * window (React unmounts the tree). This keeps the shell (nav, pet, modals)
 * alive, shows a localized message, and offers Retry (remount the subtree) —
 * no reload, so in-flight state and the tray-resident window are preserved.
 *
 * Class component on purpose: React only supports error boundaries via
 * componentDidCatch / getDerivedStateFromError.
 */
class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The renderer has no logger bridge; console.error keeps the stack visible
    // in devtools and in the main-process console capture without inventing I/O.
    console.error('renderer view crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const { t } = this.props;
    return (
      <div role="alert" className="h-full grid place-items-center p-6">
        <div className="max-w-md border border-error p-5">
          <p className="text-textMain">{t('render_crash')}</p>
          <p className="mt-2 text-sm text-textMuted">{t('render_crash_hint')}</p>
          <p className="mt-2 text-xs text-textMuted break-all" dir="ltr">{error.message}</p>
          <button type="button" onClick={this.retry} className="mt-4 text-accent-neon">{t('retry')}</button>
        </div>
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryInner);

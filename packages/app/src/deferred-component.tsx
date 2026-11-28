import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import { Button } from "./components/ui/button";

class DeferredDownloadError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

class LoadingBoundary extends Component<
  {
    label: string;
    reloadOnRetry: boolean;
    onRetry: () => boolean;
    children: ReactNode;
  },
  { error: unknown }
> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(
      JSON.stringify({
        severity: "error",
        event: "feature.download_failed",
        feature: this.props.label,
        message: error.message,
      }),
    );
  }

  render() {
    if (this.state.error === null) return this.props.children;
    // A render error after editing must not become a reload action. Only an
    // import failure, before that surface mounts, belongs to this boundary.
    if (!(this.state.error instanceof DeferredDownloadError))
      throw this.state.error;
    return (
      <div
        role="alert"
        data-testid="feature-download-error"
        className="p-4 text-base"
      >
        <p>The {this.props.label} could not be downloaded.</p>
        <Button
          data-testid="feature-download-retry"
          className="mt-3 min-h-11"
          onClick={() => {
            if (this.props.onRetry()) this.setState({ error: null });
          }}
        >
          {this.props.reloadOnRetry ? "Reload page" : "Retry"}
        </Button>
      </div>
    );
  }
}

/** Download optional surfaces on demand, preserving the surrounding editor. */
export function deferredComponent<Props extends object>(
  load: (attempt: number) => Promise<{ default: ComponentType<Props> }>,
  label: string,
  reloadOnRetry = false,
) {
  let attempt = 0;
  const download = async (attempt: number) => {
    try {
      return await load(attempt);
    } catch (error) {
      throw new DeferredDownloadError(error);
    }
  };
  let shared = lazy(() => download(0));
  return function DeferredComponent(props: Props) {
    const [Loaded, setLoaded] = useState(() => shared);
    return (
      <LoadingBoundary
        label={label}
        reloadOnRetry={reloadOnRetry}
        onRetry={() => {
          // A failed route dependency is cached in the browser's module map.
          // The editor has not mounted yet; reload resets that complete map.
          // Optional source mode instead keeps the live document mounted.
          if (reloadOnRetry) {
            window.location.reload();
            return false;
          }
          const retry = ++attempt;
          shared = lazy(() => download(retry));
          setLoaded(() => shared);
          return true;
        }}
      >
        <Suspense
          fallback={
            <p role="status" className="p-4 text-base text-muted-foreground">
              Loading {label}…
            </p>
          }
        >
          <Loaded {...props} />
        </Suspense>
      </LoadingBoundary>
    );
  };
}

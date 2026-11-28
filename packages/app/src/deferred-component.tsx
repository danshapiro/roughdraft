import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useState,
} from "react";
import { Button } from "./components/ui/button";

class LoadingBoundary extends Component<
  { label: string; onRetry: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "feature.download_failed",
        feature: this.props.label,
        message: error.message,
      }),
    );
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="p-4 text-base">
        <p>The {this.props.label} could not be downloaded.</p>
        <Button
          className="mt-3 min-h-11"
          onClick={() => {
            this.props.onRetry();
            this.setState({ failed: false });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
}

/** Download optional surfaces on demand, preserving the surrounding editor. */
export function deferredComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  label: string,
) {
  let shared = lazy(load);
  return function DeferredComponent(props: Props) {
    const [Loaded, setLoaded] = useState(() => shared);
    return (
      <LoadingBoundary
        label={label}
        onRetry={() => {
          shared = lazy(load);
          setLoaded(() => shared);
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

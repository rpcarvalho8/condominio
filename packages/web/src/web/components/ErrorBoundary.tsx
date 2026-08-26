import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/Button";

type Props = {
  children: ReactNode;
  title?: string;
  onReset?: () => void;
};

type State = {
  error: Error | null;
};

/**
 * Isola falhas de renderização (ex.: objecto no JSX, parse JSON) para não
 * destruir a árvore React inteira (ecrã preto).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="rounded-lg border px-4 py-6 space-y-3"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <p className="text-sm font-semibold">
          {this.props.title ?? "Não foi possível carregar a visualização deste rascunho"}
        </p>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Ocorreu um erro ao mostrar o conteúdo. Pode tentar recarregar o rascunho sem sair da página.
        </p>
        <Button size="sm" variant="secondary" onClick={this.handleReset}>
          Recarregar Rascunho
        </Button>
      </div>
    );
  }
}

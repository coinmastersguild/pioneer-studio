import { Component, type ReactNode } from "react";

/** A browser without WebGL must still be able to author and assemble projects. */
export default class PreviewBoundary extends Component<{ children?: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="preview-unavailable" role="status">
        <strong>{this.props.label} unavailable</strong>
        <p>Your browser could not open this 3D preview. Projects, Media and Studio are still available.</p>
        <p>Check that graphics acceleration is enabled, or try another browser.</p>
        <button type="button" className="mini-btn" onClick={() => this.setState({ failed: false })}>Retry preview</button>
      </div>
    );
  }
}

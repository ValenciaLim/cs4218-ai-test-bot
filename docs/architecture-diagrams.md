# Architecture diagrams (export as images)

Copy any diagram into [Mermaid Live Editor](https://mermaid.live), then use **Actions → PNG** or **SVG** to download.

## CLI alternative (PNG/SVG on disk)

From repo root, after installing dev dependency `@mermaid-js/mermaid-cli` or using `npx`:

1. Save each diagram body (without the markdown fence) into `diagram1.mmd` and `diagram2.mmd`.
2. Run:

```bash
npx --yes @mermaid-js/mermaid-cli -i agent-architecture.md -o three-agents.png
npx --yes @mermaid-js/mermaid-cli -i autofix-orchestration.md -o autofix-orchestration.png
```

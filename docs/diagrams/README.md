# Architecture diagrams

The two diagrams in [`handoff/index.html`](../../handoff/index.html) are
generated, not hand-drawn. Source of truth is `src/`; the SVGs are build output
committed alongside it so the handoff guide stays self-contained.

| File | Diagram |
| --- | --- |
| `src/dataflow.mmd` | Vendor feeds → aggregator → ways to consume → your systems |
| `src/deployed.txt` | The Azure resources the deployment creates |

## Regenerating

Requires [DiagramForge](https://github.com/) and the .NET 10 SDK, invoked
through `dnx`:

```bash
node docs/diagrams/render.js
```

`render.js` renders both sources with `themes/aggregator-dark.json` — a palette
matched to the handoff page — then post-processes each SVG so it can be pasted
inline:

- every internal `id` is namespaced (`df-`, `dp-`) so two SVGs coexist in one
  document without their gradients and arrowheads colliding
- the fixed `width`/`height` are replaced with `width:100%;height:auto` so the
  figure scales with its container
- a `role="img"` and `aria-label` are added

Then paste the contents of `dataflow.svg` / `deployed.svg` into the matching
`<figure class="figure">` block in `handoff/index.html`.

## Constraints worth knowing

DiagramForge draws Mermaid subgraph boxes as rank bands, so **every node in a
subgraph must sit at the same rank** or the box will be drawn around the wrong
nodes. Keep zone diagrams as strict left-to-right pipeline stages: all nodes in
zone *n* fed only from zone *n-1*. Hierarchies are easier to express with the
conceptual `tree` DSL, which has no such constraint.

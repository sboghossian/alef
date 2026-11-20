Per-feature wire types go here, one file per feature: `shared/features/<feature-id>.ts`.
Export the feature's WS payload type, its snapshot-extras type, and any request/response
bodies. Never add feature types to `shared/types.ts`. See `docs/FEATURES.md`.

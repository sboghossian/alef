// The Town square's global workspace scorer (adapters, groupCandidates, salience, selectWorkspace,
// WORKSPACE) lives in shared/workspace/scorer.ts since vision wave 3 (gwt-broadcast), so the server
// (server/features/workspace.ts) scores its own sources with the very same code. This file keeps
// the client's import path; workspace-data.ts is the client's store around it.

export * from "../../../shared/workspace/scorer";

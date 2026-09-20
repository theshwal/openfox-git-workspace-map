# openfox-git-workspace-map

A full OpenFox Plugin API v2 extension for understanding and operating the Git topology behind a session without forking OpenFox.

## Architecture

The plugin is split into two typed layers:

- TypeScript backend in src/plugin.ts: OpenFox contributions, RPCs, Git observation and OpenFox REST mutations.
- React + TypeScript panel in src/ui.tsx: topology, branches, workspaces, remotes and project sessions.

Vite plus vite-plugin-singlefile compiles React into one sandbox-friendly dist/ui/git-workspace.html. tsup compiles the server entry to dist/server/plugin.js.

This matches the OpenFox GitHub installer: after cloning a plugin repository, OpenFox runs npm install and npm run build when a build script exists.

## Features

- Git badge on each session row in the sidebar;
- session-local Git Workspace Map action rendered above the composer;
- topology from Git common directory to workspace, branch/HEAD and tracking remote;
- branch, HEAD, dirty/clean, modified files, ahead/behind;
- fetch/push remote URLs;
- project workspace and session inventory;
- fetch all remotes or one remote;
- checkout an existing branch;
- create and checkout a new branch through the native OpenFox session endpoint;
- create/switch workspace with optional branch/source;
- delete workspace with conflict detection and explicit force confirmation;
- git_workspace_inspect agent tool.

## Safety model

Git CLI is used for observation and fetch only. Branch/workspace mutations go through OpenFox native REST endpoints so OpenFox remains the owner of session/workspace bookkeeping.

The plugin uses execFile, never a shell, bounds Git calls with timeouts, and validates remote names before passing them to Git.

## Build

    npm install
    npm run verify

The build produces:

- dist/server/plugin.js
- dist/server/plugin.d.ts
- dist/ui/git-workspace.html with React, CSS and JS inlined

## Install in OpenFox

Settings -> Plugins -> GitHub URL:

    https://github.com/theshwal/openfox-git-workspace-map

OpenFox clones the repository, installs dependencies, runs the build, then loads dist/server/plugin.js.

## Compatibility

- OpenFox Plugin API v2
- OpenFox >= 2.0.151
- Node.js >= 20
- React 19
- TypeScript 5.8
- Vite 6

## Verification

The pipeline runs strict TypeScript checking, backend contract tests, React panel tests, server/UI builds and artifact smoke checks.

## Migration from 1.0.0

1.0.0 loaded JavaScript directly and embedded its UI in handwritten HTML/DOM code.

1.1.0 moved source development to TypeScript + React while keeping OpenFox contribution IDs and RPC names stable.

1.2.0 scopes the UI to the active session without any OpenFox core patch: the action is rendered in `composer.actions`, the badge in `session.row.badges`, and the iframe reconstructs the active session from the embedding page before sending explicit `sessionId`, `workdir` and `projectId` with every RPC.

## License

MIT.

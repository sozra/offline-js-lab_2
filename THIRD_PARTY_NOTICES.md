# Third-party notices

Offline JS Lab directly depends on the following open-source components. Their
licenses apply to those components independently of this project's MIT License.

| Component | Pinned version | License |
|---|---:|---|
| Vue | 3.5.25 | MIT |
| Electron | 44.2.0 | MIT |
| electron-vite | 5.0.0 | MIT |
| Vite | 7.3.6 | MIT |
| `@vitejs/plugin-vue` | 6.0.2 | MIT |
| Monaco Editor | 0.56.0 | MIT |
| esbuild | 0.28.2 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| `@types/node` | 22.19.1 | MIT |
| vue-tsc | 3.3.11 | MIT |
| Vitest | 4.0.16 | MIT |
| electron-builder | 26.15.3 | MIT |

Packages installed by the user into the separate script workspace, such as
Lodash or Day.js, are not bundled as project dependencies and retain their own
licenses. The authoritative license text for every component is the `LICENSE`,
`LICENSE.md`, or equivalent file shipped in its npm package or source
distribution. Transitive dependencies pulled in by the toolchain also retain
their own licenses.

Before redistribution, generate a lockfile and software bill of materials from
the exact build environment and follow the relevant open-source review process.
This file is an engineering summary, not legal advice.

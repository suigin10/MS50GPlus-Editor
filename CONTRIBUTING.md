# Development

The application targets Windows x64 and the ZOOM MS-50G+. Use Node.js 24 and npm. Source files are in `src`; third-party helpers and their licenses are in `vendor`.

## Run and build

```sh
npm ci
npm test
npm run build
npm start
```

On Windows, `npm run package` produces `release/MS50GPlus-Editor-v<version>-win-x64`. Run the packaged executable from a writable folder. Set `MS50G_OUTPUT` to override the output directory.

## Tests

`npm test` bundles and runs the core tests against simulated MIDI responses. `npm run smoke` runs Electron UI tests with simulated pedal data, software rendering and the sandbox disabled for the test process only. Normal application launches enable the renderer sandbox and context isolation.

The smoke tests do not write to a real pedal. They may enumerate available MIDI ports. Hardware write tests should use disposable patches and an explicit backup.

Generated files, dependencies, runtime profiles, personal patches and release binaries are excluded by `.gitignore`.

## Changes

Keep Japanese and English UI strings and guides consistent. Preserve patch validation, model checks, readback verification and confirmation before overwriting a memory. Changes to MIDI commands should include focused tests for their framing and responses.

For bug reports, include the app version, pedal firmware, Windows version, steps to reproduce and the displayed error. Remove personal notes and paths before attaching files.

## Licenses

Original project code and documentation use the MIT License. Keep the copyright and license notices of third-party code intact. Do not add manufacturer firmware, effect binaries, manuals or audio assets to the repository.

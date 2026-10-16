# MS50GPlus-Editor

**Shape your MS-50G+ sound on your Windows desktop.**

[日本語](README.md) · [Download](https://github.com/suigin10/MS50GPlus-Editor/releases) · [User guide](docs/USAGE.en.md)

An unofficial patch editor for the ZOOM MS-50G+. Adjust your sound from the PC while listening through the pedal, and see pedal edits reflected in the app. A portable Windows x64 application with Japanese and English interfaces.

![MS50GPlus-Editor](docs/images/editor-ja.png)

## Features

- Two-way sync for parameters, effect ON/OFF, tempo and patch level
- A searchable list of all 100 patch memories, with wrapping previous/next controls
- Edit, replace and reorder up to six effects; rename patches
- A library of 129 official effects plus two utility modules, with installation status and post-release additions marked
- Estimated DSP load based on per-effect reference values
- PC project files, `.zptc` import/export and all-patch backups
- Reset to Empty, Undo/Redo and project notes

## Get started

1. Download the `win-x64.zip` from [Releases](https://github.com/suigin10/MS50GPlus-Editor/releases).
2. Extract the entire ZIP into a writable folder.
3. Run `MS50GPlus-Editor.exe`.

No separate Node.js, Python or browser installation is needed to run the app. Keep the executable with all included files. Recovery data and language preferences are stored in the `data` folder next to the executable.

Connect the pedal with a USB data cable, open **USB connection**, and select its MIDI input and output. The current pedal patch loads and two-way sync turns ON.

The pedal save destination is the number in **PATCH MEMORY**. Use the numbered button, such as **011 · Save**, to save there. **Save to PC** stores the patch and notes in a PC file. With the pedal's AUTO SAVE setting ON, adjustments are also saved automatically on the pedal.

See the [user guide](docs/USAGE.en.md) for the full workflow.

## Scope

- Windows x64 and MS-50G+. Pedal integration has been checked with firmware 1.40.
- Audio is processed by the pedal. This is not a standalone audio engine or a USB audio function.
- The DSP meter is an estimate from per-effect reference loads.
- Firmware updates, effect installation, the original MS-50G and other pedal models are outside this app's scope.

The application is unsigned. Back up patches you want to keep before editing.

## Development

Node.js 24 is recommended. Installing dependencies requires internet access.

```sh
npm ci
npm test
npm start
```

Run `npm run package` to create a Windows application folder. See [CONTRIBUTING.md](CONTRIBUTING.md) for build and test details.

## License and credits

[MIT License](LICENSE). Third-party copyright notices and licenses are listed in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) and the `vendor` directory.

- Thomas Hammer / [zoom-explorer](https://github.com/thammer/zoom-explorer): patch format, helpers and parameter mappings
- mungewell / [zoom-zt2](https://github.com/mungewell/zoom-zt2): DSP metadata conversion
- Reference application: [sym.bios.is](https://sym.bios.is/)

This project is not an official ZOOM CORPORATION product. Manufacturer firmware, effect executables, manuals and audio data are not included.

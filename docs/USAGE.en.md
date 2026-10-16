# User guide

[Back to README](../README.en.md) · [日本語](USAGE.ja.md)

## Connect

1. Connect the MS-50G+ using a USB data cable.
2. Open **USB connection** and select the pedal's MIDI input and output.
3. Click **Connect**. The current sound, installed effects and all 100 patch names load, and two-way sync turns ON.

Listen through an amplifier or audio interface connected to the pedal. Choose Japanese or English at the top right. The preference is retained for the next launch and does not change the pedal language.

## Edit a sound

Select a slot, then choose an effect from the library to add or replace it. Up to six effects can be used. Adjust sliders, lists or numeric controls, move or remove slots, and toggle effects ON/OFF.

With two-way sync ON, parameters, effect ON/OFF, tempo and level sync between PC and pedal. Changing the name, effect chain or order on the PC pauses sync; use **Apply to pedal** to send these edits. If you turned sync OFF manually, turn it back ON when needed.

Patch names support up to 28 ASCII characters. Project notes can contain other languages.

## Select a patch

Use ◀ / ▶ in **PATCH MEMORY**, or choose from the **Patch list**. The arrows wrap between 001 and 100. Search the list by number or name.

Selection changes the pedal patch and loads it into the PC editor. Use **Save to PC** before switching if you want to keep your PC edits.

## Save

| Action | Destination |
| --- | --- |
| Save to PC | Patch and notes in an `.ms50g.json` file |
| Export .zptc | Patch data without project notes |
| Apply to pedal | The current pedal patch |
| Numbered Save button, such as 011 · Save | Overwrites the memory shown in PATCH MEMORY |

Before saving on the pedal, check the destination number and its existing patch name in the confirmation dialog. With the pedal's AUTO SAVE setting ON, ordinary adjustments are also saved automatically. The app does not change that setting.

**Read memory**, under **Pedal patches and backup**, only selects the stored patch to open on the PC. It does not change the save destination.

## Reset to Empty

**Reset to Empty** resets the edited PC patch: name Empty, no effects, tempo 120, level 100 and no notes. Sync pauses and the PATCH MEMORY number is retained.

To store Empty on the pedal, click the numbered Save button after resetting. You can undo the reset on the PC.

## Back up and restore

Open **Pedal patches and backup**, then **Back up all 100 patches** to save a PC backup. If interrupted, the patches already read can be saved as a partial backup.

Restore one patch at a time:

1. Select its destination in PATCH MEMORY.
2. Use **Open** to load the backup file.
3. Choose a patch from the backup and click **Open selected patch**.
4. Click the numbered Save button to save it on the pedal.

## Library and DSP meter

Category counts show installed effects. **Added** marks official post-release additions. Effect installation is performed separately from this app.

The DSP meter estimates load by summing per-effect reference values, including bypassed slots. Effects without available data are shown as unknown. Use **Refresh DSP data** to read the reference values again.

Sync stops when the app detects a pedal DSP overflow indication or unavailable effect slots. Remove or replace effects and check the pedal status.

## Connection troubleshooting

Check the USB data cable, pedal power and MIDI port selection. Close other editors or DAWs using the same pedal, then scan the ports again.

## Shortcuts

Ctrl+S: Save to PC / Ctrl+O: Open / Ctrl+Z: Undo / Ctrl+Y: Redo

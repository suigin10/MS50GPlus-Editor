# MS50GPlus-Editor v0.7.3

MS-50G+の音づくりを、Windowsの画面で。

PCと本体の双方向同期、100パッチの一覧・検索、推定DSPバー、バックアップに対応した非公式エディターを公開しました。日本語／Englishを切り替えられ、インストール不要で使えます。

## ダウンロード・起動

`MS50GPlus-Editor-v0.7.3-win-x64.zip`をダウンロードし、ZIP全体を展開して`MS50GPlus-Editor.exe`を起動してください。Node.jsやPythonのインストールは不要です。

USBデータケーブルでMS-50G+を接続し、アプリの「USB接続」で本体を選ぶと、現在の音色を読み込み、双方向同期がONになります。本体への保存先はPATCH MEMORYの番号です。

対応はWindows x64／MS-50G+。本体連携はFW 1.40で確認しています。音声処理は本体で行い、DSPバーは負荷基準値からの推定値です。編集前に大切なパッチをバックアップしてください。

[使い方](https://github.com/suigin10/MS50GPlus-Editor/blob/main/docs/USAGE.ja.md) · [ソースコード](https://github.com/suigin10/MS50GPlus-Editor)

## English

Shape your MS-50G+ sound on your Windows desktop. This unofficial editor provides two-way MIDI sync, a searchable list of 100 patches, estimated DSP load and backups, with Japanese and English UI.

Download `MS50GPlus-Editor-v0.7.3-win-x64.zip`, extract the entire archive and run `MS50GPlus-Editor.exe`. No separate Node.js or Python installation is needed. Connect the pedal with a USB data cable and select it in **USB connection** to load its current patch and enable two-way sync.

For Windows x64 and MS-50G+. Pedal integration has been checked with firmware 1.40. Audio is processed by the pedal; the DSP meter uses reference estimates. Back up patches you want to keep before editing.

[User guide](https://github.com/suigin10/MS50GPlus-Editor/blob/main/docs/USAGE.en.md)

MIT License. This project is not affiliated with or endorsed by ZOOM CORPORATION.

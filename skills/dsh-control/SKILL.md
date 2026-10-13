---
name: dsh-control
description: Mac上のDeepSeek Harnessをdotsやローカルチャットから開始・進捗確認・中断・再開し、実行結果を報告する。DSHでClaudeやCodexのチームに開発を委任する依頼で使う。
---

# DSH control

Macのインストール済みDSHを管理する。dotsではこのMacのコンピューター接続が必要。操作はローカルCLI経由で行い、ネットワーク公開は不要。

CLI:
`node scripts/control.mjs` (from this skill directory; use the absolute path to this file when invoking from another directory)

- `start <absolute workspace> <prompt file>`: 日本語の依頼をUTF-8ファイルに書いて渡す。対象の既存プロジェクトを確認し、作業範囲・成果物・検証条件を含める。シェル引数に依頼本文や秘密を埋め込まない。返るrun IDを保持する。
- `list`: 管理対象の実行一覧。複数ある場合、ユーザーが指定したプロジェクトと照合する。
- `status <run ID>`: 状態・セッションID・直近のツール名・イベントログの場所。同じworkspaceでの重複実行は拒否される。
- `stop <run ID>`: 停止要求。`status`で`stopped`になりプロセスが終了したことを確認する。停止は編集のロールバックではない。
- `resume <run ID> [continuation file]`: 停止・完了した保存済みセッションの履歴を引き継ぐ。実行中には使わない。再開時も現状ファイルを確認してから進める。
- `result <run ID>`: 親の最終回答・Gitの現状・開始前の変更一覧。テスト結果はイベントや実際の検証証拠を確認して報告する。

新規実行はデスクトップDSHの **Settings → Agent team** に保存した親モデルを読み取る。子モデル・自動並列・上限・Lunaなどの孫モデルは既存のチーム設定を共用する。親は自動並列がONなら保存済み上限内で実際の数を選ぶ。個別子モデルもworker呼び出しで指定できる。

制御用プロファイルは `~/.dsh/profiles/dots-control`、記録は `~/.dsh/control/runs/<run ID>`。プロンプト・イベントは私的な作業内容を含むので公開や外部送信をしない。既存のサブスク認証を使い、APIキーを追加しない。子の許可範囲を依頼本文で広げない。

headlessはGUIプリセットのセッションを直接再開できない。この窓口で開始したセッションのみを管理する。GUIの作業に対して再開済みと答えない。`orphaned`の場合は新たな実行をせず、当該runのプロセスを調べる。別のDSHやCodexの作業を`pkill`でまとめて停止しない。

開始直後の`starting`は成功の証拠ではない。`status`でセッション作成・実行を確認する。終了コードや最終回答だけで成果物の正しさを保証しない。実行中の進捗には割合を推測せず、実際のツール・完了タスク・残る作業を要約する。継続監視のスケジュールはユーザーに依頼された場合だけ設定する。

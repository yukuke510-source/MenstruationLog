# MenstruationLog

# Notion Period Automation v5.2

無料スタック：**Notion + GitHub Actions + Zapier (Free)**

## 機能
- **開始**：周期・平均周期（全履歴）／次回生理予定＝開始+平均（平均0なら28）／排卵予定＝次回−LUTEAL(14既定)。開始の生理系は常に0。
- **終了**：生理日数（開始→終了+1）・平均生理日数（全履歴）を終了に記入。終了の次回/排卵は常に空欄。
- **予定レコード**：`CREATE_PLAN_PAGES=true` で開始時のみ「生理予定」「排卵予定」を2行新規作成（履歴保持）。
- **日次記録**：タイトルは作成時刻（JST）から **朝/昼/夜** を自動付与（開始/終了は通番なし）。
- **厳密ペアリング**：2ポインタで [開始i, 次開始) の**最初の終了**のみ対応。各終了は一度だけ。
- **インクリメンタル再計算**：最終計算以降の編集範囲だけ、直前の開始へ1件巻き戻して再計算。
- **テンプレ遵守**：開始/終了=person作成、予定=bot作成。不一致は「テンプレ不一致」。`STRICT_TEMPLATES=true` で計算から除外。
- **メトリクス**：最新かつ非ゼロのみ各1件をフラグ（`最新_***`）でGalleryに表示。
- **デバウンス**：状態ページに直近トリガ時刻を保持し、`MIN_TRIGGER_INTERVAL_SEC` 未満の連投はスキップ。

## セットアップ
1. **Notion Integration** を作成 → DBを **Share → Connect to** で接続 → `NOTION_DATABASE_ID` を取得
2. GitHub リポに本ファイル群を配置
3. **Secrets**: `NOTION_TOKEN`, `NOTION_DATABASE_ID`
4. **Variables**:  
   - `LUTEAL_DAYS=14`, `CREATE_PLAN_PAGES=true|false`  
   - `MIN_TRIGGER_INTERVAL_SEC=45`, `STRICT_TEMPLATES=false`  
   - `MORNING_END_HOUR=10`, `AFTERNOON_END_HOUR=16`（任意）
5. Zapier を2本（開始/終了）  
   - Trigger: Notion Database Item Updated（Filter: 種別=開始 / 終了）  
   - Delay After Queue: 30–60秒（Queue Key=レコードID）  
   - Action: Webhooks → POST `https://api.github.com/repos/<owner>/<repo>/dispatches`  
     - Body: `{"event_type":"notion-update","client_payload":{"reason":"start-updated"}}`  
       or `{"event_type":"notion-update","client_payload":{"reason":"end-updated"}}`

## 実行
- 手動: Actions → Run workflow
- 毎日: JST 0:00 に自動
- Notion 更新: Zapier から `repository_dispatch` → 即時計算

## つまずきやすい点
- DBを Integration に**接続し忘れ** → 403/権限エラー
- 列の**型間違い**（Number/Date/Select/Checkbox） → 書き込み失敗
- 同日・同種別の重複や順序異常 → `入力エラー` がON
- テンプレ外での作成 → `テンプレ不一致` がON（`STRICT_TEMPLATES=true` で除外）

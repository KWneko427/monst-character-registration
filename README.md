# モンスト共有キャラ図鑑

GitHub Pagesの登録・編集・削除をSupabaseに保存し、利用者間で共有します。

- character-register.html: 登録・編集
- character-list.html: 一覧・検索。15秒ごとに共有データを更新
- 通信失敗時は端末内に未送信データを保存し、再接続時に送信
- 同じ項目の同時編集は競合として表示し、上書きを防止
- 公開図鑑のため、閲覧者は共有データを編集できます

2026-11-11にローカルJSONの409体を移行し、全内容を照合済み。
設定には公開用publishableキーのみを使用。DBパスワードやsecretキーは含めません。
初回接続前の端末データはlocalStorageのbefore-supabaseキーに退避します。

# ハイパーロボット オンライン

## 起動
    npm install
    npm start      # http://localhost:3000

同じネットワークのスマホからは http://<PCのIP>:3000 で入れます。
インターネット越しに遊ぶ場合は Render / Railway / Fly.io などの Node.js ホスティングに
このフォルダをそのままデプロイしてください (Start Command: `npm start`、WebSocket 対応が必要)。

## 設定 (server.js 冒頭)
- RESET_ON_SUCCESS: true=成功後もロボットを元の位置に戻す / false=動かした位置のまま次ラウンド
- COUNTDOWN_MS: 宣言後タイマー(60秒) / EXEC_MS: 1人の手番の持ち時間(90秒)

/* 初始資料：第一次開啟、還沒有 data.json 時用一次。每個功能留一張說明卡，看懂就可以刪掉。
 * 之後所有資料都存在 data.json，這個檔案不會再被讀來覆蓋。
 * 想整個重來：關掉看板，刪掉 data.json（Windows 版在 data 資料夾裡），再打開。
 */
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date(), Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  const day = (n) => { const d = new Date(Y, M, D + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const ago = (min) => now.getTime() - min * 60000;
  const mon = -((now.getDay() + 6) % 7);           // 這週一

  window.KOS_SEED = {
    brand: '',

    domains: [
      { code: 'A', name: '範例領域', desc: '專案的大分類（工作、學習、家庭…）。在專案視窗的「領域」選單新增或刪除。' }
    ],

    projects: [
      { id: 'p1', code: 'A01', name: '範例專案：點卡片打開', domain: 'A', status: '執行中', confirm: '已確認', focus: true, due: day(7),
        next: '下一個具體動作，會顯示在 01 本週執行看板',
        block: '卡在哪裡、在等誰',
        result: '這週做出了什麼',
        done: '做到什麼程度算完成。在 08 專案看板拖卡片改狀態，拖到「已結案」入帳專案獎勵；卡片上的「重點」設為本週重點（最多 3 個）。',
        verify: '怎麼驗收' },
      { id: 'p2', name: '新想法先丟收件匣，每週復盤再分類', status: '收件匣' }
    ],

    tasks: [
      { id: 't1', p: 'p1', type: '里程碑', name: '里程碑：專案的大階段，全部完成進度條就滿', sched: day(2) },
      { id: 't2', p: 'p1', type: '行動', status: '等待中', wait: '對方回覆', name: '等待中：卡在別人的事，任務狀態選「等待中」' },
      { id: 't3', p: 'p1', type: '待確認', name: '待確認：還沒決定的問題，想清楚就打勾' },
      { id: 't4', cat: 'c1', pri: 2, sched: day(0), name: '點任務名稱看詳情',
        note: '左邊方框打勾＝完成，入帳每日任務獎勵；右邊 ▶ 開始專注。\n詳情裡可以改日期、類別、優先級、加子任務，「移動到／複製到」別天。\n類別旁的「＋」新增任務，可以先選優先級 — ! !! !!!。',
        subs: [{ id: 'q1', name: '子任務：打勾完成', done: false }, { id: 'q2', name: '點類別名稱可以收起來', done: false }] },
      { id: 't5', cat: 'c1', sched: day(0), status: '完成', doneAt: ago(5), name: '完成的任務會留在 07 印記' },
      { id: 't6', name: '沒排日期的任務放在「無日期」，按「→ 今天」排進選的那天' }
    ],

    cats: [{ id: 'c1', name: '範例類別' }],

    habits: [{ id: 'h1', name: '範例習慣：點今天的格子打卡', log: { [day(-1)]: 1 } }],

    focus: [{ id: 'f1', at: ago(35), end: ago(10), min: 25, note: '範例專注：番茄鐘 25 分鐘', tid: '', hid: '', pid: '', pct: 1 }],

    reviews: [
      { id: 'r1', name: '每週復盤｜範例', start: day(mon), end: day(mon + 6),
        result: '具體完成的成果', exec: '上面的分析是「開始～結束」這段時間自動算的', stuck: '卡在哪一步',
        adjust: '下週怎麼調整。按「完成復盤」入帳復盤獎勵' }
    ],

    shop: [
      { id: 's1', name: '範例商品', price: 100, qty: null, img: '', px: 32, link: '', at: now.getTime(),
        note: '按「＋上架」放你想買的東西，拍照會自動變成像素圖。完成任務、習慣、專注、routine 都會賺錢，錢夠了按「購買」。「鎖定目標」會在錢包旁邊顯示進度。' }
    ],
    buys: [],
    goal: 's1',

    routines: {
      am: ['範例：09:00 前全部勾完有獎勵，按「編輯清單」換成你的'],
      pm: ['範例：隔天 01:00 前全部勾完有獎勵，按「編輯清單」換成你的']
    }
  };

  /* routine 的「恢復預設」用這份 */
  window.KOS_ROUTINES = {
    am: [
      '喝一杯水 500ml',
      '盥洗、整理床鋪',
      '伸展 5 分鐘',
      '看今日行事曆與天氣',
      '看「本週執行看板」，選出今天最重要的 1 件事',
      '昨晚想到的事丟進收件匣'
    ],
    pm: [
      '更新今天動過的任務狀態與進度',
      '新想法丟進收件匣（不分類）',
      '寫下明天最重要的 1 件事',
      '整理桌面、關掉不用的分頁',
      '準備明天要帶的東西',
      '手機放遠，準備睡覺'
    ]
  };
})();

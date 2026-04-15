const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error('請設定環境變數 LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
};

async function main() {
  // 1. 建立 Rich Menu
  const richMenu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: '小瀾選單',
    chatBarText: '功能選單',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 625, height: 843 },
        action: { type: 'message', text: '今天先做什麼' },
      },
      {
        bounds: { x: 625, y: 0, width: 625, height: 843 },
        action: { type: 'message', text: '待修bug清單' },
      },
      {
        bounds: { x: 1250, y: 0, width: 625, height: 843 },
        action: { type: 'message', text: '有哪些待付款' },
      },
      {
        bounds: { x: 1875, y: 0, width: 625, height: 843 },
        action: { type: 'uri', uri: 'https://liff.line.me/2009806013-ON2KtCsF' },
      },
    ],
  };

  console.log('建立 Rich Menu...');
  const createRes = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers,
    body: JSON.stringify(richMenu),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error('建立失敗:', err);
    process.exit(1);
  }

  const { richMenuId } = await createRes.json();
  console.log('Rich Menu ID:', richMenuId);

  // 2. 上傳圖片（生成簡單的文字圖片）
  const { createCanvas } = await import('canvas').catch(() => null) || {};

  if (createCanvas) {
    const canvas = createCanvas(2500, 843);
    const ctx = canvas.getContext('2d');

    // 背景
    ctx.fillStyle = '#9b6dff';
    ctx.fillRect(0, 0, 2500, 843);

    // 分隔線
    ctx.strokeStyle = '#ffffff30';
    ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(625 * i, 100);
      ctx.lineTo(625 * i, 743);
      ctx.stroke();
    }

    // 文字
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labels = [
      { icon: '📋', text: '今日待辦' },
      { icon: '🐛', text: 'Bug清單' },
      { icon: '💰', text: '付款提醒' },
      { icon: '📊', text: '儀表板' },
    ];

    labels.forEach((label, i) => {
      const cx = 625 * i + 312;
      ctx.font = '80px sans-serif';
      ctx.fillText(label.icon, cx, 340);
      ctx.font = 'bold 48px sans-serif';
      ctx.fillText(label.text, cx, 500);
    });

    const imgBuffer = canvas.toBuffer('image/png');

    console.log('上傳圖片...');
    const imgRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'image/png',
      },
      body: imgBuffer,
    });

    if (!imgRes.ok) {
      console.warn('圖片上傳失敗（需要手動上傳）:', await imgRes.text());
    } else {
      console.log('圖片上傳成功');
    }
  } else {
    console.log('⚠️ 沒有 canvas 套件，請手動上傳 Rich Menu 圖片');
    console.log(`上傳 API: POST https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`);
  }

  // 3. 設為預設選單
  console.log('設為預設選單...');
  const defaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers,
  });

  if (!defaultRes.ok) {
    console.error('設定預設失敗:', await defaultRes.text());
  } else {
    console.log('✅ Rich Menu 設定完成！');
  }
}

main().catch(console.error);

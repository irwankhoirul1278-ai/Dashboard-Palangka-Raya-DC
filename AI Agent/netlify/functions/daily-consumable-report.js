/**
 * netlify/functions/daily-consumable-report.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan SEKALI SEHARI, jam 08:00 WIB = 01:00 UTC —
 * jadwal di netlify.toml). Kirim full listing Stock Consumable (bukan
 * cuma yang menipis) ke grup SeaTalk, biar tim liat kondisi Consumable
 * tiap pagi tanpa nunggu ditanya atau nunggu ada yang nyampe minStock.
 *
 * Beda sama check-low-stock.js: itu cuma alert kalau ada yang BARU
 * menipis (jalan tiap 15 menit, semua kategori). Ini report rutin
 * harian, khusus kategori Consumable, isinya full daftar.
 */

const { getStockItems, formatConsumableReport, getSeatalkAccessToken, sendSeatalkGroupMessage } = require("./_seatalk-common");

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  try {
    const items = await getStockItems();
    const text = formatConsumableReport(items);
    const token = await getSeatalkAccessToken();
    await sendSeatalkGroupMessage(token, groupId, text);
    return { statusCode: 200, body: "consumable report terkirim" };
  } catch (err) {
    console.error("Gagal kirim Daily Consumable Report:", err);
    return { statusCode: 500, body: "gagal kirim consumable report" };
  }
};

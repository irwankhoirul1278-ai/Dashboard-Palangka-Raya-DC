/**
 * netlify/functions/check-aging-report.js
 * ------------------------------------------------------------------
 * Scheduled Function (jalan tiap 1 JAM, jadwal di netlify.toml).
 * Kirim report Aging Days Outbound Monitoring ke grup SeaTalk: breakdown
 * per bucket (D-Day, D-1..D-5, D-6+) dan per Hub, qty = jumlah parcel.
 *
 * BUKAN alert threshold - ini report rutin, jadi tetep dikirim tiap jam
 * selama ada data import Outbound (gak dedup/cek perubahan). Kalau belum
 * ada data sama sekali (belum pernah import), gak kirim apa-apa.
 */

const { getOutboundRows, formatAgingReport, getSeatalkAccessToken, sendSeatalkGroupMessage } = require("./_seatalk-common");

exports.handler = async () => {
  const groupId = process.env.SEATALK_TARGET_GROUP_ID;
  try {
    const rows = await getOutboundRows();
    const text = formatAgingReport(rows);
    if (!text) {
      return { statusCode: 200, body: "belum ada data import Outbound" };
    }
    const token = await getSeatalkAccessToken();
    await sendSeatalkGroupMessage(token, groupId, text);
    return { statusCode: 200, body: "aging report terkirim" };
  } catch (err) {
    console.error("Gagal kirim Aging Report:", err);
    return { statusCode: 500, body: "gagal kirim aging report" };
  }
};
